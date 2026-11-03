import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  OpenAIProvider,
  MetaProvider,
  AnthropicProvider,
  GoogleProvider,
  portableSchema,
  type AgentContext,
} from '../server/agents/providers';
import type { Agent } from '../shared/domain';
const context: AgentContext = {
  graph: { components: [], edges: [] },
  revision: 0,
  prompt: 'Review',
  knowledge: [],
  discussion: [],
  skills: [],
};
const agent: Agent = {
  id: 'agent',
  name: 'Reviewer',
  role: 'architect',
  description: '',
  provider: 'openai',
  model: 'configured-model',
  instructions: 'Review evidence.',
  enabled: true,
  status: 'idle',
  capabilities: [],
  settings: {},
};
const output = {
  message: 'No project evidence was supplied.',
  findings: [],
  proposals: [],
  additions: [],
  delegates: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('provider contracts', () => {
  it('uses OpenAI Responses structured output without storing project input', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server-only-test-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
          usage: { input_tokens: 123, output_tokens: 45 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenAIProvider().generate(agent, context);
    expect(result.output).toEqual(output);
    expect(result.inputTokens).toBe(123);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(request.body);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.model).toBe('configured-model');
    expect(request.headers.Authorization).toBe('Bearer server-only-test-key');
  });
  it('rejects truncated responses instead of accepting partial operations', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete' }))),
    );
    await expect(new OpenAIProvider().generate(agent, context)).rejects.toThrow('incomplete');
  });
  it('rejects invalid confidence even when a provider claims successful structured output', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            stop_reason: 'end_turn',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...output,
                  findings: [
                    {
                      componentId: null,
                      category: 'Security',
                      severity: 'HIGH',
                      confidence: 3,
                      title: 'Invalid',
                      description: '',
                      evidence: 'x',
                      impact: '',
                      recommendation: '',
                    },
                  ],
                }),
              },
            ],
          }),
        ),
      ),
    );
    await expect(new AnthropicProvider().generate(agent, context)).rejects.toThrow();
  });
  it('normalizes unsupported wire constraints but retains types and exact fields', () => {
    const schema = portableSchema({
      type: 'object',
      additionalProperties: false,
      properties: { confidence: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['confidence'],
    });
    expect(schema.properties.confidence.minimum).toBeUndefined();
    expect(schema.properties.confidence.description).toContain('maximum: 1');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['confidence']);
  });
  it('uses scoped fixed provider endpoints and reports errors without leaking response content', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('sensitive provider body', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GoogleProvider().generate(agent, context)).rejects.toThrow(
      'Provider request failed (429)',
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/configured-model:generateContent',
    );
  });
});

describe('Meta provider', () => {
  const meta = { ...agent, provider: 'meta', model: 'muse-spark-1.3' };
  it('calls Meta directly with a strict schema and validates its output', async () => {
    vi.stubEnv('MODEL_API_KEY', 'test-only');
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      ),
    );
    vi.stubGlobal('fetch', mock);
    const result = await new MetaProvider().generate(meta, context);
    expect(result.output).toEqual(output);
    expect(result.inputTokens).toBe(10);
    expect(mock.mock.calls[0][0]).toBe('https://api.meta.ai/v1/chat/completions');
    const body = JSON.parse(mock.mock.calls[0][1].body);
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.response_format.json_schema.strict).toBe(true);
  });
  it('fails before fetching when the key is missing', async () => {
    vi.stubEnv('MODEL_API_KEY', '');
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(new MetaProvider().generate(meta, context)).rejects.toThrow('MODEL_API_KEY');
    expect(mock).not.toHaveBeenCalled();
  });
  it.each(['length', 'content_filter', 'stop'])(
    'rejects incomplete or invalid output (%s)',
    async (reason) => {
      vi.stubEnv('MODEL_API_KEY', 'test-only');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: reason, message: { content: '{}' } }],
            }),
          ),
        ),
      );
      await expect(new MetaProvider().generate(meta, context)).rejects.toThrow();
    },
  );
  it('does not leak provider failure bodies or fall back to local rules', async () => {
    vi.stubEnv('MODEL_API_KEY', 'test-only');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret upstream content', { status: 429 })),
    );
    await expect(new MetaProvider().generate(meta, context)).rejects.toThrow(
      'Provider request failed (429)',
    );
  });
  it('routes eligible Meta Muse models via OpenRouter when OPENROUTER_API_KEY is configured and rejects non-Muse models', async () => {
    vi.stubEnv('MODEL_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-test');
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: 'Meta',
          model: 'meta/muse-spark-1.3',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 12, completion_tokens: 24 },
        }),
      ),
    );
    vi.stubGlobal('fetch', mock);
    const result = await new MetaProvider().generate(meta, context);
    expect(mock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(mock.mock.calls[0][1].body).model).toBe('meta/muse-spark-1.3');
    expect(result.upstreamProvider).toBe('Meta');
    expect(result.model).toBe('meta/muse-spark-1.3');
    await expect(
      new MetaProvider().generate({ ...meta, model: 'gpt-5.5' }, context),
    ).rejects.toThrow('Meta Muse model');
  });
});
