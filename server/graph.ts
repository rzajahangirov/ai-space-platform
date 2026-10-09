import type { DB } from './db';
import { uid, HttpError, audit, emit, authorize, type Actor } from './core';
import {
  graphSchema,
  mutationSchema,
  type Component,
  type Edge,
  type Graph,
  type Mutation,
} from '../shared/domain';
import { operationsToMutations } from '../shared/operations';
export async function readGraph(db: DB, projectId: string): Promise<Graph> {
  const components = await db.query<Component>(
    'SELECT id,name,category,technology,description,x,y,config FROM components WHERE project_id=$1 ORDER BY id',
    [projectId],
  );
  const edges = await db.query<Edge>(
    'SELECT id,source,target,protocol,metadata FROM edges WHERE project_id=$1 ORDER BY id',
    [projectId],
  );
  return { components, edges };
}
export function applyMutations(current: Graph, mutations: Mutation[]): Graph {
  let graph = structuredClone(current);
  for (const raw of mutations) {
    const change = mutationSchema.parse(raw);
    if (change.type === 'graph.restore') graph = structuredClone(change.graph);
    if (change.type === 'component.upsert') {
      graph.components = graph.components.filter((n) => n.id !== change.component.id);
      graph.components.push(change.component);
    }
    if (change.type === 'component.delete') {
      graph.components = graph.components.filter((n) => n.id !== change.id);
      graph.edges = graph.edges.filter((e) => e.source !== change.id && e.target !== change.id);
    }
    if (change.type === 'edge.upsert') {
      graph.edges = graph.edges.filter((e) => e.id !== change.edge.id);
      graph.edges.push(change.edge);
    }
    if (change.type === 'edge.delete') graph.edges = graph.edges.filter((e) => e.id !== change.id);
  }
  graphSchema.parse(graph);
  const ids = new Set(graph.components.map((c) => c.id));
  if (
    ids.size !== graph.components.length ||
    new Set(graph.edges.map((e) => e.id)).size !== graph.edges.length
  )
    throw new HttpError(400, 'Duplicate graph identifiers.');
  if (graph.edges.some((e) => !ids.has(e.source) || !ids.has(e.target) || e.source === e.target))
    throw new HttpError(400, 'Every connection must link two distinct components in this project.');
  return graph;
}
export async function persistGraph(db: DB, projectId: string, graph: Graph) {
  // Upsert first: preserve comments and mappings on surviving components.
  await db.query('DELETE FROM edges WHERE project_id=$1', [projectId]);
  await db.query('DELETE FROM components WHERE project_id=$1 AND NOT(id=ANY($2::text[]))', [
    projectId,
    graph.components.map((c) => c.id),
  ]);
  for (const c of graph.components)
    await db.query(
      `INSERT INTO components(id,project_id,name,category,technology,description,x,y,config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(project_id,id) DO UPDATE SET name=excluded.name,category=excluded.category,technology=excluded.technology,description=excluded.description,x=excluded.x,y=excluded.y,config=excluded.config`,
      [
        c.id,
        projectId,
        c.name,
        c.category,
        c.technology,
        c.description,
        c.x,
        c.y,
        JSON.stringify(c.config),
      ],
    );
  for (const e of graph.edges)
    await db.query(
      'INSERT INTO edges(id,project_id,source,target,protocol,metadata) VALUES($1,$2,$3,$4,$5,$6)',
      [e.id, projectId, e.source, e.target, e.protocol, JSON.stringify(e.metadata)],
    );
}
export async function commitGraph(
  tx: DB,
  projectId: string,
  actor: Actor,
  revision: number,
  changes: Mutation[],
  summary: string,
  source = 'human',
) {
  const [project] = await tx.query('SELECT revision FROM projects WHERE id=$1 FOR UPDATE', [
    projectId,
  ]);
  if (!project) throw new HttpError(404, 'Project not found.');
  if (project.revision !== revision)
    throw new HttpError(
      409,
      'The architecture changed. Refresh and review the latest version before trying again.',
    );
  const before = await readGraph(tx, projectId);
  const after = applyMutations(before, changes);
  await persistGraph(tx, projectId, after);
  await tx.query('UPDATE projects SET revision=revision+1 WHERE id=$1', [projectId]);
  await tx.query(
    'INSERT INTO architecture_versions(id,project_id,revision,graph,summary,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [uid(), projectId, revision + 1, JSON.stringify(after), summary, actor.id],
  );
  await audit(tx, projectId, actor, 'architecture.changed', summary, {
    revision: revision + 1,
    changes,
  });
  // Moving cards is not an architectural change; live reviews only react to structural edits.
  const strip = ({ x: _x, y: _y, ...rest }: Graph['components'][number]) => JSON.stringify(rest);
  const structural =
    before.edges.length !== after.edges.length ||
    JSON.stringify(before.edges) !== JSON.stringify(after.edges) ||
    before.components.length !== after.components.length ||
    after.components.some((c) => {
      const old = before.components.find((b) => b.id === c.id);
      return !old || strip(old) !== strip(c);
    });
  await emit(tx, projectId, 'ARCHITECTURE_CHANGED', {
    actorId: actor.id,
    source,
    structural,
    revision: revision + 1,
    componentIds: changes.flatMap((c) =>
      c.type === 'component.upsert'
        ? [c.component.id]
        : c.type === 'component.delete'
          ? [c.id]
          : [],
    ),
  });
  return { before, after, revision: revision + 1 };
}
export async function mutateGraph(
  db: DB,
  projectId: string,
  actor: Actor,
  revision: number,
  changes: Mutation[],
  summary: string,
) {
  return db.transaction(async (tx) => {
    await authorize(tx, actor, projectId, 'edit');
    return commitGraph(tx, projectId, actor, revision, changes, summary);
  });
}
export async function decideProposal(
  db: DB,
  projectId: string,
  proposalId: string,
  actor: Actor,
  decision: 'APPROVED' | 'REJECTED',
) {
  return db.transaction(async (tx) => {
    await authorize(tx, actor, projectId, 'approve');
    // Consistent lock order: project, then proposal.
    await tx.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const [proposal] = await tx.query(
      'SELECT * FROM proposals WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [proposalId, projectId],
    );
    if (!proposal) throw new HttpError(404, 'Proposal not found.');
    if (proposal.status !== 'PENDING')
      throw new HttpError(409, 'This proposal has already been decided.');
    let states: { before: Graph; after: Graph } | undefined;
    if (decision === 'APPROVED') {
      const [project] = await tx.query<{ revision: number }>(
        'SELECT revision FROM projects WHERE id=$1',
        [projectId],
      );
      let changes: Mutation[] = proposal.changes,
        base: number = proposal.base_revision;
      // Semantic operations can be re-validated on a newer graph; raw patches cannot.
      if (proposal.operations && base !== project.revision) {
        const rebuilt = operationsToMutations(
          await readGraph(tx, projectId),
          proposal.operations,
          uid,
        );
        if ('error' in rebuilt)
          throw new HttpError(
            409,
            `The architecture changed and this proposal no longer applies: ${rebuilt.error}`,
          );
        changes = rebuilt.changes;
        base = project.revision;
      }
      states = await commitGraph(
        tx,
        projectId,
        actor,
        base,
        changes,
        `Approved: ${proposal.title}`,
        'proposal',
      );
    }
    await tx.query(
      'UPDATE proposals SET status=$1,decided_by=$2,decided_at=now(),before_state=$3,after_state=$4 WHERE id=$5',
      [
        decision,
        actor.id,
        states ? JSON.stringify(states.before) : null,
        states ? JSON.stringify(states.after) : null,
        proposalId,
      ],
    );
    await audit(tx, projectId, actor, `proposal.${decision.toLowerCase()}`, proposal.title, {
      proposalId,
    });
    await emit(tx, projectId, 'PROPOSAL_DECIDED', { proposalId, decision });
    return { status: decision };
  });
}
