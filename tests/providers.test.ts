import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  OpenAIProvider,
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
