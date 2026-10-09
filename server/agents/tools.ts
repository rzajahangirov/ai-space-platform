import { z } from 'zod';
import type { DB } from '../db';
import { HttpError, uid, type Actor } from '../core';
import { readGraph } from '../graph';
export interface ToolStats {
  findings: number;
  severe: number;
  proposals: number;
  artifacts: number;
}
export interface ToolContext {
  db: DB;
  projectId: string;
  agentId: string;
  runId: string;
  actor?: Actor;
  agentName?: string;
  conversationId?: string | null;
  stats?: ToolStats;
  /** Queues another agent inside the same bounded run; returns a status for the model. */
  delegate?: (agent: string, question: string) => Promise<string>;
}
export interface ToolDefinition {
  name: string;
  /** Function name exposed to models (letters, digits, underscores). */
  functionName?: string;
  description: string;
  operation: 'read' | 'write';
  inputSchema: z.ZodType;
  execute: (context: ToolContext, input: any) => Promise<unknown>;
}
export function toolPolicy(
  grants: { tool: string; resource: string; operation: string; policy: string }[],
  tool: string,
  resource: string,
  operation: string,
) {
  return (
    grants.find((g) => g.tool === tool && g.resource === resource && g.operation === operation)
      ?.policy ?? 'DISABLED'
  );
}
// Providers support different JSON Schema subsets. Keep wire constraints portable;
// the complete original Zod schema remains authoritative when the tool executes.
export function portableSchema(value: unknown): any {
  if (Array.isArray(value)) return value.map(portableSchema);
  if (!value || typeof value !== 'object') return value;
  const constraints = new Set([
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'multipleOf',
    'pattern',
    'format',
  ]);
  const result: Record<string, unknown> = {};
  const descriptions: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (constraints.has(key)) descriptions.push(`${key}: ${child}`);
    else if (key === 'oneOf') result.anyOf = portableSchema(child);
    else if (key === 'const') result.enum = [child];
    else result[key] = portableSchema(child);
  }
  if (descriptions.length)
    result.description =
      `${result.description ?? ''} Required constraints: ${descriptions.join(', ')}.`.trim();
  return result;
}
const summarize = (value: unknown, max = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').length > max ? `${text.slice(0, max - 1)}…` : (text ?? '');
};
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) throw new Error('Tool already registered.');
    this.tools.set(tool.name, tool);
  }
  // MCP-compatible discovery descriptors. External transports must register explicit, scoped adapters.
  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema),
      annotations: { readOnlyHint: t.operation === 'read' },
    }));
  }
  /** Function tools an agent may call right now: only exact AUTO grants for this project. */
  async forAgent(db: DB, agentId: string, projectId: string) {
    const grants = await db.query<{
      tool: string;
      resource: string;
      operation: string;
      policy: string;
    }>('SELECT * FROM agent_tool_grants WHERE agent_id=$1', [agentId]);
    return [...this.tools.values()]
      .filter(
        (t) => t.functionName && toolPolicy(grants, t.name, projectId, t.operation) === 'AUTO',
      )
      .map((t) => ({
        name: t.functionName!,
        description: t.description,
        parameters: portableSchema(z.toJSONSchema(t.inputSchema)),
      }));
  }
  byFunction(functionName: string) {
    return [...this.tools.values()].find((t) => t.functionName === functionName);
  }
  async execute(name: string, resource: string, input: unknown, context: ToolContext) {
    const tool = this.tools.get(name);
    if (!tool) throw new HttpError(400, 'Unknown tool.');
    const [agent] = await context.db.query(
      'SELECT id FROM agents WHERE id=$1 AND project_id=$2 AND enabled=true',
      [context.agentId, context.projectId],
    );
    if (!agent || resource !== context.projectId)
      throw new HttpError(403, 'Tool resource is outside the agent project.');
    const grants = await context.db.query<{
      tool: string;
      resource: string;
      operation: string;
      policy: string;
    }>('SELECT * FROM agent_tool_grants WHERE agent_id=$1', [context.agentId]);
    const policy = toolPolicy(grants, name, resource, tool.operation),
      executionId = uid(),
      start = Date.now();
    await context.db.query(
      'INSERT INTO tool_executions(id,project_id,agent_id,run_id,tool,resource,operation,policy,status,input_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        executionId,
        context.projectId,
        context.agentId,
        context.runId,
        name,
        resource,
        tool.operation,
        policy,
        policy === 'AUTO' ? 'running' : 'denied',
        summarize(input),
      ],
    );
    // Approval-required tools fail closed. The MVP has no generic external-write approval executor.
    if (policy !== 'AUTO')
      throw new HttpError(
        403,
        policy === 'DISABLED'
          ? 'Tool access denied.'
          : 'This tool requires an approved execution workflow.',
      );
    try {
      const result = await tool.execute(context, tool.inputSchema.parse(input));
      const rejected =
        !!result && typeof result === 'object' && 'error' in (result as Record<string, unknown>);
      await context.db.query(
        'UPDATE tool_executions SET status=$1,duration_ms=$2,result_summary=$3 WHERE id=$4',
        [
          rejected ? 'rejected' : 'completed',
          Date.now() - start,
          summarize(result, 400),
          executionId,
        ],
      );
      return result;
    } catch (e) {
      await context.db.query(
        "UPDATE tool_executions SET status='failed',duration_ms=$1,result_summary=$2 WHERE id=$3",
        [
          Date.now() - start,
          e instanceof z.ZodError ? 'Invalid input' : 'Execution failed',
          executionId,
        ],
      );
      throw e;
    }
  }
}
export const registry = new ToolRegistry();
registry.register({
  name: 'project.graph.read',
  functionName: 'read_architecture',
  description:
    'Read the canonical architecture graph: components (id, name, category, technology, description, config) and connections. Call this before changing or reviewing a system.',
  operation: 'read',
  inputSchema: z.object({}).strict(),
  execute: (context) => readGraph(context.db, context.projectId),
});
