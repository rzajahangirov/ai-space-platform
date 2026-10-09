// Retrieval over the project's Documents (artifacts) and Knowledge sources. Documents are chunked,
// embedded once per session, and each seat retrieves the chunks closest to its own question. Without
// embeddings the ranking falls back to keyword overlap so the council still works offline.
import type { DB } from '../db';
import type { CouncilLLM } from './llm';

export interface Chunk {
  source: string;
  title: string;
  text: string;
}
export interface RagIndex {
  mode: 'embedding' | 'keyword' | 'none';
  documents: number;
  chunks: Chunk[];
  vectors?: number[][];
  tokens: number;
}

const SIZE = 1200,
  OVERLAP = 200,
  MAX_CHUNKS = 120;

export function chunk(title: string, source: string, content: string): Chunk[] {
  const clean = content.replace(/\s+\n/g, '\n').trim();
  const out: Chunk[] = [];
  for (let i = 0; i < clean.length && out.length < 20; i += SIZE - OVERLAP)
    out.push({ source, title, text: clean.slice(i, i + SIZE) });
  return out;
}

export async function buildIndex(
  db: DB,
  projectId: string,
  llm: CouncilLLM,
  signal: AbortSignal,
): Promise<RagIndex> {
  const docs = [
    ...(
      await db.query<{ id: string; title: string; content: string }>(
        'SELECT id,title,content FROM artifacts WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 40',
        [projectId],
      )
    ).map((d) => ({ ...d, source: `document:${d.id}` })),
    ...(
      await db.query<{ id: string; title: string; content: string }>(
        'SELECT id,title,content FROM knowledge_sources WHERE project_id=$1 ORDER BY created_at DESC LIMIT 40',
        [projectId],
      )
    ).map((d) => ({ ...d, source: `knowledge:${d.id}` })),
  ];
  if (!docs.length) return { mode: 'none', documents: 0, chunks: [], tokens: 0 };
  const chunks = docs.flatMap((d) => chunk(d.title, d.source, d.content)).slice(0, MAX_CHUNKS);
  const embedded = await llm.embed(
    chunks.map((c) => `${c.title}\n${c.text}`),
    signal,
  );
  return embedded
    ? {
        mode: 'embedding',
        documents: docs.length,
        chunks,
        vectors: embedded.vectors,
        tokens: embedded.tokens,
      }
    : { mode: 'keyword', documents: docs.length, chunks, tokens: 0 };
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
};
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

export async function retrieve(
  index: RagIndex,
  query: string,
  llm: CouncilLLM,
  signal: AbortSignal,
  k = 4,
): Promise<{ hits: (Chunk & { score: number })[]; tokens: number }> {
  if (index.mode === 'none' || !query.trim()) return { hits: [], tokens: 0 };
  let scores: number[];
  let tokens = 0;
  const q = index.mode === 'embedding' ? await llm.embed([query], signal) : null;
  if (q && index.vectors) {
    tokens = q.tokens;
    scores = index.vectors.map((v) => cosine(v, q.vectors[0]));
  } else {
    const qw = words(query);
    scores = index.chunks.map((c) => {
      const cw = words(`${c.title} ${c.text}`);
      let n = 0;
      for (const w of qw) if (cw.has(w)) n++;
      return n / (qw.size || 1);
    });
  }
  const hits = index.chunks
    .map((c, i) => ({ ...c, score: scores[i] }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((c) => ({ ...c, text: c.text.slice(0, 800) }));
  return { hits, tokens };
}
