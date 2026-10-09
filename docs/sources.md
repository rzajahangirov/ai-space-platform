# Official implementation references

Consulted during implementation:

- [React Flow quick start](https://reactflow.dev/learn) — `@xyflow/react`, controlled nodes/edges, styles, and graph interaction.
- [Fastify WebSocket plugin](https://github.com/fastify/fastify-websocket) — registration order, synchronous message-handler attachment, and authenticated route hooks.
- [PGlite API](https://pglite.dev/docs/api) — parameterized queries, transactions, and persistent local PostgreSQL.
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) — Responses API JSON-schema outputs and response validation.
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — Messages API output format and constrained JSON.
- [Google Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) and [GenerateContent structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) — JSON Schema and provider response formats.
- [openid-client authorization code example](https://github.com/panva/openid-client/blob/main/examples/oauth.ts) — discovery, PKCE, state, and authorization-code grant validation.

Exact npm dependency versions are pinned in `package.json` and `package-lock.json`. Models are administrator-configured rather than hardcoded to an assumed latest model. No current model prices are assumed by the application.
