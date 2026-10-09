// Runs one real council session (ChatGPT + Gemini) against the seeded demo project in an in-memory
// database and prints the timeline, limits, decisions and the LangSmith trace link.
//   npx tsx scripts/council-live.ts "Review the whole architecture."
import 'dotenv/config';
import { connectDatabase, migrate } from '../server/db';
import { seedDemo } from '../server/db/seed';
import { CouncilSession, councilTimeLimit, councilTokenLimit } from '../server/council/council';
import { HttpCouncilLLM } from '../server/council/llm';
import { uid } from '../server/core';

const topic = process.argv[2] || 'Review the whole architecture.';
const db = await connectDatabase({ memory: true });
await migrate(db);
await seedDemo(db);
const [project] = await db.query<{ id: string }>(
  'SELECT id FROM projects ORDER BY created_at LIMIT 1',
);
const [user] = await db.query<{ id: string; name: string; email: string }>(
  'SELECT id,name,email FROM users LIMIT 1',
);
const id = uid();
const t = councilTimeLimit(),
  k = councilTokenLimit();
await db.query(
  'INSERT INTO council_sessions(id,project_id,requested_by,topic,time_limit_seconds,token_limit,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [id, project.id, user.id, topic, t, k, new Date(Date.now() + t * 1000).toISOString()],
);
const start = Date.now();
await new CouncilSession(
  db,
  new HttpCouncilLLM(),
  id,
  project.id,
  topic,
  () => {},
  t * 1000,
  k,
).run(user);
const [s] = await db.query('SELECT * FROM council_sessions WHERE id=$1', [id]);
for (const e of await db.query('SELECT * FROM council_events WHERE session_id=$1 ORDER BY seq', [
  id,
]))
  console.log(
    `#${e.seq} [${e.room}] ${e.kind}${e.latency_ms ? ` ${(e.latency_ms / 1000).toFixed(1)}s` : ''}${e.input_tokens ? ` ${e.input_tokens}+${e.output_tokens} tok` : ''}`,
    e.kind === 'failed' || e.kind === 'limit_reached' ? JSON.stringify(e.content) : '',
  );
console.log(
  '\nStatus:',
  s.status,
  s.error ?? '',
  `| ${((Date.now() - start) / 1000).toFixed(1)} s of ${t} s | tokens ${s.tokens_used} of ${k} | embeddings ${s.embedding_tokens} | RAG ${s.rag_mode} (${s.documents_used} docs)`,
);
for (const d of await db.query(
  'SELECT * FROM council_decisions WHERE session_id=$1 ORDER BY position',
  [id],
))
  console.log(
    `- [${d.status}] (${d.risk}, score ${d.score}) ${d.title}\n    ${d.votes.map((v: any) => `${v.seat}:${v.approve ? 'yes' : 'no'}@${v.confidence}`).join(' ')}`,
  );
console.log('\nLangSmith:', s.trace_url ?? s.trace_id ?? '(tracing disabled)');
await db.close();
