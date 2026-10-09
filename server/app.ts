import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { readStats, type DB } from './db';
import { HttpError, instanceId } from './core';
import { registerAuth } from './auth';
import { registerRoutes } from './routes';
import { RealtimeHub } from './realtime';
import { AgentRuntime } from './agents/runtime';

export async function buildApp(
  db: DB,
  options: { worker?: boolean; logger?: boolean; origin?: string } = {},
) {
  const origin = options.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:5173';
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://'))
    throw new Error('Production APP_ORIGIN must use HTTPS.');
  const app = Fastify({
    logger: options.logger ?? true,
    // Behind the load balancer, client IPs (rate limits, audit) come from X-Forwarded-For.
    trustProxy: ['1', 'true'].includes(String(process.env.TRUST_PROXY)),
    bodyLimit: 512000,
    requestTimeout: 15000,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  // Keyed by IP so forged cookies cannot mint fresh buckets. Requests carrying a session get a
  // higher ceiling: a whole team behind one office IP shares this bucket during live collaboration.
  // Login and registration keep their own strict per-route limits.
  await app.register(rateLimit, {
    timeWindow: '1 minute',
    // Per-client limits per minute. Load tests raise them through the environment; defaults are unchanged.
    max: (request) =>
      request.cookies?.agentspace_session
        ? Number(process.env.RATE_LIMIT_SESSION_PER_MINUTE) || 1500
        : Number(process.env.RATE_LIMIT_ANONYMOUS_PER_MINUTE) || 300,
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  registerAuth(app, db, origin);
  const hub = new RealtimeHub(instanceId);
  if (process.env.REDIS_URL) await hub.enableFanout(process.env.REDIS_URL);
  hub.register(app, db, origin);
  registerRoutes(app, db, hub, origin);
  const runtime = new AgentRuntime(
    db,
    (id) => hub.broadcast(id),
    (e) => app.log.error(e),
  );
  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    // Instance name and read routing help when testing a cluster; production health stays minimal.
    return process.env.NODE_ENV === 'production'
      ? { status: 'ok', service: 'agentspace' }
      : { status: 'ok', service: 'agentspace', instance: instanceId, reads: readStats };
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'Invalid request.',
        details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ error: error.message });
    const code = (error as any).code;
    if (code === '23505')
      return reply
        .code(409)
        .send({ error: 'This record already exists or another operation is in progress.' });
    if (code === '23503')
      return reply.code(400).send({ error: 'A referenced record no longer exists.' });
    if ((error as any).statusCode && (error as any).statusCode < 500)
      return reply.code((error as any).statusCode).send({ error: (error as Error).message });
    // Do not log SQL parameter values, cookies, credentials, or project content.
    app.log.error(
      { requestId: request.id, errorType: (error as Error).name, code },
      'Request failed',
    );
    return reply.code(500).send({ error: 'An unexpected error occurred.', requestId: request.id });
  });
  const dist = resolve('dist');
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Endpoint not found.' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    hub.close();
    await runtime.stop();
  });
  await app.ready();
  // With several instances only one runs the agent worker (AGENT_WORKER=off on the others).
  if (options.worker !== false && process.env.AGENT_WORKER !== 'off') await runtime.start();
  return { app, runtime, hub };
}
