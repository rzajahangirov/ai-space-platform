import type { DB } from './index';
import { uid, passwordHash, audit, type Actor } from '../core';
import { persistGraph } from '../graph';
import { defaultAgentModel, grantStandardTools, roleGuidance } from '../agents/defaults';
import type { Component, Graph } from '../../shared/domain';

export const starters = [
  ['System Architect', 'architect', 'Service boundaries, dependencies, and engineering tradeoffs.'],
  ['Backend Engineer', 'backend', 'API contracts, event processing, and failure handling.'],
  ['Security Engineer', 'security', 'Trust boundaries, authentication, and least privilege.'],
  ['Database Engineer', 'database', 'Schema design, indexing, transactions, and consistency.'],
  [
    'Performance Engineer',
    'performance',
    'Bottlenecks, caching, latency, and capacity assumptions.',
  ],
  ['DevOps Engineer', 'devops', 'Deployment safety, infrastructure, and observability.'],
  ['Frontend Architect', 'frontend', 'Frontend boundaries, accessibility, and rendering.'],
  ['QA Engineer', 'qa', 'Failure scenarios, test strategy, and regression coverage.'],
];
export async function createProject(
  db: DB,
  actor: Actor,
  name: string,
  workspaceName: string,
  workspaceId?: string,
) {
  const wid = workspaceId ?? uid(),
    pid = uid();
  if (!workspaceId) {
    await db.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)', [
      wid,
      workspaceName,
      actor.id,
    ]);
    await db.query("INSERT INTO workspace_members VALUES($1,$2,'OWNER')", [wid, actor.id]);
  }
  await db.query('INSERT INTO projects(id,workspace_id,name,description) VALUES($1,$2,$3,$4)', [
    pid,
    wid,
    name,
    'A shared system of components, connections, and engineering decisions.',
  ]);
  await db.query("INSERT INTO project_members VALUES($1,$2,'OWNER')", [pid, actor.id]);
  const views: [string, string[]][] = [
    ['System overview', []],
    ['Frontend', ['CLIENT', 'FRONTEND', 'EXTERNAL']],
    ['Backend', ['BACKEND', 'AUTH', 'DATABASE', 'MESSAGING']],
    ['Data flow', ['BACKEND', 'DATABASE', 'STORAGE', 'MESSAGING']],
    ['Infrastructure', ['INFRASTRUCTURE', 'STORAGE', 'DATABASE', 'OBSERVABILITY']],
    ['Security', ['AUTH', 'BACKEND', 'INFRASTRUCTURE', 'EXTERNAL']],
    ['AI architecture', ['AI']],
    ['Observability', ['OBSERVABILITY', 'BACKEND']],
  ];
  for (const [view, categories] of views)
    await db.query(
      'INSERT INTO architecture_views(id,project_id,name,categories) VALUES($1,$2,$3,$4)',
      [uid(), pid, view, JSON.stringify(categories)],
    );
  const skill = uid();
  await db.query(
    'INSERT INTO skills(id,workspace_id,name,instructions,required_tools,validation_rules) VALUES($1,$2,$3,$4,$5,$6)',
    [
      skill,
      wid,
      'Evidence-first architecture review',
      'Inspect explicit configuration and dependencies. State assumptions. Provide evidence for each finding. Propose reversible changes and explain tradeoffs. Ask peers a specific question when their specialty is relevant.',
      JSON.stringify(['project.graph.read']),
      JSON.stringify(['evidence required', 'human approval for architecture changes']),
    ],
  );
  await db.query("INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'General')", [
    `general-${pid}`,
    pid,
  ]);
  const model = defaultAgentModel();
  for (const [agentName, role, description] of starters) {
    const id = uid();
    await db.query(
      'INSERT INTO agents(id,workspace_id,project_id,name,role,description,provider,model,instructions,capabilities,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        wid,
        pid,
        agentName,
        role,
        description,
        model.provider,
        model.model,
        `You are a senior ${role} engineer. ${roleGuidance[role] ?? description}`,
        JSON.stringify([
          'graph.read',
          'finding.create',
          'proposal.create',
          'artifact.write',
          'agent.delegate',
        ]),
        actor.id,
      ],
    );
    await db.query('INSERT INTO agent_skills VALUES($1,$2)', [id, skill]);
    await grantStandardTools(db, id, pid);
  }
  await db.query(
    'INSERT INTO architecture_versions(id,project_id,revision,graph,summary,actor_id) VALUES($1,$2,0,$3,$4,$5)',
    [uid(), pid, JSON.stringify({ components: [], edges: [] }), 'Project created', actor.id],
  );
  await audit(db, pid, actor, 'project.created', `Created ${name}.`);
  return pid;
}
export function shopSphereGraph(): Graph {
  const n = (
    id: string,
    name: string,
    category: Component['category'],
    technology: string,
    x: number,
    y: number,
    config: Component['config'] = {},
  ): Component => ({
    id,
    name,
    category,
    technology,
    x,
    y,
    description: `${name} in the ShopSphere commerce system.`,
    config: { environment: 'Production', owner: 'Platform team', ...config },
  });
  const components = [
    n('web', 'Storefront', 'FRONTEND', 'Next.js', 50, 220, {
      framework: 'Next.js',
      language: 'TypeScript',
      repository: 'shopsphere/storefront',
      runtime: 'Node.js',
    }),
    n('gateway', 'API Gateway', 'INFRASTRUCTURE', 'API Gateway', 370, 220, {
      rateLimiting: false,
      tls: true,
      port: 443,
    }),
    n('auth', 'Identity Service', 'AUTH', 'Auth Service', 690, 10, {
      protocol: 'OIDC',
      tokens: 'JWT',
      port: 8081,
    }),
    n('products', 'Product Service', 'BACKEND', 'REST API', 690, 220, {
      framework: 'Fastify',
      port: 8080,
      readHeavy: true,
    }),
    n('orders', 'Order Service', 'BACKEND', 'Microservice', 690, 430, {
      framework: 'Fastify',
      port: 8082,
    }),
    n('payments', 'Payment Service', 'BACKEND', 'Microservice', 1010, 620, {
      databaseAccess: 'all tables',
      port: 8083,
    }),
    n('postgres', 'Primary Database', 'DATABASE', 'PostgreSQL', 1030, 220, {
      version: '17',
      ordersUserIdIndex: false,
      replicas: 0,
    }),
    n('redis', 'Product Cache', 'DATABASE', 'Redis', 1030, 10, { ttlSeconds: 300 }),
    n('kafka', 'Event Stream', 'MESSAGING', 'Kafka', 1030, 430, {
      deadLetterQueue: false,
      partitions: 6,
    }),
    n('stripe', 'Payment Processor', 'EXTERNAL', 'Stripe', 1350, 620, { integration: 'Webhooks' }),
    n('s3', 'Asset Storage', 'STORAGE', 'S3', 370, -200, {
      bucket: 'shopsphere-assets',
      public: false,
    }),
    n('cdn', 'Content Delivery', 'INFRASTRUCTURE', 'CDN', 50, -200, { tls: true }),
    n('monitoring', 'System Telemetry', 'OBSERVABILITY', 'Monitoring', 1350, 220, {
      metrics: true,
      tracing: false,
    }),
  ];
  const edges: Graph['edges'] = [
    ['web', 'gateway', 'HTTPS'],
    ['gateway', 'auth', 'OAuth'],
    ['gateway', 'products', 'REST'],
    ['gateway', 'orders', 'REST'],
    ['products', 'postgres', 'SQL'],
    ['products', 'redis', 'Redis'],
    ['orders', 'postgres', 'SQL'],
    ['orders', 'kafka', 'Kafka Event'],
    ['kafka', 'payments', 'Kafka Event'],
    ['payments', 'postgres', 'SQL'],
    ['payments', 'stripe', 'HTTPS'],
    ['web', 'cdn', 'HTTPS'],
    ['cdn', 's3', 'HTTPS'],
    ['postgres', 'monitoring', 'TCP'],
  ].map(([source, target, protocol], i) => ({
    id: `edge-${i}`,
    source,
    target,
    protocol: protocol as Graph['edges'][number]['protocol'],
    metadata: {},
  }));
  return { components, edges };
}
export async function seedDemo(
  db: DB,
  password = process.env.DEMO_PASSWORD || 'ShopSphere-local-2026!',
) {
  if ((await db.query("SELECT id FROM users WHERE email='demo@agentspace.local'")).length) return;
  if (process.env.NODE_ENV === 'production' && !process.env.DEMO_PASSWORD)
    throw new Error('Set a private DEMO_PASSWORD before explicitly seeding production.');
  const actor = { id: uid(), name: 'Alex Morgan', email: 'demo@agentspace.local' },
    passwordDigest = await passwordHash(password);
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.email,
      actor.name,
      passwordDigest,
    ]);
    const pid = await createProject(tx, actor, 'ShopSphere', 'Acme Engineering');
    const graph = shopSphereGraph();
    await persistGraph(tx, pid, graph);
    await tx.query(
      'UPDATE architecture_versions SET graph=$1,summary=$2 WHERE project_id=$3 AND revision=0',
      [JSON.stringify(graph), 'ShopSphere reference architecture', pid],
    );
    await tx.query('UPDATE projects SET description=$1 WHERE id=$2', [
      'Commerce platform · Production architecture',
      pid,
    ]);
    await tx.query(
      'INSERT INTO knowledge_sources(id,project_id,title,kind,content) VALUES($1,$2,$3,$4,$5)',
      [
        uid(),
        pid,
        'ShopSphere architecture brief',
        'document',
        'A commerce reference system. The gateway has no declared rate limiting, the payment service can access all database tables, and Kafka lacks a dead-letter queue. These are intentionally seeded configuration issues, not measured production incidents. No traffic or cost telemetry has been connected.',
      ],
    );
    await tx.query(
      'INSERT INTO messages(id,project_id,conversation_id,user_id,actor_type,author_name,content) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        uid(),
        pid,
        `general-${pid}`,
        actor.id,
        'human',
        actor.name,
        'Let’s review the checkout path before launch. Please look at access boundaries and how we handle failed payment events.',
      ],
    );
    await tx.query(
      'INSERT INTO agent_runs(id,project_id,requested_by,prompt,conversation_id) VALUES($1,$2,$3,$4,$5)',
      [
        uid(),
        pid,
        actor.id,
        'Review the reference architecture and collaborate with relevant specialists.',
        `general-${pid}`,
      ],
    );
  });
}
