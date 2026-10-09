import { z } from 'zod';

export const roles = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'] as const;
export type Role = (typeof roles)[number];
export const categories = [
  'CLIENT',
  'FRONTEND',
  'BACKEND',
  'DATABASE',
  'INFRASTRUCTURE',
  'MESSAGING',
  'STORAGE',
  'AUTH',
  'AI',
  'OBSERVABILITY',
  'EXTERNAL',
  'CUSTOM',
] as const;
export const catalog: Record<(typeof categories)[number], string[]> = {
  CLIENT: ['Web Application', 'Mobile Application', 'Desktop Application', 'Browser Extension'],
  FRONTEND: ['Next.js', 'React', 'Vue', 'Angular', 'Svelte', 'Custom Frontend'],
  BACKEND: [
    'REST API',
    'GraphQL API',
    'gRPC Service',
    'Microservice',
    'Monolith',
    'Serverless Function',
    'Background Worker',
  ],
  DATABASE: [
    'PostgreSQL',
    'MySQL',
    'MongoDB',
    'Redis',
    'Vector Database',
    'Elasticsearch',
    'Custom Database',
  ],
  INFRASTRUCTURE: [
    'Load Balancer',
    'Reverse Proxy',
    'API Gateway',
    'Docker',
    'Kubernetes',
    'Virtual Machine',
    'Container',
    'CDN',
  ],
  MESSAGING: ['Kafka', 'RabbitMQ', 'SQS', 'Pub/Sub', 'Event Bus'],
  STORAGE: ['S3', 'Blob Storage', 'File Storage'],
  AUTH: ['OAuth', 'OIDC', 'Auth Service', 'Identity Provider'],
  AI: ['LLM', 'Embedding Model', 'AI Agent', 'RAG Service', 'Vector Store', 'Model Gateway'],
  OBSERVABILITY: ['Logs', 'Metrics', 'Tracing', 'Monitoring', 'Alerting'],
  EXTERNAL: ['Stripe', 'GitHub', 'Vercel', 'AWS', 'Azure', 'GCP', 'External API'],
  CUSTOM: ['Custom Component'],
};
export const protocols = [
  'HTTPS',
  'HTTP',
  'REST',
  'GraphQL',
  'WebSocket',
  'gRPC',
  'TCP',
  'SQL',
  'Kafka Event',
  'RabbitMQ Message',
  'Redis',
  'Webhook',
  'OAuth',
  'File Transfer',
  'Internal RPC',
] as const;
const id = z.string().min(1).max(100);
export const componentSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(100),
    category: z.enum(categories),
    technology: z.string().max(100),
    description: z.string().max(4000),
    x: z.number().min(-100000).max(100000),
    y: z.number().min(-100000).max(100000),
    config: z.record(
      z.string().max(80),
      z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]),
    ),
  })
  .strict();
export const edgeSchema = z
  .object({
    id,
    source: id,
    target: id,
    protocol: z.enum(protocols),
    metadata: z.record(z.string().max(80), z.string().max(1000)),
  })
  .strict();
export const graphSchema = z
  .object({ components: z.array(componentSchema).max(500), edges: z.array(edgeSchema).max(1500) })
  .strict();
export type Component = z.infer<typeof componentSchema>;
export type Edge = z.infer<typeof edgeSchema>;
export type Graph = z.infer<typeof graphSchema>;
export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('component.upsert'), component: componentSchema }).strict(),
  z.object({ type: z.literal('component.delete'), id }).strict(),
  z.object({ type: z.literal('edge.upsert'), edge: edgeSchema }).strict(),
  z.object({ type: z.literal('edge.delete'), id }).strict(),
  z.object({ type: z.literal('graph.restore'), graph: graphSchema }).strict(),
]);
export type Mutation = z.infer<typeof mutationSchema>;
export const findingSchema = z
  .object({
    componentId: z.string().nullable(),
    category: z.enum([
      'Security',
      'Performance',
      'Reliability',
      'Scalability',
      'Maintainability',
      'Observability',
      'Testing',
    ]),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    confidence: z.number().min(0).max(1),
    title: z.string().min(1).max(180),
    description: z.string().max(4000),
    evidence: z.string().min(1).max(4000),
    impact: z.string().max(2000),
    recommendation: z.string().max(4000),
  })
  .strict();
// Model patches deliberately cannot delete entities or execute arbitrary code.
export const modelProposalSchema = z
  .object({
    componentId: z.string(),
    title: z.string().max(180),
    reason: z.string().max(4000),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    tradeoffs: z.string().max(2000),
    configKey: z.string().min(1).max(80),
    configValue: z.string().max(2000),
  })
  .strict();
// A structural proposal adds exactly one new component and connects it to existing ones.
// "NEW" refers to the proposed component. Removal stays a human-only operation.
export const NEW_COMPONENT = 'NEW';
export const modelAdditionSchema = z
  .object({
    title: z.string().min(1).max(180),
    reason: z.string().max(4000),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    tradeoffs: z.string().max(2000),
    component: z
      .object({
        name: z.string().trim().min(1).max(100),
        category: z.enum(categories),
        technology: z.string().min(1).max(100),
        description: z.string().max(2000),
      })
      .strict(),
    connections: z
      .array(
        z
          .object({
            from: z.string().max(100),
            to: z.string().max(100),
            protocol: z.enum(protocols),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type ModelAddition = z.infer<typeof modelAdditionSchema>;
export const agentOutputSchema = z
  .object({
    message: z.string().min(1).max(8000),
    findings: z.array(findingSchema).max(8),
    proposals: z.array(modelProposalSchema).max(4),
    additions: z.array(modelAdditionSchema).max(2),
    delegates: z
      .array(
        z
          .object({
            role: z.enum([
              'architect',
              'backend',
              'security',
              'database',
              'performance',
              'devops',
              'qa',
              'frontend',
            ]),
            question: z.string().max(1000),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export type AgentOutput = z.infer<typeof agentOutputSchema>;
/** Converts a validated addition into graph mutations, or returns an error explaining the rejection. */
export function additionMutations(
  graph: Graph,
  addition: ModelAddition,
  newId: string,
): { changes: Mutation[] } | { error: string } {
  const existing = new Map(graph.components.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const neighbors: Component[] = [];
  for (const c of addition.connections) {
    const fromNew = c.from === NEW_COMPONENT,
      toNew = c.to === NEW_COMPONENT;
    if (fromNew === toNew) return { error: 'Each connection must link the new component once.' };
    const other = existing.get(fromNew ? c.to : c.from);
    if (!other) return { error: 'A connection references a component outside the graph.' };
    const key = `${c.from}>${c.to}`;
    if (seen.has(key)) return { error: 'Duplicate proposed connection.' };
    seen.add(key);
    neighbors.push(other);
  }
  if (
    graph.components.some(
      (c) => c.name.trim().toLowerCase() === addition.component.name.trim().toLowerCase(),
    )
  )
    return { error: 'A component with this name already exists.' };
  // Place the component near its neighbors, then step aside until it does not overlap a card.
  let x = neighbors.reduce((n, c) => n + c.x, 0) / neighbors.length,
    y = neighbors.reduce((n, c) => n + c.y, 0) / neighbors.length + 170;
  for (
    let i = 0;
    i < 40 && graph.components.some((c) => Math.abs(c.x - x) < 240 && Math.abs(c.y - y) < 145);
    i++
  )
    y += 170;
  const changes: Mutation[] = [
    {
      type: 'component.upsert',
      component: {
        id: newId,
        ...addition.component,
        x: Math.round(x),
        y: Math.round(y),
        config: { proposedBy: 'agent' },
      },
    },
    ...addition.connections.map((c, i): Mutation => ({
      type: 'edge.upsert',
      edge: {
        id: `${newId}-edge-${i}`,
        source: c.from === NEW_COMPONENT ? newId : c.from,
        target: c.to === NEW_COMPONENT ? newId : c.to,
        protocol: c.protocol,
        metadata: {},
      },
    })),
  ];
  return { changes };
}
export type Finding = z.infer<typeof findingSchema> & {
  id: string;
  agent_id: string;
  component_id: string | null;
  status: string;
  created_at: string;
  agent_name?: string;
};
export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  provider: string;
  model: string;
  instructions: string;
  enabled: boolean;
  status: string;
  capabilities: string[];
  settings: Record<string, unknown>;
}
export interface Proposal {
  id: string;
  agent_name: string;
  agent_id?: string;
  run_id?: string | null;
  operations?: import('./operations').Operation[] | null;
  title: string;
  reason: string;
  risk: string;
  tradeoffs: string;
  status: string;
  changes: Mutation[];
  base_revision: number;
  created_at: string;
}
export interface Message {
  id: string;
  author_name: string;
  actor_type: string;
  content: string;
  created_at: string;
  agent_id?: string;
}
export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  environment: string;
  revision: number;
  role: Role;
  workspace_name: string;
}
export interface View {
  id: string;
  name: string;
  categories: string[];
}
export interface Activity {
  id: string;
  actor_name: string;
  action: string;
  detail: string;
  created_at: string;
}
export interface Presence {
  id: string;
  userId: string;
  name: string;
  selected: string | null;
  cursor?: { x: number; y: number };
}
export interface Snapshot {
  availableProviders?: { openai: boolean; anthropic: boolean; google: boolean };
  defaultModel?: string;
  project: Project;
  graph: Graph;
  views: View[];
  agents: Agent[];
  findings: Finding[];
  proposals: Proposal[];
  messages: Message[];
  activity: Activity[];
  members: { id: string; name: string; email: string; role: Role }[];
  versions: {
    id: string;
    revision: number;
    summary: string;
    created_at: string;
    actor_name: string;
    graph: Graph;
  }[];
  comments: {
    id: string;
    component_id: string;
    author_name: string;
    actor_type: 'human' | 'agent';
    content: string;
    resolved: boolean;
    created_at: string;
  }[];
  runs: {
    id: string;
    status: string;
    prompt: string;
    error: string | null;
    created_at: string;
    source?: string;
    conversation_id?: string | null;
    current_agent_id?: string | null;
    current_step?: string | null;
    input_tokens?: number;
    output_tokens?: number;
  }[];
  usage: {
    agent_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    estimated_cost: number | null;
    latency_ms: number;
    failed: boolean;
  }[];
}
export interface Notification {
  id: string;
  project_id: string;
  project_name: string;
  kind: string;
  title: string;
  body: string;
  page: string | null;
  component_id: string | null;
  actor_name: string | null;
  read_at: string | null;
  created_at: string;
}
export const penalty: Record<string, number> = {
  INFO: 0,
  LOW: 2,
  MEDIUM: 5,
  HIGH: 10,
  CRITICAL: 20,
};
export function health(findings: Pick<Finding, 'status' | 'severity' | 'category'>[]) {
  const active = findings.filter((f) => f.status === 'OPEN');
  return {
    score: Math.max(0, 100 - active.reduce((n, f) => n + penalty[f.severity], 0)),
    active: active.length,
    categories: [
      'Security',
      'Performance',
      'Reliability',
      'Scalability',
      'Maintainability',
      'Observability',
      'Testing',
    ].map((category) => ({
      category,
      score: Math.max(
        0,
        100 -
          active
            .filter((f) => f.category === category)
            .reduce((n, f) => n + penalty[f.severity], 0),
      ),
      findings: active.filter((f) => f.category === category),
    })),
  };
}

export interface ConversationSummary {
  id: string;
  title: string;
  kind: 'chat' | 'live_review';
  updated_at: string;
  created_by_name: string | null;
  message_count: number;
  preview: string | null;
  preview_author: string | null;
  active: boolean;
}
export interface ToolStep {
  id: string;
  run_id: string;
  agent_id: string;
  tool: string;
  operation: string;
  status: string;
  input_summary: string;
  result_summary: string;
  duration_ms: number;
  created_at: string;
}
export interface ConversationRun {
  id: string;
  status: string;
  source: string;
  error: string | null;
  current_agent_id: string | null;
  current_step: string | null;
  input_tokens: number;
  output_tokens: number;
  participant_ids: string[];
  created_at: string;
  finished_at: string | null;
}
export interface ConversationDetail {
  conversation: { id: string; title: string; kind: string; created_at: string };
  messages: (Message & { run_id: string | null; user_id: string | null; model: string | null })[];
  runs: ConversationRun[];
  steps: ToolStep[];
  proposals: (Proposal & { agent_id: string; run_id: string })[];
  findings: {
    id: string;
    run_id: string;
    agent_id: string;
    component_id: string | null;
    severity: string;
    category: string;
    title: string;
    status: string;
  }[];
  artifacts: {
    id: string;
    run_id: string;
    agent_id: string;
    title: string;
    kind: string;
    revision: number;
  }[];
}
export interface ArtifactSummary {
  id: string;
  title: string;
  kind: string;
  revision: number;
  updated_at: string;
  author_name: string | null;
  author_type: 'agent' | 'human';
  conversation_id: string | null;
  size: number;
}
