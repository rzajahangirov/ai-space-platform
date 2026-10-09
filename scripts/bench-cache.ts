// Measures agent response time without and with the Redis cache.
//   npm run bench:cache                       real OpenAI calls (OPENAI_API_KEY, REDIS_URL required)
//   npm run bench:cache -- --provider google  real Gemini calls (GOOGLE_API_KEY)
//   npm run bench:cache -- --runs 5           more samples per phase
//   npm run bench:cache -- --simulate 2500    no API key: a fake provider that takes 2500 ms per call
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { createClient } from 'redis';
import {
  GoogleProvider,
  OpenAIProvider,
  type AgentContext,
  type LLMProvider,
} from '../server/agents/providers';
import {
  CachedProvider,
  cacheTtlSeconds,
  closeCache,
  lastCacheStatus,
} from '../server/agents/cache';
import type { Agent } from '../shared/domain';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runs = Math.max(1, Number(arg('runs')) || 3);
const simulateMs = arg('simulate') ? Number(arg('simulate')) : undefined;
const provider = arg('provider') === 'google' ? 'google' : 'openai';

if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is not set. Start Redis and set e.g. REDIS_URL=redis://localhost:6379');
  process.exit(1);
}

const agent: Agent = {
  id: 'bench-agent',
  name: 'PerformanceEngineer',
  role: 'performance',
  description: '',
  provider,
  model:
    provider === 'google'
      ? process.env.COUNCIL_GOOGLE_MODEL || 'gemini-flash-latest'
      : process.env.OPENAI_MODEL || 'gpt-5.5',
  instructions: 'Review the supplied architecture for performance risks. Be brief.',
  enabled: true,
  status: 'idle',
  capabilities: [],
  settings: {},
};
const context: AgentContext = {
  graph: {
    components: [
      {
        id: 'api',
        name: 'Orders API',
        category: 'BACKEND',
        technology: 'Node.js',
        description: '',
        config: { readHeavy: true },
        x: 0,
        y: 0,
      },
      {
        id: 'db',
        name: 'Orders DB',
        category: 'DATABASE',
        technology: 'PostgreSQL',
        description: '',
        config: {},
        x: 0,
        y: 0,
      },
    ] as any,
    edges: [{ id: 'e1', source: 'api', target: 'db', protocol: 'SQL' }] as any,
  },
  revision: 1,
  prompt: `Benchmark question ${Date.now()}: is there a performance risk between the API and the database?`,
  knowledge: [],
  discussion: [],
  skills: [],
};

const fake: LLMProvider = {
  async generate() {
    await new Promise((r) => setTimeout(r, simulateMs));
    return {
      output: {
        message: 'Simulated answer.',
        findings: [],
        proposals: [],
        additions: [],
        delegates: [],
      },
      inputTokens: 500,
      outputTokens: 200,
    };
  },
};
const raw: LLMProvider =
  simulateMs !== undefined
    ? fake
    : provider === 'google'
      ? new GoogleProvider()
      : new OpenAIProvider();
const withCache = new CachedProvider(simulateMs !== undefined ? 'simulated' : provider, raw);

async function time(p: LLMProvider) {
  const t = performance.now();
  await p.generate(agent, context);
  return performance.now() - t;
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    avg: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s.at(-1)!,
  };
};
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);

console.log(
  `Provider: ${simulateMs !== undefined ? `simulated (${simulateMs} ms)` : `${provider === 'google' ? 'Gemini' : 'OpenAI'} ${agent.model}`}`,
);
console.log(`Runs per phase: ${runs}, cache TTL: ${cacheTtlSeconds()} s\n`);

const before: number[] = [];
for (let i = 0; i < runs; i++) {
  before.push(await time(raw));
  console.log(`  without cache #${i + 1}: ${fmt(before.at(-1)!)}`);
}
const miss = await time(withCache);
console.log(`  with cache, first call (${lastCacheStatus()}): ${fmt(miss)}`);
const after: number[] = [];
for (let i = 0; i < runs; i++) {
  after.push(await time(withCache));
  console.log(`  with cache #${i + 1} (${lastCacheStatus()}): ${fmt(after.at(-1)!)}`);
}

const b = stats(before),
  a = stats(after);
console.table({
  'Without Redis': { avg: fmt(b.avg), median: fmt(b.median), min: fmt(b.min), max: fmt(b.max) },
  'Redis first call (miss)': { avg: fmt(miss), median: fmt(miss), min: fmt(miss), max: fmt(miss) },
  'Redis cached (hit)': {
    avg: fmt(a.avg),
    median: fmt(a.median),
    min: fmt(a.min),
    max: fmt(a.max),
  },
});
console.log(
  `Speedup on a cache hit: ${(b.avg / a.avg).toFixed(0)}x faster (${fmt(b.avg)} → ${fmt(a.avg)})`,
);

// Remove the benchmark's own key so it does not linger for the TTL.
const c = createClient({ url: process.env.REDIS_URL });
await c.connect();
await c.del(withCache.keyFor(agent, context));
await c.quit();
await closeCache();
