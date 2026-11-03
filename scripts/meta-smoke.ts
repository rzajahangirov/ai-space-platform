// Explicit live, uncached request. No credentials or provider response bodies are printed.
import 'dotenv/config';
import { MetaProvider } from '../server/agents/providers';
import type { Agent } from '../shared/domain';
const agent: Agent = {
  id: 'meta-smoke',
  name: 'Meta connectivity check',
  role: 'architect',
  description: '',
  provider: 'meta',
  model: 'muse-spark-1.3',
  instructions:
    'No graph was supplied. State that evidence is insufficient. Return empty findings, proposals, additions and delegates.',
  enabled: true,
  status: 'idle',
  capabilities: [],
  settings: {},
};
const started = Date.now();
try {
  const result = await new MetaProvider().generate(agent, {
    graph: { components: [], edges: [] },
    revision: 0,
    prompt: 'Confirm there is insufficient architecture evidence to review.',
    knowledge: [],
    discussion: [],
    skills: [],
  });
  console.log(
    JSON.stringify({
      ok: true,
      provider: 'meta',
      upstreamProvider: result.upstreamProvider ?? 'Meta',
      model: result.model ?? agent.model,
      schemaValidated: true,
      cached: false,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - started,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Meta connectivity check failed.');
  process.exitCode = 1;
}
