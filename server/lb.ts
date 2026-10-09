// Layer-7 load balancer for several AgentSpace API instances.
//   BACKENDS=http://127.0.0.1:3301,http://127.0.0.1:3302 LB_PORT=3200 tsx server/lb.ts
// - least-connections routing across healthy backends (ties broken round-robin), tracked per LB worker
// - active health checks on /api/health every LB_HEALTH_MS (default 2000 ms); 3 consecutive failures mark a
//   backend down. A busy backend answers slowly, so the check waits up to 5 s, and when every backend is
//   marked down the balancer fails open to the least-loaded one instead of rejecting all traffic
// - idempotent requests (GET/HEAD) are retried once on another backend when the connection fails
// - WebSocket upgrades (/api/projects/:id/live) are proxied; realtime fan-out across instances is done by Redis
// - X-Forwarded-For/-Proto/-Host are set; run the API with TRUST_PROXY=true behind it
// Production deployments can use nginx instead (deploy/nginx.conf) with the same backend contract.
import cluster from 'node:cluster';
import http from 'node:http';
import net from 'node:net';

// LB_WORKERS processes share the listening port so the balancer itself is not a single-core bottleneck.
const workers = Math.max(1, Number(process.env.LB_WORKERS) || 1);
cluster.schedulingPolicy = cluster.SCHED_RR;
if (cluster.isPrimary && workers > 1) {
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (_w, code) => code !== 0 && cluster.fork());
  console.log(`Load balancer primary: ${workers} workers`);
} else {
  start();
}

function start() {
  interface Backend {
    url: URL;
    active: number;
    healthy: boolean;
    failures: number;
    served: number;
  }
  const backends: Backend[] = (process.env.BACKENDS ?? 'http://127.0.0.1:3301')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ url: new URL(s), active: 0, healthy: true, failures: 0, served: 0 }));
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: Number(process.env.LB_MAX_SOCKETS) || 256,
  });
  let turn = 0;

  function pick(exclude?: Backend) {
    let up = backends.filter((b) => b.healthy && b !== exclude);
    if (!up.length) up = backends.filter((b) => b !== exclude);
    if (!up.length) return undefined;
    const least = Math.min(...up.map((b) => b.active));
    const candidates = up.filter((b) => b.active === least);
    return candidates[turn++ % candidates.length];
  }

  function forwardHeaders(req: http.IncomingMessage) {
    const prior = req.headers['x-forwarded-for'];
    return {
      ...req.headers,
      'x-forwarded-for': `${prior ? `${prior}, ` : ''}${req.socket.remoteAddress ?? ''}`,
      'x-forwarded-proto': (req.headers['x-forwarded-proto'] as string) ?? 'http',
      'x-forwarded-host': req.headers.host ?? '',
    };
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/lb/status') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          backends.map((b) => ({
            url: b.url.origin,
            healthy: b.healthy,
            active: b.active,
            served: b.served,
          })),
        ),
      );
      return;
    }
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    const send = (backend: Backend | undefined, retried: boolean) => {
      if (!backend) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'No healthy API instance is available. Try again shortly.' }),
        );
        return;
      }
      backend.active++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          backend.active--;
        }
      };
      const upstream = http.request(
        {
          host: backend.url.hostname,
          port: backend.url.port,
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req),
          agent,
        },
        (up) => {
          backend.served++;
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          up.on('end', release);
          up.on('error', release);
        },
      );
      upstream.on('error', () => {
        release();
        if (res.headersSent) return res.destroy();
        backend.failures++;
        if (idempotent && !retried) return send(pick(backend), true);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'The API instance did not respond.' }));
      });
      res.on('close', release);
      if (idempotent) upstream.end();
      else req.pipe(upstream);
    };
    send(pick(), false);
  });

  // WebSocket: tunnel the upgrade to one backend for the lifetime of the socket.
  server.on('upgrade', (req, socket, head) => {
    const backend = pick();
    if (!backend) return socket.destroy();
    backend.active++;
    const upstream = net.connect(Number(backend.url.port), backend.url.hostname, () => {
      const headers = forwardHeaders(req);
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          Object.entries(headers)
            .flatMap(([k, v]) =>
              Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`],
            )
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    let done = false;
    const release = () => {
      if (!done) {
        done = true;
        backend.active--;
      }
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', release);
    socket.on('close', release);
  });

  async function check(b: Backend) {
    try {
      const r = await fetch(new URL('/api/health', b.url), { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(String(r.status));
      b.failures = 0;
      b.healthy = true;
    } catch {
      if (++b.failures >= 3) b.healthy = false;
    }
  }
  setInterval(
    () => backends.forEach((b) => void check(b)),
    Number(process.env.LB_HEALTH_MS) || 2000,
  ).unref();
  void Promise.all(backends.map(check));

  const port = Number(process.env.LB_PORT) || 3200;
  server.keepAliveTimeout = 65000;
  server.listen(port, process.env.LB_HOST ?? '127.0.0.1', () =>
    console.log(`Load balancer on :${port} → ${backends.map((b) => b.url.origin).join(', ')}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => server.close(() => process.exit(0)));
}
