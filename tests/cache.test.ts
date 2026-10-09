import { afterAll, describe, it, expect, vi } from 'vitest';
import { createClient } from 'redis';
import { CachedProvider, closeCache, lastCacheStatus } from '../server/agents/cache';
import type { AgentContext, LLMProvider } from '../server/agents/providers';
import type { Agent } from '../shared/domain';

const agent = {
  id: 'a',
  name: 'Reviewer',
  role: 'architect',
  provider: 'openai',
  model: 'm',
  instructions: 'Review.',
} as Agent;
const context = (prompt: string): AgentContext => ({
  graph: { components: [], edges: [] },
  revision: 0,
  prompt,
  knowledge: [],
  discussion: [],
  skills: [],
});
const fake = () => {
  const generate = vi.fn(async () => ({
    output: { message: 'ok', findings: [], proposals: [], additions: [], delegates: [] },
    inputTokens: 10,
    outputTokens: 5,
  }));
  return { generate } satisfies LLMProvider;
};

describe('Redis response cache', () => {
  it('calls the provider directly when REDIS_URL is unset', async () => {
    const url = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const inner = fake();
      const p = new CachedProvider('test', inner);
      await p.generate(agent, context('q'));
      await p.generate(agent, context('q'));
      expect(inner.generate).toHaveBeenCalledTimes(2);
      expect(lastCacheStatus()).toBe('off');
    } finally {
      if (url) process.env.REDIS_URL = url;
    }
  });

  describe.skipIf(!process.env.REDIS_URL)('with Redis', () => {
    const prompt = `cache-test-${Date.now()}`;
    const p = new CachedProvider('test', fake());
    afterAll(async () => {
      const c = createClient({ url: process.env.REDIS_URL });
      await c.connect();
      await c.del([p.keyFor(agent, context(prompt)), p.keyFor(agent, context(`${prompt}-2`))]);
      await c.quit();
      await closeCache();
    });

    it('reuses an identical answer, reports no tokens, and expires after the TTL', async () => {
      const inner = fake();
      const cached = new CachedProvider('test', inner);
      const first = await cached.generate(agent, context(prompt));
      expect(lastCacheStatus()).toBe('miss');
      expect(first.inputTokens).toBe(10);
      const second = await cached.generate(agent, context(prompt));
      expect(lastCacheStatus()).toBe('hit');
      expect(second.output).toEqual(first.output);
      expect(second.inputTokens).toBe(0);
      expect(inner.generate).toHaveBeenCalledTimes(1);

      await cached.generate(agent, context(`${prompt}-2`));
      expect(inner.generate).toHaveBeenCalledTimes(2);

      const c = createClient({ url: process.env.REDIS_URL });
      await c.connect();
      const ttl = await c.ttl(cached.keyFor(agent, context(prompt)));
      await c.quit();
      expect(ttl).toBeGreaterThan(890);
      expect(ttl).toBeLessThanOrEqual(900);
    });
  });
});
