import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as oidc from 'openid-client';
import type { DB } from './db';
import {
  hash,
  HttpError,
  originAllowed,
  passwordHash,
  passwordMatches,
  token,
  uid,
  type Actor,
} from './core';
declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
    sessionHash: string;
  }
}
const livePath = /^\/api\/projects\/[^/?]+\/live\?/;
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(200),
});
export function registerAuth(app: FastifyInstance, db: DB, origin: string) {
  const secure = process.env.NODE_ENV === 'production';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  const flows = new Map<string, { verifier: string; nonce: string; expires: number }>();
  // Single-use live-connection tickets, keyed by hash, bound to the issuing session.
  const tickets = new Map<string, { sessionHash: string; expires: number }>();
  // Set when the frontend is served from another origin than the API (e.g. Vercel + Render).
  const liveOrigin = process.env.LIVE_ORIGIN?.replace(/\/$/, '') || null;
  let oidcConfig: Promise<oidc.Configuration> | undefined;
  const configured = Boolean(
    process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET,
  );
  const configuration = () =>
    (oidcConfig ??= oidc.discovery(
      new URL(process.env.OIDC_ISSUER!),
      process.env.OIDC_CLIENT_ID!,
      process.env.OIDC_CLIENT_SECRET!,
    ));
  async function session(reply: FastifyReply, user: Actor) {
    const value = token();
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [hash(value), user.id],
    );
    reply.setCookie('agentspace_session', value, { ...cookieOptions, maxAge: 604800 });
    return { user };
  }
  app.decorateRequest('actor');
  app.decorateRequest('sessionHash', '');
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    // Require a same-origin custom header for every mutation (including login) to block CSRF.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (
        request.headers['x-agentspace-request'] !== '1' ||
        (request.headers.origin && !originAllowed(request.headers.origin, origin))
      )
        throw new HttpError(403, 'Cross-origin request rejected.');
    }
    if (request.url.startsWith('/api/auth/') || request.url === '/api/health') return;
    let sessionHash: string;
    const ticket = (request.query as { ticket?: unknown } | undefined)?.ticket;
    if (typeof ticket === 'string' && livePath.test(request.url)) {
      const key = hash(ticket),
        entry = tickets.get(key);
      tickets.delete(key);
      if (!entry || entry.expires < Date.now())
        throw new HttpError(401, 'Live connection ticket expired.');
      sessionHash = entry.sessionHash;
    } else {
      const value = request.cookies.agentspace_session;
      if (!value) throw new HttpError(401, 'Sign in to continue.');
      sessionHash = hash(value);
    }
    const [user] = await db.query<Actor>(
      'SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [sessionHash],
    );
    if (!user) {
      reply.clearCookie('agentspace_session', { path: '/' });
      throw new HttpError(401, 'Your session expired. Sign in again.');
    }
    request.actor = user;
    request.sessionHash = sessionHash;
  });
  app.get('/api/auth/config', async () => ({ oidc: configured, liveOrigin }));
  // A cross-origin frontend cannot attach the session cookie to a WebSocket upgrade on the API
  // origin. It fetches this short-lived, single-use ticket (same-origin via its proxy) instead.
  app.post('/api/live-ticket', async (request) => {
    const now = Date.now();
    for (const [key, entry] of tickets) if (entry.expires < now) tickets.delete(key);
    if (tickets.size > 10000) throw new HttpError(429, 'Too many pending live connections.');
    const value = token();
    tickets.set(hash(value), { sessionHash: request.sessionHash, expires: now + 30000 });
    return { ticket: value };
  });
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const data = credentials
        .extend({ name: z.string().trim().min(1).max(80) })
        .parse(request.body);
      if ((await db.query('SELECT id FROM users WHERE email=$1', [data.email])).length)
        throw new HttpError(409, 'An account with this email already exists.');
      const user = { id: uid(), email: data.email, name: data.name };
      await db.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
        user.id,
        user.email,
        user.name,
        await passwordHash(data.password),
      ]);
      return session(reply, user);
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const data = credentials.parse(request.body);
      const [user] = await db.query('SELECT * FROM users WHERE email=$1', [data.email]);
      // Perform equivalent password work even for an unknown account.
      const matches = await passwordMatches(
        data.password,
        user?.password_hash ?? `${'0'.repeat(43)}:${'0'.repeat(128)}`,
      );
      if (!user || !matches) throw new HttpError(401, 'Email or password is incorrect.');
      if (request.cookies.agentspace_session)
        await db.query('DELETE FROM sessions WHERE token_hash=$1', [
          hash(request.cookies.agentspace_session),
        ]);
      return session(reply, { id: user.id, name: user.name, email: user.email });
    },
  );
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.cookies.agentspace_session)
      await db.query('DELETE FROM sessions WHERE token_hash=$1', [
        hash(request.cookies.agentspace_session),
      ]);
    reply.clearCookie('agentspace_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (request) => ({ user: request.actor }));
  app.get(
    '/api/auth/oidc/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      if (!configured) throw new HttpError(503, 'OIDC is not configured.');
      for (const [key, flow] of flows) if (flow.expires < Date.now()) flows.delete(key);
      if (flows.size > 1000) throw new HttpError(429, 'Too many pending sign-ins.');
      const config = await configuration(),
        state = token(),
        verifier = oidc.randomPKCECodeVerifier(),
        nonce = oidc.randomNonce();
      flows.set(hash(state), { verifier, nonce, expires: Date.now() + 600000 });
      reply.setCookie('agentspace_oidc', state, { ...cookieOptions, maxAge: 600 });
      return reply.redirect(
        oidc.buildAuthorizationUrl(config, {
          redirect_uri: `${origin}/api/auth/oidc/callback`,
          scope: 'openid email profile',
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: 'S256',
        }).href,
      );
    },
  );
  app.get('/api/auth/oidc/callback', async (request, reply) => {
    const state = request.cookies.agentspace_oidc,
      flow = state ? flows.get(hash(state)) : undefined;
    reply.clearCookie('agentspace_oidc', { path: '/' });
    if (!configured || !state || !flow || flow.expires < Date.now())
      throw new HttpError(400, 'Sign-in expired. Please try again.');
    flows.delete(hash(state));
    const tokens = await oidc.authorizationCodeGrant(
      await configuration(),
      new URL(request.url, origin),
      {
        pkceCodeVerifier: flow.verifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (!claims?.sub || claims.email_verified !== true || typeof claims.email !== 'string')
      throw new HttpError(403, 'The identity provider must return a verified email address.');
    const subject = `${claims.iss}|${claims.sub}`,
      email = claims.email.toLowerCase();
    let [user] = await db.query<Actor>('SELECT id,name,email FROM users WHERE oidc_subject=$1', [
      subject,
    ]);
    if (!user) {
      if ((await db.query('SELECT id FROM users WHERE email=$1', [email])).length)
        throw new HttpError(
          409,
          'This email already has a local account. Automatic identity linking is disabled.',
        );
      user = {
        id: uid(),
        name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : email,
        email,
      };
      await db.query('INSERT INTO users(id,email,name,oidc_subject) VALUES($1,$2,$3,$4)', [
        user.id,
        user.email,
        user.name,
        subject,
      ]);
    }
    await session(reply, user);
    return reply.redirect('/');
  });
}
