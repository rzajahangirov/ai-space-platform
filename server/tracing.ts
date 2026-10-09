// LangSmith tracing. Enabled when LANGSMITH_TRACING=true and LANGSMITH_API_KEY is set (LANGSMITH_ENDPOINT
// and LANGSMITH_PROJECT are read by the SDK). Tracing is best-effort: a LangSmith outage never fails a
// review. Inputs are truncated so whole documents are not copied into the trace store.
import { Client } from 'langsmith';
import { RunTree } from 'langsmith/run_trees';

export const tracingEnabled = () =>
  ['true', '1'].includes(String(process.env.LANGSMITH_TRACING).toLowerCase()) &&
  Boolean(process.env.LANGSMITH_API_KEY);

let client: Client | undefined;
const getClient = () => (client ??= new Client());

const MAX = 4000;
export function clip(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > MAX ? `${value.slice(0, MAX)}… [truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(clip);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  return value;
}

/** A trace span. All methods are no-ops when tracing is disabled or LangSmith is unreachable. */
export class Span {
  private constructor(private run?: RunTree) {}
  static async root(
    name: string,
    inputs: Record<string, unknown>,
    meta: Record<string, unknown> = {},
    tags: string[] = [],
    runType: 'chain' | 'llm' = 'chain',
  ) {
    if (!tracingEnabled()) return new Span();
    try {
      const run = new RunTree({
        name,
        run_type: runType,
        inputs: clip(inputs) as Record<string, unknown>,
        metadata: meta,
        tags,
        client: getClient(),
        project_name: process.env.LANGSMITH_PROJECT || 'agentspace',
      });
      await run.postRun();
      return new Span(run);
    } catch {
      return new Span();
    }
  }
  get id() {
    return this.run?.id;
  }
  async child(
    name: string,
    runType: 'chain' | 'llm' | 'retriever' | 'tool',
    inputs: Record<string, unknown>,
    meta: Record<string, unknown> = {},
    tags: string[] = [],
  ) {
    if (!this.run) return new Span();
    try {
      const run = this.run.createChild({
        name,
        run_type: runType,
        inputs: clip(inputs) as Record<string, unknown>,
        metadata: meta,
        tags,
      });
      await run.postRun();
      return new Span(run);
    } catch {
      return new Span();
    }
  }
  async end(outputs: Record<string, unknown> = {}, error?: string) {
    if (!this.run) return;
    try {
      await this.run.end(clip(outputs) as Record<string, unknown>, error);
      await this.run.patchRun();
    } catch {
      /* best effort */
    }
  }
}

/** Usage block LangSmith recognizes on llm runs (token counts and cost columns). */
export const usage = (input: number, output: number) => ({
  usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
});

/** Link to the trace in the LangSmith UI, or undefined when it cannot be resolved. */
export async function traceUrl(span: Span) {
  if (!client || !span.id) return undefined;
  try {
    return await client.getRunUrl({
      runId: span.id,
      projectOpts: { projectName: process.env.LANGSMITH_PROJECT || 'agentspace' },
    });
  } catch {
    return undefined;
  }
}

export async function flushTraces() {
  if (!client) return;
  try {
    await client.awaitPendingTraceBatches();
  } catch {
    /* best effort */
  }
}

/** Trace one standalone model call (used by the regular agent runtime providers). */
export async function traceLLM<T extends { inputTokens: number; outputTokens: number }>(
  name: string,
  meta: Record<string, unknown>,
  inputs: Record<string, unknown>,
  fn: () => Promise<T>,
  outputs: (r: T) => Record<string, unknown>,
): Promise<T> {
  if (!tracingEnabled()) return fn();
  const span = await Span.root(name, inputs, meta, ['agent-runtime'], 'llm');
  try {
    const result = await fn();
    await span.end({ ...outputs(result), ...usage(result.inputTokens, result.outputTokens) });
    return result;
  } catch (e) {
    await span.end({}, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
