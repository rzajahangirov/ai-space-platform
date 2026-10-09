// Tool-calling ("agentic") model adapters. A step sends the transcript and tools and returns either
// tool calls or final text. Provider-specific output items are replayed verbatim on the next step.
import { CachedAgenticProvider } from './cache';

export interface FunctionTool {
  name: string;
  description: string;
  parameters: unknown;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface AgentStep {
  text: string;
  calls: ToolCall[];
  replay: unknown[];
  inputTokens: number;
  outputTokens: number;
}
export interface StepRequest {
  model: string;
  instructions: string;
  input: unknown[];
  tools: FunctionTool[];
  /** When true the model must answer in text (used for the last allowed step). */
  finalOnly?: boolean;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
}
export interface AgenticProvider {
  step(request: StepRequest): Promise<AgentStep>;
  toolResult(call: ToolCall, output: unknown): unknown;
  userMessage(text: string): unknown;
}

const reasoningModel = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model);

export class OpenAIAgenticProvider implements AgenticProvider {
  constructor(private fetchImpl: typeof fetch = (...args) => fetch(...args)) {}
  userMessage(text: string) {
    return { role: 'user', content: text };
  }
  toolResult(call: ToolCall, output: unknown) {
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    return { type: 'function_call_output', call_id: call.id, output: text.slice(0, 24000) };
  }
  async step(request: StepRequest): Promise<AgentStep> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not configured on the server.');
    const reasoning = reasoningModel(request.model);
    const response = await this.fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        tools: request.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: true,
        })),
        tool_choice: request.finalOnly ? 'none' : 'auto',
        max_output_tokens: request.maxOutputTokens ?? 8000,
        // Project content is not retained by the provider; reasoning state travels encrypted.
        store: false,
        ...(reasoning
          ? {
              reasoning: { effort: request.reasoningEffort ?? 'low' },
              include: ['reasoning.encrypted_content'],
            }
          : {}),
      }),
      signal: AbortSignal.timeout(120000),
    });
    // Never echo provider response bodies: they may contain submitted project content.
    if (!response.ok) {
      let code = '';
      try {
        code = ((await response.json()) as any)?.error?.code ?? '';
      } catch {
        /* ignore */
      }
      throw new Error(
        `OpenAI request failed (${response.status}${code ? `, ${code}` : ''}). Check the model id, API key, and limits.`,
      );
    }
    const data = (await response.json()) as any;
    const output: any[] = data.output ?? [];
    const calls = output
      .filter((o) => o.type === 'function_call')
      .map((o) => ({ id: o.call_id, name: o.name, arguments: o.arguments ?? '{}' }));
    const text = output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c: any) => c.type === 'output_text')
      .map((c: any) => c.text)
      .join('');
    if (data.status === 'incomplete' && !calls.length && !text)
      throw new Error('The model ran out of output tokens before answering.');
    return {
      text,
      calls,
      replay: output,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }
}

const agentic: Record<string, AgenticProvider> = { openai: new OpenAIAgenticProvider() };
export function agenticProviderFor(name: string): AgenticProvider | undefined {
  return agentic[name] && new CachedAgenticProvider(name, agentic[name]);
}
/** Test hook: replace an adapter (e.g. with a scripted fake). */
export function setAgenticProvider(name: string, provider: AgenticProvider | undefined) {
  if (provider) agentic[name] = provider;
  else delete agentic[name];
}
