// Load test: 1000 simultaneous requests against a running AgentSpace (direct or behind the load balancer).
//   npx tsx scripts/loadtest.ts --url http://localhost:3201 --label "1 instance" [--out results.json]
// Scenarios per endpoint:
//   burst      exactly 1000 requests sent at the same moment (1000 connections, 1 request each)
//   sustained  1000 concurrent connections kept busy for --seconds (default 15)
// Signs in as the seeded demo user so authenticated endpoints are measured realistically.
import 'dotenv/config';
import autocannon from 'autocannon';
import { appendFile } from 'node:fs/promises';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const base = arg('url', 'http://localhost:3201')!;
const label = arg('label', base)!;
const seconds = Number(arg('seconds', '15'));
const concurrency = Number(arg('concurrency', '1000'));
const out = arg('out');
// Client-side worker threads so the load generator is not the single-core bottleneck.
const workers = Number(arg('workers', '4'));

const headers = {
  'x-agentspace-request': '1',
  origin: process.env.APP_ORIGIN || base,
  'content-type': 'application/json',
};
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email: 'demo@agentspace.local', password: process.env.DEMO_PASSWORD }),
});
if (!login.ok)
  throw new Error(`Sign-in failed (${login.status}). Seed the database and set DEMO_PASSWORD.`);
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const auth = { ...headers, cookie };
const projects = await (await fetch(`${base}/api/projects`, { headers: auth })).json();
const pid = projects.projects[0].id;

const endpoints = [
  { name: 'health (SELECT 1)', path: '/api/health', headers },
  { name: 'project list', path: '/api/projects', headers: auth },
  { name: 'project snapshot (14 queries)', path: `/api/projects/${pid}/snapshot`, headers: auth },
];

function run(opts: autocannon.Options) {
  return new Promise<autocannon.Result>((resolve, reject) =>
    autocannon(opts, (err, res) => (err ? reject(err) : resolve(res))),
  );
}
const rows: any[] = [];
for (const e of endpoints) {
  for (const mode of ['burst', 'sustained'] as const) {
    const r = await run({
      url: base + e.path,
      headers: e.headers,
      connections: concurrency,
      ...(mode === 'burst' ? { amount: concurrency } : { duration: seconds }),
      timeout: 30,
      pipelining: 1,
      workers,
    });
    const row = {
      setup: label,
      endpoint: e.name,
      mode,
      requests: r.requests.total,
      'req/s': Math.round(r.requests.average),
      'p50 ms': r.latency.p50,
      'p90 ms': r.latency.p90,
      'p99 ms': r.latency.p99,
      'max ms': r.latency.max,
      'avg ms': Math.round(r.latency.average),
      errors: r.errors + r.timeouts,
      non2xx: r.non2xx,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
console.table(rows.map(({ setup, ...r }) => r));
if (out) await appendFile(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
