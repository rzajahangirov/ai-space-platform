import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { connectDatabase, migrate, type DB } from '../server/db';
import { seedDemo, shopSphereGraph } from '../server/db/seed';
import { buildApp } from '../server/app';
import { compareWithDesign, discover, normalizeName } from '../server/discovery';
import { resolveMentions } from '../server/mentions';
import { applyMutations as applyMutationsForTest } from '../server/graph';
import { additionMutations } from '../shared/domain';
import { shopSphereCompose } from '../shared/samples';

describe('discovery', () => {
  it('derives components and evidence-backed connections from Docker Compose', () => {
    const d = discover(shopSphereCompose, 'docker-compose.yml');
    expect(d.format).toBe('docker-compose');
    const postgres = d.components.find((c) => c.key === 'postgres')!;
    expect(postgres).toMatchObject({ category: 'DATABASE', technology: 'PostgreSQL' });
    // Source-built services are guesses and must say so with lower confidence.
    expect(d.components.find((c) => c.key === 'order-service')!.confidence).toBeLessThan(0.7);
    const edge = d.edges.find((e) => e.source === 'order-service' && e.target === 'redis')!;
    expect(edge.protocol).toBe('Redis');
    expect(edge.evidence).toContain('CACHE_URL');
  });
  it('never stores connection strings or secret values', () => {
    const d = discover(
      'services:\n  api:\n    build: .\n    environment:\n      DATABASE_URL: postgres://admin:hunter2@db:5432/x\n      API_KEY: sk-live-123\n  db:\n    image: postgres:17\n',
    );
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-123');
    expect(d.warnings.join(' ')).toContain('API_KEY');
    expect(d.edges).toEqual([
      expect.objectContaining({ source: 'api', target: 'db', protocol: 'SQL' }),
    ]);
  });
  it('rejects malformed input and alias bombs', () => {
    expect(() => discover('services: [', 'docker-compose.yml')).toThrow();
    const bomb =
      'a: &a ["x","x","x","x","x","x","x","x","x"]\n' +
      Array.from(
        { length: 8 },
        (_, i) =>
          `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`,
      ).join('\n') +
      '\nservices:\n  x:\n    image: *i\n';
    expect(() => discover(bomb, 'docker-compose.yml')).toThrow();
  });
  it('reads package.json and requirements.txt dependencies', () => {
    const pkg = discover(
      JSON.stringify({
        name: '@acme/orders',
        dependencies: { fastify: '5', pg: '8', kafkajs: '2', stripe: '1' },
      }),
      'package.json',
    );
    expect(pkg.components[0]).toMatchObject({ name: 'orders', technology: 'REST API' });
    expect(pkg.components.map((c) => c.technology)).toEqual(
      expect.arrayContaining(['PostgreSQL', 'Kafka', 'Stripe']),
    );
    expect(pkg.edges).toHaveLength(3);
    const py = discover('fastapi==0.115\npsycopg[binary]>=3 # db\nredis\n', 'requirements.txt');
    expect(py.components.map((c) => c.technology)).toEqual(['REST API', 'PostgreSQL', 'Redis']);
  });
  it('reports drift between the design and the observed system', () => {
    const report = compareWithDesign(
      shopSphereGraph(),
      discover(shopSphereCompose, 'compose.yaml'),
    );
    expect(report.expectedEdges).toContainEqual(
      expect.objectContaining({ sourceName: 'Product Service', targetName: 'Product Cache' }),
    );
    expect(report.unexpectedEdges).toContainEqual(
      expect.objectContaining({ sourceName: 'Order Service', targetName: 'Product Cache' }),
    );
    expect(report.undeclared.map((c) => c.name)).toContain('Notification Worker');
    // Managed and external services are not expected inside a Compose file.
    expect(report.missingInObservation.map((c) => c.name)).not.toContain('Payment Processor');
    expect(report.missingInObservation.map((c) => c.name)).not.toContain('Content Delivery');
    expect(normalizeName('product-service')).toBe(normalizeName('Product Service'));
  });
  it('never matches application services by a generic technology alone', () => {
    const d = discover(JSON.stringify({ name: 'search-service', dependencies: { fastify: '5' } }));
    const report = compareWithDesign(shopSphereGraph(), d);
    expect(report.matches.map((m) => m.observedKey)).not.toContain('app:search-service');
  });
});

describe('structural proposals', () => {
  const addition = {
    title: 'Add cache',
    reason: 'read heavy',
    risk: 'MEDIUM' as const,
    tradeoffs: 'invalidation',
    component: {
      name: 'Order Cache',
      category: 'DATABASE' as const,
      technology: 'Redis',
      description: '',
    },
    connections: [{ from: 'orders', to: 'NEW', protocol: 'Redis' as const }],
  };
  it('adds one component and connections that pass graph invariants', () => {
    const graph = shopSphereGraph();
    const built = additionMutations(graph, addition, 'new-cache');
    if ('error' in built) throw new Error(built.error);
    const after = applyMutationsForTest(graph, built.changes);
    expect(after.components).toHaveLength(graph.components.length + 1);
    expect(after.edges).toContainEqual(
      expect.objectContaining({ source: 'orders', target: 'new-cache' }),
    );
    const placed = after.components.find((c) => c.id === 'new-cache')!;
    expect(
      graph.components.some(
        (c) => Math.abs(c.x - placed.x) < 240 && Math.abs(c.y - placed.y) < 145,
      ),
    ).toBe(false);
  });
  it('rejects unknown endpoints, connections without the new component, and duplicate names', () => {
    const graph = shopSphereGraph();
    expect(
      additionMutations(
        graph,
        { ...addition, connections: [{ from: 'ghost', to: 'NEW', protocol: 'Redis' }] },
        'x',
      ),
    ).toHaveProperty('error');
    expect(
      additionMutations(
        graph,
        { ...addition, connections: [{ from: 'orders', to: 'postgres', protocol: 'SQL' }] },
        'x',
      ),
    ).toHaveProperty('error');
    expect(
      additionMutations(
        graph,
        { ...addition, component: { ...addition.component, name: 'product cache' } },
        'x',
      ),
    ).toHaveProperty('error');
  });
});

describe('mentions', () => {
  const agents = [
    { id: 'a1', name: 'Security Engineer', role: 'security', enabled: true },
    { id: 'a2', name: 'Database Engineer', role: 'database', enabled: true },
    { id: 'a3', name: 'QA Engineer', role: 'qa', enabled: false },
  ];
  const members = [
    { id: 'u1', name: 'Ulvi Sharifzade', email: 'ulvi@example.test' },
    { id: 'u2', name: 'Sam Lee', email: 'sam@example.test' },
  ];
  it('resolves agent handles, human first names, and ignores disabled agents and emails', () => {
    const r = resolveMentions(
      '@SecurityAgent and @DatabaseEngineer please check; @Ulvi FYI. @qa? mail sam@example.test',
      agents,
      members,
    );
    expect(r.agentIds).toEqual(['a1', 'a2']);
    expect(r.userIds).toEqual(['u1']);
  });
});

let db: DB, app: FastifyInstance, runtime: Awaited<ReturnType<typeof buildApp>>['runtime'];
let ownerCookie: string, editorCookie: string, editorId: string, projectId: string;
const headers = (cookie?: string) => ({
  'x-agentspace-request': '1',
  origin: 'http://localhost:5173',
  ...(cookie ? { cookie } : {}),
});
const cooldown = () =>
  db.query("UPDATE agent_runs SET created_at=now()-interval '10 minutes' WHERE project_id=$1", [
    projectId,
  ]);
beforeAll(async () => {
  db = await connectDatabase({ memory: true });
  await migrate(db);
  await seedDemo(db);
  const built = await buildApp(db, { worker: false, logger: false });
  app = built.app;
  runtime = built.runtime;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: headers(),
    payload: { email: 'demo@agentspace.local', password: 'ShopSphere-local-2026!' },
  });
  ownerCookie = login.headers['set-cookie']!.toString().split(';')[0];
  projectId = (await app.inject({ url: '/api/projects', headers: headers(ownerCookie) })).json()
    .projects[0].id;
  const editor = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: headers(),
    payload: {
      email: 'jordan@example.test',
      name: 'Jordan Reyes',
      password: 'Safe-test-password-2026!',
    },
  });
  editorCookie = editor.headers['set-cookie']!.toString().split(';')[0];
  editorId = editor.json().user.id;
  await db.query("INSERT INTO project_members VALUES($1,$2,'EDITOR')", [projectId, editorId]);
  await runtime.tick(); // Seeded review.
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('inbox and mentions API', () => {
  it('notifies only owners/admins about proposals and only requesters about completion', async () => {
    const owner = (
      await app.inject({ url: '/api/notifications', headers: headers(ownerCookie) })
    ).json();
    expect(owner.notifications.map((n: any) => n.kind)).toEqual(
      expect.arrayContaining(['approval_request', 'critical_finding', 'run_completed']),
    );
    const editor = (
      await app.inject({ url: '/api/notifications', headers: headers(editorCookie) })
    ).json();
    expect(editor.notifications.map((n: any) => n.kind)).not.toContain('approval_request');
  });
  it('routes @mentioned agents into one run and notifies mentioned humans', async () => {
    await cooldown();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/messages`,
      headers: headers(ownerCookie),
      payload: { content: '@SecurityAgent @DatabaseAgent check the payment boundary. @Jordan FYI' },
    });
    expect(response.statusCode).toBe(200);
    const [run] = await db.query('SELECT * FROM agent_runs WHERE id=$1', [response.json().run.id]);
    expect(run.participant_ids).toHaveLength(2);
    await runtime.tick();
    const names = (
      await db.query("SELECT author_name FROM messages WHERE run_id=$1 AND actor_type='agent'", [
        run.id,
      ])
    ).map((m) => m.author_name);
    expect(names.slice(0, 2)).toEqual(['Security Engineer', 'Database Engineer']);
    const inbox = (
      await app.inject({ url: '/api/notifications', headers: headers(editorCookie) })
    ).json();
    expect(inbox.notifications.find((n: any) => n.kind === 'mention').title).toContain(
      'Alex Morgan',
    );
  });
  it('marks only the caller’s notifications read', async () => {
    const before = (
      await app.inject({ url: '/api/notifications', headers: headers(ownerCookie) })
    ).json();
    const editorInbox = (
      await app.inject({ url: '/api/notifications', headers: headers(editorCookie) })
    ).json();
    expect(before.unread).toBeGreaterThan(0);
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: headers(ownerCookie),
      payload: { ids: editorInbox.notifications.map((n: any) => n.id) },
    });
    const editorAfter = (
      await app.inject({ url: '/api/notifications', headers: headers(editorCookie) })
    ).json();
    expect(editorAfter.unread).toBe(editorInbox.unread);
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: headers(ownerCookie),
      payload: {},
    });
    expect(
      (await app.inject({ url: '/api/notifications', headers: headers(ownerCookie) })).json()
        .unread,
    ).toBe(0);
  });
  it('agents mentioned in a component thread reply inside that thread', async () => {
    await cooldown();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/comments`,
      headers: headers(editorCookie),
      payload: {
        componentId: 'payments',
        content: '@SecurityAgent should this service reach Stripe directly?',
      },
    });
    expect(response.json().agentNotice).toContain('reply');
    await runtime.tick();
    const snapshot = (
      await app.inject({
        url: `/api/projects/${projectId}/snapshot`,
        headers: headers(ownerCookie),
      })
    ).json();
    const thread = snapshot.comments.filter((c: any) => c.component_id === 'payments');
    expect(thread.map((c: any) => c.actor_type)).toEqual(['human', 'agent']);
    expect(thread[1].author_name).toBe('Security Engineer');
  });
  it('keeps the comment when agents are busy', async () => {
    // A component-thread run is still queued, so another one cannot start.
    await db.query(
      "INSERT INTO agent_runs(id,project_id,requested_by,prompt,source) VALUES('busy-run',$1,$2,'pending','comment')",
      [projectId, editorId],
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/comments`,
      headers: headers(editorCookie),
      payload: { componentId: 'orders', content: '@DatabaseAgent indexes?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentNotice).toContain('could not start');
    expect(
      await db.query("SELECT id FROM comments WHERE component_id='orders' AND project_id=$1", [
        projectId,
      ]),
    ).toHaveLength(1);
    await db.query("DELETE FROM agent_runs WHERE id='busy-run'");
  });
});

describe('structural proposals end to end', () => {
  it('a cache removal yields an approvable proposal that restores a cache via a new component', async () => {
    await cooldown();
    const [project] = await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/graph`,
      headers: headers(ownerCookie),
      payload: {
        revision: project.revision,
        summary: 'Remove Redis',
        changes: [{ type: 'component.delete', id: 'redis' }],
      },
    });
    await runtime.tick();
    const [proposal] = await db.query(
      "SELECT * FROM proposals WHERE project_id=$1 AND title='Insert a Redis cache for Product Service'",
      [projectId],
    );
    expect(proposal.status).toBe('PENDING');
    const decision = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/proposals/${proposal.id}/decision`,
      headers: headers(ownerCookie),
      payload: { decision: 'APPROVED' },
    });
    expect(decision.statusCode).toBe(200);
    const [cache] = await db.query(
      "SELECT id FROM components WHERE project_id=$1 AND name='Product Service Cache'",
      [projectId],
    );
    expect(
      await db.query('SELECT id FROM edges WHERE project_id=$1 AND source=$2 AND target=$3', [
        projectId,
        'products',
        cache.id,
      ]),
    ).toHaveLength(1);
  });
});

describe('observe mode API', () => {
  it('editors can discover; viewers cannot; observations store drift without raw content', async () => {
    const discovered = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/discover`,
      headers: headers(editorCookie),
      payload: { content: shopSphereCompose, filename: 'docker-compose.yml' },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().discovery.components.length).toBeGreaterThan(10);
    const observed = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/observations`,
      headers: headers(editorCookie),
      payload: { content: shopSphereCompose, filename: 'docker-compose.yml' },
    });
    expect(observed.statusCode).toBe(200);
    expect(observed.json().drift.total).toBeGreaterThan(0);
    const [row] = await db.query('SELECT * FROM observations WHERE id=$1', [observed.json().id]);
    expect(JSON.stringify(row)).not.toContain('postgres://');
    const [knowledge] = await db.query(
      "SELECT content FROM knowledge_sources WHERE project_id=$1 AND kind='observation'",
      [projectId],
    );
    expect(knowledge.content).toContain('Notification Worker');
    const owner = (
      await app.inject({ url: '/api/notifications', headers: headers(ownerCookie) })
    ).json();
    expect(owner.notifications.some((n: any) => n.kind === 'drift_detected')).toBe(true);
  });
  it('outsiders cannot read observations', async () => {
    const outsider = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: headers(),
      payload: {
        email: 'outside@example.test',
        name: 'Out Sider',
        password: 'Safe-test-password-2026!',
      },
    });
    const cookie = outsider.headers['set-cookie']!.toString().split(';')[0];
    expect(
      (
        await app.inject({
          url: `/api/projects/${projectId}/observations`,
          headers: headers(cookie),
        })
      ).statusCode,
    ).toBe(404);
  });
});
