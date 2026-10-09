# Operations

Run a single app replica for this release. The HTTP API, WebSocket hub, outbox consumer, and agent worker share one process. PostgreSQL persists all authoritative state. In-process presence and throttling are suitable only for this topology.

`GET /api/health` checks database connectivity. Fastify emits JSON logs. Agent activity, tool duration/status, usage, approval records, and audit entries are queryable via project APIs and visible in the workspace. Model reasoning traces are neither requested nor stored. Dedicated Prometheus/OpenTelemetry instrumentation and alerting are follow-up work.

Before deploying: set `DATABASE_URL`, an HTTPS `APP_ORIGIN`, `NODE_ENV=production`, model credentials as needed, and optional OIDC issuer/client credentials. Terminate TLS in your reverse proxy and forward `/api/projects/:id/live` upgrades. A compiled frontend is served by Fastify after `npm run build`. The Docker image runs as the Node user. Container data belongs in PostgreSQL, not the application filesystem.

The app applies migrations at startup. For a managed rollout, execute `npm run db:migrate` as a single migration job before starting the app. The one-replica constraint also avoids concurrent startup migration races. Back up PostgreSQL using your platform's PITR plus regular restore drills. Do not treat a volume as a backup. Keep a copy of provider settings and deployed migration hashes alongside releases; do not store secrets in those records.

Shutdown closes WebSockets and stops scheduling new work, then waits for the current bounded review to finish. An interrupted run is marked failed on restart; the user can start a fresh review. The system does not retry billable model requests automatically. Outbox events can be reprocessed safely for invalidation; architecture mutation transactions are atomic.

Retention is not automated in this MVP. Establish policies for sessions, used/expired invitations, agent usage, event outbox, audit logs, graph snapshots, and project messages. Keep approval records and the versions they reference for the required audit window. Expose deletion only through a separately authorized, tested workflow.

Docker cannot be claimed verified unless you run it on a Docker-enabled host. Local integration tests use the PostgreSQL-compatible PGlite engine; run the same critical paths against your deployment's PostgreSQL server as part of staging acceptance. OIDC and real LLM providers need credentialed integration tests before shared rollout.
