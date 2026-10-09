# API guide

All routes are under `/api`. JSON mutations require `X-AgentSpace-Request: 1`. Browser requests use the HttpOnly session cookie. Errors return `{ "error": "message" }`; validation errors may include field details. `401` indicates a missing/expired session; `404` hides inaccessible projects; `403` denies an action; `409` is a stale revision, duplicate decision, or active-review conflict.

| Endpoint                                                                | Purpose                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/register`, `/auth/login`, `/auth/logout`                    | Local authentication                                                                                                     |
| `GET /auth/config`, `/auth/oidc/start`, `/auth/oidc/callback`           | OIDC configuration / flow                                                                                                |
| `GET /me`, `/workspaces`, `/projects`                                   | Authorized identity and scopes                                                                                           |
| `POST /projects`                                                        | New workspace/project or project in an administered workspace                                                            |
| `GET /projects/:id/snapshot`                                            | Authorized graph and collaboration state                                                                                 |
| `POST /projects/:id/graph`                                              | `{ revision, changes, summary }` transaction                                                                             |
| `POST /projects/:id/views`                                              | Canonical category projection                                                                                            |
| `POST /projects/:id/invites`                                            | `{ role, email? }`; returns one-time URL                                                                                 |
| `POST /invites/:token/accept`                                           | Consume invitation and join project                                                                                      |
| `PATCH /projects/:id/members/:userId`                                   | Change non-owner role                                                                                                    |
| `POST /projects/:id/reviews`                                            | `{ prompt, componentId?, agentId? }` durable run                                                                         |
| `POST /projects/:id/messages`                                           | `{ content, agentId?, componentId? }`; `@Agent` mentions start one run with up to three agents, `@Human` mentions notify |
| `POST /projects/:id/proposals/:proposalId/decision`                     | `{ decision: "APPROVED" \| "REJECTED" }`                                                                                 |
| `PATCH /projects/:id/findings/:findingId`                               | Resolve/dismiss/reopen finding                                                                                           |
| `POST /projects/:id/comments`                                           | Component discussion; mentioned agents reply in the thread; returns `agentNotice`                                        |
| `PATCH /projects/:id/comments/:commentId`                               | Resolve/reopen comment                                                                                                   |
| `POST /projects/:id/agents`                                             | Create configured agent with graph-read grant                                                                            |
| `PATCH /projects/:id/agents/:agentId`                                   | Configure/disable agent                                                                                                  |
| `GET /projects/:id/tools`                                               | MCP-style descriptors, grants, execution history                                                                         |
| `GET /projects/:id/knowledge`, `POST /projects/:id/knowledge`           | Plain-text project context                                                                                               |
| `GET /projects/:id/skills`, `PATCH /projects/:id/skills/:skillId`       | Shared skill instructions                                                                                                |
| `GET /projects/:id/live` (WebSocket)                                    | Authenticated invalidations / ephemeral presence                                                                         |
| `GET /notifications`, `POST /notifications/read`                        | Personal inbox; `{ ids? }` marks the caller's own items read                                                             |
| `POST /projects/:id/discover`                                           | `{ content, filename? }`; read-only discovery plus matches (editors)                                                     |
| `POST /projects/:id/observations`                                       | `{ content, filename? }`; stores observed structure and drift (reviewers+)                                               |
| `GET /projects/:id/observations`                                        | Latest ten observations with drift reports                                                                               |
| `GET/POST /projects/:id/conversations`, `GET/PATCH .../:conversationId` | Threads; detail includes messages, runs, tool steps, proposals, findings, artifacts                                      |
| `POST /projects/:id/messages`                                           | `{ content, conversationId?, agentIds?, componentId? }`; mentions or agentIds start one run in that conversation         |
| `POST /projects/:id/reviews`                                            | Creates a review conversation and run; returns `conversationId`                                                          |
| `GET/POST /projects/:id/artifacts`, `GET/PATCH .../:artifactId`         | Markdown documents; PATCH requires the current `revision` (409 if stale)                                                 |
| `POST /projects/:id/agents/model`                                       | `{ provider, model }` for every agent in the project (owners/admins)                                                     |
| `GET/POST /projects/:id/council`                                        | Council settings and sessions; POST `{ topic? }` starts one (reviewers+; one running per project, otherwise 409)         |
| `GET /projects/:id/council/:sessionId`                                  | One session with its room timeline and decisions                                                                         |
| `POST /projects/:id/council/decisions/:decisionId`                      | `{ decision: "approved" or "rejected", note? }` for a decision waiting for senior review (owners/admins)                 |

Discovery accepts `docker-compose.yml`, `package.json`, and `requirements.txt` (200 KB max, 20 requests/minute). Environment values are inspected for host names only and never stored or returned.

Graph mutations are discriminated unions: `component.upsert`, `component.delete`, `edge.upsert`, `edge.delete`, `graph.restore`. Shared schemas live in `shared/domain.ts`. Deletion cascades incident edges and component discussions. Restore validates and records a new revision.

WebSocket server messages are `{type:"invalidate"}` or `{type:"presence",members:[...]}`. Client presence is `{selected:string|null,cursor?:{x:number,y:number}}`. Clients never mutate authoritative graph state over this channel. On invalidation/reconnection, fetch a new snapshot.
