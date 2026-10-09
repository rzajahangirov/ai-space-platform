# Security model

| Action                                                   | Viewer | Reviewer | Editor | Admin / Owner                       |
| -------------------------------------------------------- | ------ | -------- | ------ | ----------------------------------- |
| Read graph, findings, history, project discussion        | Yes    | Yes      | Yes    | Yes                                 |
| Comment / discuss                                        | No     | Yes      | Yes    | Yes                                 |
| Run review / resolve finding                             | No     | Yes      | Yes    | Yes                                 |
| Edit graph / import / restore / create views / knowledge | No     | No       | Yes    | Yes                                 |
| Approve/reject architecture proposal                     | No     | No       | No     | Yes                                 |
| Invite / change member roles / configure agents          | No     | No       | No     | Yes                                 |
| Start a council session                                  | No     | Yes      | Yes    | Yes                                 |
| Decide a council decision held for senior review         | No     | No       | No     | Yes                                 |
| Update workspace-wide skill                              | No     | No       | No     | Workspace Owner/Admin also required |

Project invitations do not grant workspace administration or sibling-project access. Owner membership cannot be demoted through the role endpoint. Project IDs from the browser never substitute for a membership check. Tool/resource permissions are separate: the registry requires an exact agent, tool, operation, resource, and policy match. Missing and disabled grants deny execution. Approval-required tools cannot execute in this release; architecture proposals have their own explicit human approval path.

Sessions use random 256-bit bearer tokens with only hashes stored in the database. Passwords use scrypt with random per-password salts. Session cookies are HttpOnly and SameSite=Lax, and Secure in production. Expiry is seven days; logout revokes the stored session. Login/register are rate-limited. Unknown-account password checks still perform password derivation. OIDC uses state, nonce, PKCE, issuer-bound subject, verified-email claims, and no automatic local-account linking.

Mutations require a custom request header and reject foreign Origin headers. No CORS credentials are allowed. WebSocket upgrades require the configured origin and a valid project session, and live connections recheck membership/session expiry periodically. Presence messages have strict size/rate/schema limits. Session tokens are never placed in WebSocket URLs. When the frontend is served from another origin than the API (`LIVE_ORIGIN` set), the browser cannot attach the session cookie to the upgrade; it instead obtains a single-use ticket through its same-origin proxy. Tickets are 256-bit random, stored only as hashes in memory, expire after 30 seconds, are bound to the issuing session (whose expiry the live connection keeps rechecking), and are accepted only on the live channel. Tickets live in instance memory, so a multi-replica deployment that sets `LIVE_ORIGIN` needs sticky routing for `/api/live-ticket` and the live channel.

All SQL input uses parameters. Graph payloads, strings, identifiers, arrays, and model outputs have bounds. React renders model/project content as text; no untrusted HTML or code execution. Provider keys and OAuth secrets exist only in server environment variables. Provider failures do not echo raw response bodies. Invitation tokens are never included in audit records or request logs. Logs record error types and request IDs instead of SQL parameters or request bodies.

Council seats receive only a read-only architecture snapshot and retrieved document excerpts, both marked as untrusted data. They have no tools and cannot write the graph; their decisions are stored records, not graph mutations. The model response cache key is a hash of the complete provider request, so an answer is reused only for an identical request. When LangSmith tracing is enabled, truncated prompts and model outputs are sent to LangSmith; provider keys are never traced.

Residual boundaries: local authentication does not include email verification/recovery/MFA; provider outputs are recommendations, not trusted attestations; token reservations are estimates; external data connectors are not implemented; deployments need TLS, tested backups, key management, retention limits, and an independent security review. Apply trusted-proxy configuration only for your actual proxy topology. Do not blindly trust forwarded IP headers for throttling.
