import { z } from 'zod';
import { hash, HttpError, uid } from '../core';
import { applyMutations, readGraph } from '../graph';
import { findingSchema } from '../../shared/domain';
import { proposalInputSchema } from '../../shared/operations';
import { operationsToMutations } from '../../shared/operations';
import { registry } from './tools';

const clip = (value: string | null | undefined, max: number) =>
  !value ? '' : value.length > max ? `${value.slice(0, max - 1)}…` : value;

registry.register({
  name: 'project.component.read',
  functionName: 'inspect_component',
  description:
    'Inspect one component: full configuration, incoming and outgoing connections, open findings, and recent comments.',
  operation: 'read',
  inputSchema: z.object({ componentId: z.string().min(1).max(100) }).strict(),
  async execute({ db, projectId }, { componentId }) {
    const graph = await readGraph(db, projectId);
    const component = graph.components.find((c) => c.id === componentId);
    if (!component) return { error: `No component with id "${componentId}".` };
    const name = (id: string) => graph.components.find((c) => c.id === id)?.name ?? id;
    return {
      component,
      outgoing: graph.edges
        .filter((e) => e.source === componentId)
        .map((e) => ({
          connectionId: e.id,
          to: e.target,
          toName: name(e.target),
          protocol: e.protocol,
          metadata: e.metadata,
        })),
      incoming: graph.edges
        .filter((e) => e.target === componentId)
        .map((e) => ({
          connectionId: e.id,
          from: e.source,
          fromName: name(e.source),
          protocol: e.protocol,
          metadata: e.metadata,
        })),
      openFindings: await db.query(
        "SELECT id,severity,category,title,recommendation FROM findings WHERE project_id=$1 AND component_id=$2 AND status='OPEN' ORDER BY created_at DESC LIMIT 10",
        [projectId, componentId],
      ),
      recentComments: await db.query(
        `SELECT COALESCE(u.name,a.name) AS author,left(c.content,500) AS content FROM comments c
         LEFT JOIN users u ON u.id=c.user_id LEFT JOIN agents a ON a.id=c.agent_id
         WHERE c.project_id=$1 AND c.component_id=$2 ORDER BY c.created_at DESC LIMIT 5`,
        [projectId, componentId],
      ),
    };
  },
});

registry.register({
  name: 'project.search',
  functionName: 'search_project',
  description:
    'Search this project: components, findings, proposals/decisions, knowledge documents, artifacts, and conversation history. Use short keywords.',
  operation: 'read',
  inputSchema: z.object({ query: z.string().trim().min(2).max(120) }).strict(),
  async execute({ db, projectId }, { query }) {
    // Each source is filtered by project id first; the pattern is a bound parameter.
    const like = `%${query.replace(/[%_\\]/g, (c: string) => `\\${c}`)}%`;
    const p = [projectId, like];
    return {
      components: await db.query(
        'SELECT id,name,category,technology FROM components WHERE project_id=$1 AND (name ILIKE $2 OR technology ILIKE $2 OR description ILIKE $2 OR config::text ILIKE $2) LIMIT 8',
        p,
      ),
      findings: await db.query(
        'SELECT id,component_id,severity,status,title FROM findings WHERE project_id=$1 AND (title ILIKE $2 OR description ILIKE $2 OR recommendation ILIKE $2) ORDER BY created_at DESC LIMIT 6',
        p,
      ),
      decisions: await db.query(
        'SELECT id,status,title,left(reason,240) AS reason FROM proposals WHERE project_id=$1 AND (title ILIKE $2 OR reason ILIKE $2) ORDER BY created_at DESC LIMIT 6',
        p,
      ),
      knowledge: (
        await db.query(
          'SELECT id,title,kind,content FROM knowledge_sources WHERE project_id=$1 AND (title ILIKE $2 OR content ILIKE $2) ORDER BY created_at DESC LIMIT 4',
          p,
        )
      ).map((k) => ({ ...k, content: clip(k.content, 1200) })),
      artifacts: (
        await db.query(
          'SELECT id,title,kind,revision,content FROM artifacts WHERE project_id=$1 AND (title ILIKE $2 OR content ILIKE $2) ORDER BY updated_at DESC LIMIT 5',
          p,
        )
      ).map((a) => ({ ...a, content: clip(a.content, 600) })),
      messages: await db.query(
        'SELECT author_name,left(content,300) AS content,created_at FROM messages WHERE project_id=$1 AND content ILIKE $2 ORDER BY created_at DESC LIMIT 6',
        p,
      ),
    };
  },
});

registry.register({
  name: 'artifact.read',
  functionName: 'read_artifact',
  description: 'Read the full content of a project artifact (document) by id.',
  operation: 'read',
  inputSchema: z.object({ artifactId: z.string().min(1).max(100) }).strict(),
  async execute({ db, projectId }, { artifactId }) {
    const [artifact] = await db.query(
      'SELECT id,title,kind,revision,left(content,20000) AS content,updated_at FROM artifacts WHERE project_id=$1 AND id=$2',
      [projectId, artifactId],
    );
    return artifact ?? { error: `No artifact with id "${artifactId}".` };
  },
});

registry.register({
  name: 'architecture.propose',
  functionName: 'propose_change',
  description: [
    'Propose a change to the architecture. Nothing is applied until a human approves it.',
    'Use one proposal per coherent intent; to design a new system, put every component and connection in a single proposal.',
    'add_component needs a unique "ref" that add_connection can use as from/to. Existing components are addressed by id (from read_architecture).',
    'update_component: null fields stay unchanged; a config entry with value null removes that key.',
    'If the result contains "error", fix the operations and call again.',
  ].join(' '),
  operation: 'write',
  inputSchema: proposalInputSchema,
  async execute({ db, projectId, agentId, runId, stats }, input) {
    if (
      (
        await db.query(
          "SELECT id FROM proposals WHERE project_id=$1 AND title=$2 AND status='PENDING'",
          [projectId, input.title],
        )
      ).length
    )
      return { error: 'A pending proposal with this title already exists. Do not duplicate it.' };
    const [project] = await db.query<{ revision: number }>(
      'SELECT revision FROM projects WHERE id=$1',
      [projectId],
    );
    const graph = await readGraph(db, projectId);
    const built = operationsToMutations(graph, input.operations, uid);
    if ('error' in built) return { error: built.error };
    try {
      applyMutations(graph, built.changes);
    } catch (e) {
      return {
        error: e instanceof HttpError || e instanceof Error ? e.message : 'Invalid change.',
      };
    }
    const id = uid();
    await db.query(
      'INSERT INTO proposals(id,project_id,agent_id,title,reason,risk,tradeoffs,changes,operations,base_revision,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        projectId,
        agentId,
        input.title,
        input.reason,
        input.risk,
        input.tradeoffs,
        JSON.stringify(built.changes),
        JSON.stringify(input.operations),
        project.revision,
        runId,
      ],
    );
    if (stats) stats.proposals++;
    return {
      proposalId: id,
      status: 'PENDING_HUMAN_APPROVAL',
      changes: built.summary,
      note: 'Say that you proposed this change; it is not applied until a human approves it.',
    };
  },
});

registry.register({
  name: 'finding.record',
  functionName: 'record_finding',
  description:
    'Record a concrete engineering finding (risk, gap, or defect) backed by evidence from the project. Confidence below 0.65 is not stored.',
  operation: 'write',
  inputSchema: findingSchema,
  async execute({ db, projectId, agentId, runId, stats }, f) {
    if (f.confidence < 0.65)
      return { error: 'Confidence is below 0.65; gather more evidence first.' };
    if (
      f.componentId &&
      !(
        await db.query('SELECT id FROM components WHERE project_id=$1 AND id=$2', [
          projectId,
          f.componentId,
        ])
      ).length
    )
      return {
        error: `No component with id "${f.componentId}". Use null for system-wide findings.`,
      };
    const [row] = await db.query<{ id: string; inserted: boolean; severity: string }>(
      `INSERT INTO findings(id,project_id,agent_id,component_id,category,severity,confidence,title,description,evidence,impact,recommendation,fingerprint,run_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(project_id,fingerprint) DO UPDATE SET evidence=excluded.evidence,confidence=excluded.confidence
       RETURNING id,(xmax = 0) AS inserted,severity`,
      [
        uid(),
        projectId,
        agentId,
        f.componentId,
        f.category,
        f.severity,
        f.confidence,
        f.title,
        f.description,
        f.evidence,
        f.impact,
        f.recommendation,
        hash(`${f.componentId}:${f.category}:${f.title.toLowerCase()}`),
        runId,
      ],
    );
    if (row.inserted && stats) {
      stats.findings++;
      if (['HIGH', 'CRITICAL'].includes(row.severity)) stats.severe++;
    }
    return { findingId: row.id, duplicate: !row.inserted };
  },
});

registry.register({
  name: 'artifact.write',
  functionName: 'write_artifact',
  description:
    'Create (artifactId null) or replace (existing artifactId) a Markdown document in the project: reviews, plans, API specs, runbooks, ADRs, reports. Keep chat replies short and point to the artifact.',
  operation: 'write',
  inputSchema: z
    .object({
      artifactId: z.string().max(100).nullable(),
      title: z.string().trim().min(1).max(160),
      kind: z.enum(['document', 'review', 'plan', 'api_spec', 'runbook', 'report', 'adr']),
      content: z.string().min(1).max(60000),
    })
    .strict(),
  async execute({ db, projectId, agentId, runId, conversationId, stats }, input) {
    if (input.artifactId) {
      const [updated] = await db.query(
        'UPDATE artifacts SET title=$1,kind=$2,content=$3,revision=revision+1,agent_id=$4,user_id=NULL,run_id=$5,updated_at=now() WHERE id=$6 AND project_id=$7 RETURNING id,revision',
        [input.title, input.kind, input.content, agentId, runId, input.artifactId, projectId],
      );
      if (!updated) return { error: `No artifact with id "${input.artifactId}".` };
      if (stats) stats.artifacts++;
      return { artifactId: updated.id, revision: updated.revision };
    }
    const id = uid();
    await db.query(
      'INSERT INTO artifacts(id,project_id,conversation_id,title,kind,content,agent_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        projectId,
        conversationId ?? null,
        input.title,
        input.kind,
        input.content,
        agentId,
        runId,
      ],
    );
    if (stats) stats.artifacts++;
    return { artifactId: id, revision: 1 };
  },
});

registry.register({
  name: 'agent.ask',
  functionName: 'ask_agent',
  description:
    'Ask another specialist agent (by name or role, e.g. "security", "Database Engineer") a concrete question. They answer in this conversation after you finish. Use sparingly.',
  operation: 'write',
  inputSchema: z
    .object({
      agent: z.string().trim().min(2).max(80),
      question: z.string().trim().min(5).max(1500),
    })
    .strict(),
  async execute({ delegate }, { agent, question }) {
    if (!delegate) return { error: 'Delegation is not available in this context.' };
    return { status: await delegate(agent, question) };
  },
});

export const standardTools = [
  ['project.graph.read', 'read'],
  ['project.component.read', 'read'],
  ['project.search', 'read'],
  ['artifact.read', 'read'],
  ['architecture.propose', 'write'],
  ['finding.record', 'write'],
  ['artifact.write', 'write'],
  ['agent.ask', 'write'],
] as const;
