# Hackathon deployment

Target: Vercel Hobby frontend + one free Render Node web service + free Render PostgreSQL.
Source: `aliyev-toghrul/ai-space-platform`, branch `hackathon/meta-impact-review`.

Vercel supports Fastify/WebSockets, but this backend explicitly requires one long-lived
instance: its polling worker resets running jobs on startup. Do not deploy the worker
as multiple request-scoped functions without redesigning that lifecycle.

1. Create the resources from `render.yaml` in the owner's Render account. Both plans
   are explicitly `free`. Do not enable billing or accept a paid upgrade. PostgreSQL
   expires after 30 days; export the judge demo before expiry. The backend can sleep
   after inactivity, so the first request can be slow.
2. Use a Vercel Hobby project connected to the fork and branch above. Set its production
   branch to `hackathon/meta-impact-review`. Disable deployment protection for the judge URL.
3. Set Render `APP_ORIGIN` to the exact production Vercel HTTPS origin and `LIVE_ORIGIN`
   to the actual Render HTTPS service origin. Confirm that origin matches the API rewrite
   in `vercel.json` before deploying; the checked-in hostname is the requested service name,
   not evidence that it has been provisioned.
4. Copy the existing OpenRouter credential directly into Render's server-side
   `OPENROUTER_API_KEY`. Never use a `VITE_` variable or put model credentials on the frontend.
   Render generates a private `DEMO_PASSWORD`; retrieve it only for operator sign-in.
   `DATABASE_URL` comes from the dedicated database. Startup runs migrations and the
   idempotent ShopSphere seed. Do not point this deployment at any existing local database.
5. Sign in privately as `demo@agentspace.local`. Add the existing Meta agent type with
   provider `meta`, model `muse-spark-1.3`; run a selected-agent review. Other seeded
   agents use local rules and must not be presented as Meta inference.
6. Create an expiring REVIEWER invitation with bounded uses for judges. Share the
   `/invite/...` URL in the submission: judges register their own accounts and accept
   membership. Keep the demo owner password private. Operator approval demonstrates
   the architecture revision; do not grant public owner/admin access.
7. Verify fresh-browser access, populated graph, genuine Meta run completion, findings,
   pending proposals, human-approved revision, refresh, and persistence across a backend
   redeployment. Record the actual URLs, commit, run ID and model evidence.

Local verification is isolated in memory and does not prove hosted PostgreSQL or routing:

```sh
npm run build
npx playwright test -g 'tab focus and reload'
npx vitest run tests/api.test.ts tests/meta-review.test.ts tests/providers.test.ts tests/invites.test.ts --maxWorkers=1
```

Tab switching did not reload the document in the regression test. A real reload reset
React navigation. Navigation now restores per user/project within the browser tab;
saved architecture, findings and proposals remain authoritative in the database.
Browser memory-pressure tab discarding has not been reproduced on the user's browser.
