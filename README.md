# AgentSpace

A multiplayer engineering workspace organized around a **live software architecture**, with human-controlled AI review. This repository contains a working vertical MVP, not a landing page. The frontend, backend, migrations, and agent worker run together locally.

## Run locally

Requires **Node.js 22.12+**. Docker, PostgreSQL installation, and model API keys are not required for the local path.

```sh
npm ci
cp .env.example .env
npm run db:seed
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` and `npm.cmd` if the execution policy blocks `npm.ps1`.

Open **http://localhost:5173**. Use this seeded account:

- Email: `demo@agentspace.local`
- Password: `ShopSphere-local-2026!` (or the `DEMO_PASSWORD` you set **before** seeding)

The idempotent seed creates ShopSphere, eight engineering agents, 13 components, 14 connections, and an initial review task. The worker generates evidence-based findings and proposals when the server starts. Changing `DEMO_PASSWORD` after seeding does not change an existing account.

Local data persists under `.data/agentspace` using **PGlite**, an embedded PostgreSQL runtime. Only one process may open this directory. Stop `npm run dev` before running database CLI commands against the same directory. Unit/integration tests use a separate in-memory database.

Use `APP_ORIGIN=http://localhost:5173` exactly, and visit that address. Origin validation protects mutations and WebSocket upgrades. For a second browser, use a private window, create another account, and accept an invitation generated from the first account.

## What works

- Account registration/login, scrypt password hashes, opaque cookie sessions, logout, optional OIDC authorization-code flow with PKCE and nonce validation.
- Workspaces, projects, Owner/Admin/Editor/Reviewer/Viewer membership, email-restricted or unrestricted single-use invitations, and project access management.
- React Flow architecture canvas with pan/zoom, draggable components, typed edges, connection metadata, custom components, canonical graph persistence, category-based views, inspector, comments, JSON import/export, and version restores.
- Authenticated real-time updates, visible human presence and selected components, reconnect/refetch, graph revision conflicts, and atomic commits.
- Configurable agent library, eight starter specialists, OpenAI/Anthropic/Google provider adapters, and an explicitly labeled local rules provider.
- Project-aware engineering discussion with agent selection, durable review tasks, peer delegation, bounded agent turns/depth/budget, relevant context retrieval, reusable skills, and scoped tools.
- Structured findings, confidence/evidence, transparent health deductions, proposal diffs, admin approval/rejection, stale-proposal protection, before/after records, audit timeline, tool executions, and per-agent usage/cost display.
- Search/command palette (`Ctrl/Cmd+K`), dark/light themes, loading/empty/error states, and desktop-first responsive layout.
- **Multiplayer conversations with tool-calling OpenAI agents**, inline proposals, delegation, and artifacts (see below).
- **Structural proposals**: agents may propose a new component plus connections (for example, a Redis cache for a read-heavy service). The server validates every endpoint, rejects name collisions, places the card without overlap, and applies nothing until an owner/admin approves.
- **@mentions and inbox**: `@SecurityAgent`, `@DatabaseEngineer`, or `@architect` in the engineering room starts one bounded run with every mentioned agent; in a component thread, the agents answer inside that thread. `@FirstName` notifies teammates. The inbox also collects approval requests (owners/admins), high-severity findings, drift, and finished reviews.
- **Import existing system**: discovery from `docker-compose.yml`, `package.json`, or `requirements.txt` shows each inferred component with confidence and evidence. Uncertain items start unselected, existing components are matched instead of duplicated, and merging is an ordinary audited graph revision.
- **Observe mode**: compare a deployment manifest with the design. The drift report lists designed-but-unobserved connections, observed-but-undeclared connections, and missing components. Reports are stored as observations and as knowledge, so agents can analyze them. Try **Observe → Load sample Compose file** on ShopSphere.

The seeded findings are based on declared configuration, **not invented runtime telemetry**. For example, the gateway declares `rateLimiting: false`, the payment service declares `databaseAccess: "all tables"`, and Kafka declares `deadLetterQueue: false`.

## AI agents (OpenAI, tool-calling)

With `OPENAI_API_KEY` in the server `.env`, new projects get eight OpenAI agents (`OPENAI_MODEL`, default `gpt-5.5`). For existing projects use **Agents → Model for all agents → Apply to all**, or configure one agent (model, reasoning effort, instructions). Keys never reach the browser.

OpenAI agents are real tool-calling agents (Responses API, `store: false`, strict function schemas). Each turn they get a briefing (project, component list, connections, artifacts, pending proposals, teammates, and the conversation), then call tools until they answer:

| Tool                                                                        | Grant | What it does                                                                                                    |
| --------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `read_architecture`, `inspect_component`, `search_project`, `read_artifact` | read  | Ground answers in the canonical graph, findings, decisions, knowledge, artifacts, and history                   |
| `propose_change`                                                            | write | Add/update/remove components and connections as **one proposal**; nothing applies until an owner/admin approves |
| `record_finding`                                                            | write | Evidence-backed finding (confidence ≥ 0.65, deduplicated)                                                       |
| `write_artifact`                                                            | write | Markdown reviews, plans, API specs, ADRs, runbooks                                                              |
| `ask_agent`                                                                 | write | Ask a teammate agent; they answer next in the same conversation                                                 |

Each tool is offered only if the agent holds an exact `AUTO` grant for the project; calls are validated with Zod and recorded (input summary, result, duration) in the activity timeline. Invalid proposals are returned to the model as errors so it can correct them.

**Conversations** (Dust-style, multiplayer): any number of threads per project, shared live by every member. `@SystemArchitect`, `@security`, `@DatabaseAgent`, or the agent chips address agents (up to three per message). Answers show the tools used, inline proposal cards with **Apply to architecture / Reject**, finding chips, and artifact links. **Run review** opens a dedicated conversation. The **Engineering room** drawer is the same thread next to the canvas and sends the selected component as focus. Describing a system when creating a project makes the architect draft the initial architecture.

Proposals store semantic operations. If the graph changed after a proposal was drafted, approval re-validates the operations on the current graph and applies them, or explains why they no longer apply.

Limits: one active run per conversation (parallel conversations run concurrently, three at a time), five agents per run, delegation depth two, twelve tool steps per agent turn, and `AGENT_RUN_TOKEN_LIMIT` (default 250k provider-reported tokens) per run. A design request typically uses 10–50k tokens and 20–60 s. `LIVE_REVIEW=on` asks the architect to comment on structural human edits (at most every two minutes) in a separate _Live architecture review_ conversation; it never undoes edits.

Anthropic and Google agents use the earlier single-shot structured-output path; local agents run deterministic rules without any API call (used by tests).

To show estimated cost, set `MODEL_PRICES_JSON` using your provider's current per-million-token prices:

```json
{ "your-exact-model-id": { "input": 1.25, "output": 5.0 } }
```

Those numbers illustrate the configuration format, not actual provider pricing. Missing prices display as unknown rather than as free. Provider billing remains authoritative.

## PostgreSQL and Docker

Set `DATABASE_URL` to use standard PostgreSQL. Migrations use parameterized SQL through `pg`; the same schema runs on local PGlite. Production mode refuses embedded storage and HTTP origins.

For a local Docker preview, put these values in `.env` (use your own password with URL-safe characters):

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-password
APP_ORIGIN=http://localhost:3001
NODE_ENV=development
DEMO_PASSWORD=choose-a-private-demo-password
```

```sh
docker compose up --build -d
docker compose exec app npm run db:seed
```

Open **http://localhost:3001**. The backend serves the built frontend. The database is not exposed on a host port. Docker was supplied but could not be executed in the implementation environment because Docker was not installed.

For a shared deployment, use PostgreSQL, one application replica, `NODE_ENV=production`, an HTTPS `APP_ORIGIN`, and an HTTPS reverse proxy forwarding WebSocket upgrades. The image runs as an unprivileged user. Do not seed shared installations with the public local password. Configure backup/restore, retention, provider budgets, and your identity provider before granting access. See [operations](docs/operations.md) and [security](docs/security.md).

## Verify

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests build the frontend and start a dedicated server on port 5174 with a fresh in-memory ShopSphere database. They never modify local workspace data. They create an additional collaborator and verify live component synchronization in two browser contexts. Test screenshots/traces go to `test-results/`. `npm run verify` runs types, unit/integration tests, and the production frontend build. CI also runs browser tests.

## Repository

```text
src/                      React application, canvas, inspector, collaboration UI
server/app.ts             Fastify composition and HTTP security
server/auth.ts            Local sessions and optional OIDC
server/routes.ts          Validated project APIs
server/graph.ts           Graph invariants, transactions, versions, proposal approval
server/realtime.ts        Authenticated WebSockets and presence
server/agents/            Provider adapters, tools, context, bounded orchestration
server/discovery.ts       Manifest discovery and designed-vs-observed drift
server/mentions.ts        @mention resolution and inbox notifications
server/routes-observe.ts  Discovery and observation APIs
server/db/                PostgreSQL adapter, SQL migrations, demo seed
shared/domain.ts          Runtime schemas and shared TypeScript contracts
tests/                    Permission, API, graph, agent, and browser tests
docs/                     Architecture decisions, API, operations, security
Dockerfile / compose.yaml Container setup with PostgreSQL
```

## Deliberate MVP boundaries

This is a locally runnable engineering MVP with production-oriented boundaries, not a claim that the entire 54-part roadmap is finished or independently security-audited.

- One application instance owns presence and the worker. Horizontal replicas require distributed presence, event fan-out, run leases, and distributed throttling.
- Architecture edits use authoritative revision-checked transactions. Offline editing, CRDT text collaboration, per-view layout overrides, and architecture branches/scenarios are future work.
- GitHub repository scanning, live (non-manifest) drift, deployment/cloud/database connectors, observed telemetry, S3 uploads, external MCP transport execution, and destructive external tools are not connected. Repository mapping tables and the tool contract establish the extension points. Graph JSON imports work today.
- The tool registry publishes MCP-compatible descriptors, but is not itself a complete MCP server/client. `APPROVAL_REQUIRED` tools fail closed until an approved execution workflow is implemented.
- OIDC integration is implemented but needs validation against your configured identity provider. Local password login has no email delivery, password reset, MFA, or account recovery flow; prefer OIDC for shared installations.
- Context retrieval is bounded graph-neighborhood/metadata/recency retrieval. Embeddings and semantic search are deferred. Knowledge is plain text, not executable HTML or arbitrary React.
- Review tasks and an in-app inbox are implemented; a general task board, email/push delivery, `@team` mentions, scenario comparison, and marketplace sharing are future work.
- Discovery is static analysis of manifests, not repository code scanning or runtime telemetry. Matching uses explicit `composeService`/`packageName` config, then names, then technology for infrastructure only.

See [architecture](docs/architecture.md) for the domain, consistency model, agent flow, and expansion path. Official implementation references are recorded in [sources](docs/sources.md).
