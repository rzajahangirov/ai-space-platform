# Operations

The application runs as one process or as several API instances behind a load balancer. PostgreSQL persists all authoritative state.

- **One worker.** Exactly one instance runs the outbox consumer and agent worker; start the others with `AGENT_WORKER=off`. There are no worker leases yet.
- **Load balancer.** `deploy/nginx.conf` (Compose service `lb`), or `server/lb.ts` for local tests: least-connections routing, health checks on `/api/health`, WebSocket upgrades, one retry for idempotent requests. Set `TRUST_PROXY=true` on the instances so rate limits and audit see client addresses, and only behind your own proxy.
- **Realtime.** With `REDIS_URL`, committed-change invalidations are published to every instance. Presence and rate limits remain per instance.
- **Read replica.** With `DATABASE_READ_URL`, snapshot and project-list reads use the replica in a REPEATABLE READ READ ONLY transaction, but only when the replica has replayed the primary's current WAL position (read-your-writes). Otherwise, or when the replica is unreachable, they run on the primary. Writes always use the primary.
- **Snapshot cache.** Concurrent snapshot reads of one project share a single database read for up to `SNAPSHOT_CACHE_MS` (1000; 0 disables). Membership is checked on every request, and every write invalidates the project on all instances before its response is sent.
- **Pools.** `DATABASE_POOL_MAX` connections per instance and per database (default 10). Size PostgreSQL `max_connections` for instances × pool size.

Load test (`scripts/loadtest.ts`, 1000 simultaneous connections to the project snapshot, one 8-core laptop): one instance served 158 requests/s with a 6.1 s median and lost up to 486 connections in a 1000-request burst. The load balancer with four instances lost none. The read replica took every read off the primary but barely changed latency, because application CPU was the bottleneck. The snapshot cache raised throughput to 821 requests/s with a 1.2 s median. The load generator, balancer, instances, and databases shared one CPU, so treat these as relative numbers.

`GET /api/health` checks database connectivity (outside production it also reports the instance and where reads were served). Fastify emits JSON logs. Agent activity, tool duration/status, usage, approval records, and audit entries are queryable via project APIs and visible in the workspace. Model reasoning traces are neither requested nor stored. Dedicated Prometheus/OpenTelemetry instrumentation and alerting are follow-up work.

Before deploying: set `DATABASE_URL`, an HTTPS `APP_ORIGIN`, `NODE_ENV=production`, model credentials as needed, and optional OIDC issuer/client credentials. Terminate TLS in your reverse proxy and forward `/api/projects/:id/live` upgrades. A compiled frontend is served by Fastify after `npm run build`. The Docker image runs as the Node user. Container data belongs in PostgreSQL, not the application filesystem.

The app applies migrations at startup; instances starting together are serialized by a PostgreSQL advisory lock. For a managed rollout, still prefer `npm run db:migrate` as a single job before starting the instances. Back up PostgreSQL using your platform's PITR plus regular restore drills. Do not treat a volume as a backup. Keep a copy of provider settings and deployed migration hashes alongside releases; do not store secrets in those records.

Shutdown closes WebSockets and stops scheduling new work, then waits for the current bounded review to finish. An interrupted run is marked failed on restart; the user can start a fresh review. Council sessions belong to the instance that runs them: a restarting instance fails only its own sessions, and any instance fails sessions more than a minute past their deadline. The system does not retry billable model requests automatically. Outbox events can be reprocessed safely for invalidation; architecture mutation transactions are atomic.

Retention is not automated in this MVP. Establish policies for sessions, used/expired invitations, agent usage, event outbox, audit logs, graph snapshots, and project messages. Keep approval records and the versions they reference for the required audit window. Expose deletion only through a separately authorized, tested workflow.

Docker cannot be claimed verified unless you run it on a Docker-enabled host. Local integration tests use the PostgreSQL-compatible PGlite engine; run the same critical paths against your deployment's PostgreSQL server as part of staging acceptance. OIDC and real LLM providers need credentialed integration tests before shared rollout. Unit, integration, and browser tests never call model providers or LangSmith; the browser-test server clears their credentials.

## Hosted demo: Vercel frontend + Render API

The demo runs the static frontend on Vercel and a single API instance (Docker) on Render with Render Postgres. `vercel.json` proxies `/api/*` to Render, so the session cookie stays first-party on the Vercel origin. WebSockets cannot pass through that proxy; the browser connects to the Render origin directly with a single-use live ticket (see [security](security.md)).

Render API environment: `NODE_ENV=production`, `APP_ORIGIN` (the Vercel URL), `LIVE_ORIGIN` (the Render URL), `TRUST_PROXY=true`, `DATABASE_URL` (Render internal URL), `SEED_DEMO=on` with a private `DEMO_PASSWORD`, plus provider and LangSmith keys as needed. Free Render services sleep after 15 idle minutes (about a minute to wake) and free Render Postgres expires after 30 days; open the site shortly before a demo.
