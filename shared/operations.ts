import { z } from 'zod';
import { categories, protocols, type Component, type Graph, type Mutation } from './domain';

// Strict-mode friendly: every field is required; "optional" means nullable. Config is a list of
// key/value pairs because structured-output schemas cannot express open-ended records.
const configEntry = z
  .object({ key: z.string().min(1).max(80), value: z.string().max(2000) })
  .strict();
const configPatch = z
  .object({ key: z.string().min(1).max(80), value: z.string().max(2000).nullable() })
  .strict();
export const operationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add_component'),
      ref: z.string().min(1).max(60),
      name: z.string().trim().min(1).max(100),
      category: z.enum(categories),
      technology: z.string().trim().min(1).max(100),
      description: z.string().max(2000),
      config: z.array(configEntry).max(20),
    })
    .strict(),
  z
    .object({
      op: z.literal('update_component'),
      componentId: z.string().min(1).max(100),
      name: z.string().trim().min(1).max(100).nullable(),
      technology: z.string().trim().min(1).max(100).nullable(),
      description: z.string().max(2000).nullable(),
      config: z.array(configPatch).max(20),
    })
    .strict(),
  z.object({ op: z.literal('remove_component'), componentId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      op: z.literal('add_connection'),
      from: z.string().min(1).max(100),
      to: z.string().min(1).max(100),
      protocol: z.enum(protocols),
      description: z.string().max(500),
    })
    .strict(),
  z
    .object({ op: z.literal('remove_connection'), connectionId: z.string().min(1).max(100) })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const proposalInputSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    reason: z.string().min(1).max(4000),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    tradeoffs: z.string().max(2000),
    operations: z.array(operationSchema).min(1).max(60),
  })
  .strict();
export type ProposalInput = z.infer<typeof proposalInputSchema>;

const coerce = (value: string): string | number | boolean => {
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value) && value.length < 16) return Number(value);
  return value;
};
const CARD_W = 240,
  CARD_H = 145,
  COL = 300,
  ROW = 170;
const overlaps = (graph: Component[], x: number, y: number) =>
  graph.some((c) => Math.abs(c.x - x) < CARD_W && Math.abs(c.y - y) < CARD_H);

/** Places new components: next to existing neighbors when connected, otherwise in layered columns. */
function layout(existing: Component[], added: Component[], edges: Graph['edges']) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const placed: Component[] = [...existing];
  const loose: Component[] = [];
  for (const c of added) {
    const anchors = edges
      .filter((e) => e.source === c.id || e.target === c.id)
      .map((e) => byId.get(e.source === c.id ? e.target : e.source))
      .filter((n): n is Component => !!n);
    if (!anchors.length || !existing.length) {
      loose.push(c);
      continue;
    }
    let x = Math.round(anchors.reduce((n, a) => n + a.x, 0) / anchors.length + COL),
      y = Math.round(anchors.reduce((n, a) => n + a.y, 0) / anchors.length);
    for (let i = 0; i < 60 && overlaps(placed, x, y); i++) y += ROW;
    c.x = x;
    c.y = y;
    placed.push(c);
    byId.set(c.id, c);
  }
  if (!loose.length) return;
  // Longest-path layering over edges among the loose components (bounded; cycles are tolerated).
  const looseIds = new Set(loose.map((c) => c.id));
  const layer = new Map(loose.map((c) => [c.id, 0]));
  const internal = edges.filter((e) => looseIds.has(e.source) && looseIds.has(e.target));
  for (let i = 0; i < loose.length; i++)
    for (const e of internal)
      if (layer.get(e.target)! < layer.get(e.source)! + 1 && layer.get(e.source)! < loose.length)
        layer.set(e.target, layer.get(e.source)! + 1);
  const order = [...categories];
  const columns = new Map<number, Component[]>();
  for (const c of loose) {
    const l = layer.get(c.id)!;
    columns.set(l, [...(columns.get(l) ?? []), c]);
  }
  const left = existing.length ? Math.max(...existing.map((c) => c.x)) + COL * 1.5 : 0;
  const top = existing.length ? Math.min(...existing.map((c) => c.y)) : 0;
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  for (const [l, column] of columns) {
    column.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    const offset = ((tallest - column.length) * ROW) / 2;
    column.forEach((c, i) => {
      c.x = Math.round(left + l * COL);
      c.y = Math.round(top + offset + i * ROW);
    });
  }
}

export type OperationsResult = { changes: Mutation[]; summary: string[] } | { error: string };

/**
 * Converts semantic operations into validated graph mutations. Errors are written for the model:
 * they say what to fix, so an agent can correct its own proposal.
 */
export function operationsToMutations(
  graph: Graph,
  operations: Operation[],
  makeId: () => string,
): OperationsResult {
  const components = new Map(graph.components.map((c) => [c.id, structuredClone(c)]));
  const edges = new Map(graph.edges.map((e) => [e.id, structuredClone(e)]));
  const refs = new Map<string, string>();
  const added: Component[] = [];
  const touched = new Set<string>(),
    removedComponents = new Set<string>(),
    removedEdges = new Set<string>(),
    addedEdges: string[] = [];
  const summary: string[] = [];
  const nameTaken = (name: string, except?: string) =>
    [...components.values()].find(
      (c) => c.id !== except && c.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  for (const op of operations) {
    if (op.op !== 'add_component') continue;
    if (refs.has(op.ref))
      return { error: `Duplicate ref "${op.ref}". Each new component needs a unique ref.` };
    const clash = nameTaken(op.name);
    if (clash)
      return {
        error: `A component named "${op.name}" already exists (id "${clash.id}"). Connect to or update it instead of adding a duplicate.`,
      };
    const id = makeId();
    refs.set(op.ref, id);
    const component: Component = {
      id,
      name: op.name,
      category: op.category,
      technology: op.technology,
      description: op.description,
      x: 0,
      y: 0,
      config: Object.fromEntries(op.config.map((e) => [e.key, coerce(e.value)])),
    };
    components.set(id, component);
    added.push(component);
    summary.push(`+ ${op.name} (${op.technology})`);
  }
  const resolve = (value: string) => {
    if (refs.has(value)) return refs.get(value)!;
    if (components.has(value)) return value;
    const byName = [...components.values()].filter(
      (c) => c.name.trim().toLowerCase() === value.trim().toLowerCase(),
    );
    return byName.length === 1 ? byName[0].id : undefined;
  };
  const label = (id: string) => components.get(id)?.name ?? id;
  for (const op of operations) {
    if (op.op === 'update_component') {
      const component = components.get(op.componentId);
      if (!component)
        return {
          error: `update_component: no component with id "${op.componentId}". Use ids from read_architecture.`,
        };
      if (op.name && nameTaken(op.name, component.id))
        return { error: `update_component: another component is already named "${op.name}".` };
      if (op.name) component.name = op.name;
      if (op.technology) component.technology = op.technology;
      if (op.description !== null) component.description = op.description;
      for (const entry of op.config)
        if (entry.value === null) delete component.config[entry.key];
        else component.config[entry.key] = coerce(entry.value);
      touched.add(component.id);
      summary.push(`~ ${component.name}`);
    }
    if (op.op === 'remove_component') {
      const component = components.get(op.componentId);
      if (!component || added.some((a) => a.id === op.componentId))
        return { error: `remove_component: no existing component with id "${op.componentId}".` };
      components.delete(component.id);
      removedComponents.add(component.id);
      for (const [id, e] of edges)
        if (e.source === component.id || e.target === component.id) edges.delete(id);
      summary.push(`− ${component.name}`);
    }
    if (op.op === 'remove_connection') {
      const edge = edges.get(op.connectionId);
      if (!edge) return { error: `remove_connection: no connection with id "${op.connectionId}".` };
      edges.delete(edge.id);
      removedEdges.add(edge.id);
      summary.push(`− ${label(edge.source)} → ${label(edge.target)}`);
    }
    if (op.op === 'add_connection') {
      const source = resolve(op.from),
        target = resolve(op.to);
      if (!source || !target)
        return {
          error: `add_connection: cannot resolve "${!source ? op.from : op.to}". Use a component id, a ref from add_component, or an exact unique name.`,
        };
      if (source === target)
        return { error: 'add_connection: a component cannot connect to itself.' };
      if (
        [...edges.values()].some(
          (e) => e.source === source && e.target === target && e.protocol === op.protocol,
        )
      )
        continue;
      const id = makeId();
      edges.set(id, {
        id,
        source,
        target,
        protocol: op.protocol,
        metadata: op.description ? { description: op.description } : {},
      });
      addedEdges.push(id);
      summary.push(`+ ${label(source)} → ${label(target)} (${op.protocol})`);
    }
  }
  if (components.size > 500) return { error: 'The architecture would exceed 500 components.' };
  layout(
    graph.components.filter((c) => components.has(c.id)),
    added,
    [...edges.values()],
  );
  const changes: Mutation[] = [
    ...[...removedComponents].map((id): Mutation => ({ type: 'component.delete', id })),
    ...[...removedEdges].map((id): Mutation => ({ type: 'edge.delete', id })),
    ...added.map((component): Mutation => ({ type: 'component.upsert', component })),
    ...[...touched]
      .filter((id) => components.has(id))
      .map((id): Mutation => ({ type: 'component.upsert', component: components.get(id)! })),
    ...addedEdges.map((id): Mutation => ({ type: 'edge.upsert', edge: edges.get(id)! })),
  ];
  if (!changes.length) return { error: 'The operations do not change the architecture.' };
  return { changes, summary };
}
