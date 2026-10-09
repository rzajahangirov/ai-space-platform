// Redis response cache for model calls. The key is a SHA-256 of everything sent to the provider
// (model, instructions, full context/transcript, tools), so a hit only happens when the request is
// byte-for-byte identical: same project revision, same question, same discussion. Entries expire after
// AGENT_CACHE_TTL_SECONDS (default 900 = 15 minutes); after that the provider is called again.
// Disabled when REDIS_URL is unset. Redis errors never fail a review: the call falls through to the provider.
import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import type { Agent } from '../../shared/domain';
import type { AgentContext, LLMProvider, ProviderResult } from './providers';
import type { AgentStep, AgenticProvider, StepRequest } from './agentic';
import { traceLLM } from '../tracing';

type Client = ReturnType<typeof createClient>;
let client: Client | undefined;
let connecting: Promise<Client | undefined> | undefined;

export const cacheTtlSeconds = () =>
  Math.max(1, Number(process.env.AGENT_CACHE_TTL_SECONDS) || 900);
export const cacheEnabled = () => Boolean(process.env.REDIS_URL);

async function redis(): Promise<Client | undefined> {
  if (!cacheEnabled()) return undefined;
  if (client?.isReady) return client;
  connecting ??= (async () => {
    try {
      let connected = false;
      const c = createClient({
        url: process.env.REDIS_URL,
        socket: {
          connectTimeout: 2000,
          // Fail the first connect immediately (reviews must not wait on Redis); retry only after that.
          reconnectStrategy: (n) => (connected ? Math.min(n * 200, 5000) : false),
        },
      });
      c.on('error', () => {}); // reconnects in the background; calls fall through meanwhile
      await c.connect();
      connected = true;
      client = c;
      return c;
    } catch {
      return undefined;
    } finally {
      connecting = undefined;
    }
  })();
  return connecting;
}

export function cacheKey(kind: string, payload: unknown) {
  return `agentspace:llm:${kind}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export type CacheStatus = 'hit' | 'miss' | 'off';
let lastStatus: CacheStatus = 'off';
/** Status of the most recent cached call (for logs, tests, and benchmarks). */
export const lastCacheStatus = () => lastStatus;

async function cached<T extends { inputTokens: number; outputTokens: number }>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const c = await redis();
  if (!c) {
    lastStatus = 'off';
    return load();
  }
  try {
    const hit = await c.get(key);
    if (hit) {
      lastStatus = 'hit';
      // A cached answer cost nothing this time, so it reports no provider tokens.
      return { ...(JSON.parse(hit) as T), inputTokens: 0, outputTokens: 0 };
    }
  } catch {
    /* fall through to the provider */
  }
  lastStatus = 'miss';
  const value = await load();
  try {
    await c.set(key, JSON.stringify(value), { EX: cacheTtlSeconds() });
  } catch {
    /* the answer is still returned */
  }
  return value;
}

export class CachedProvider implements LLMProvider {
  constructor(
    private name: string,
    private inner: LLMProvider,
  ) {}
  keyFor(agent: Agent, context: AgentContext) {
    return cacheKey(`generate:${this.name}`, {
      model: agent.model,
      role: agent.role,
      name: agent.name,
      instructions: agent.instructions,
      context,
    });
  }
  generate(agent: Agent, context: AgentContext): Promise<ProviderResult> {
    return traceLLM(
      `${this.name}:${agent.name}`,
      { ls_provider: this.name, ls_model_name: agent.model, agent: agent.name, role: agent.role },
      { prompt: context.prompt, revision: context.revision },
      () => cached(this.keyFor(agent, context), () => this.inner.generate(agent, context)),
      (r) => ({ message: r.output.message, findings: r.output.findings.length, cache: lastStatus }),
    );
  }
}

export class CachedAgenticProvider implements AgenticProvider {
  constructor(
    private name: string,
    private inner: AgenticProvider,
  ) {}
  step(request: StepRequest): Promise<AgentStep> {
    return traceLLM(
      `${this.name}:step`,
      { ls_provider: this.name, ls_model_name: request.model },
      { lastInput: request.input.at(-1), tools: request.tools.map((t) => t.name) },
      () => cached(cacheKey(`step:${this.name}`, request), () => this.inner.step(request)),
      (r) => ({ text: r.text, calls: r.calls.map((c) => c.name), cache: lastStatus }),
    );
  }
  toolResult(...args: Parameters<AgenticProvider['toolResult']>) {
    return this.inner.toolResult(...args);
  }
  userMessage(text: string) {
    return this.inner.userMessage(text);
  }
}

export async function closeCache() {
  const c = client;
  client = undefined;
  if (c?.isOpen) await c.quit().catch(() => {});
}
