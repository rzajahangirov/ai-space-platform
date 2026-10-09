import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { connectDatabase, migrate, type DB } from '../server/db';
import { seedDemo, shopSphereGraph } from '../server/db/seed';
import { buildApp } from '../server/app';
import { applyMutations } from '../server/graph';
import { operationsToMutations, type Operation } from '../shared/operations';
import {
  OpenAIAgenticProvider,
  setAgenticProvider,
  type AgenticProvider,
  type StepRequest,
} from '../server/agents/agentic';

let counter = 0;
const id = () => `id-${++counter}`;
const design: Operation[] = [
  {
    op: 'add_component',
    ref: 'web',
    name: 'Rider App',
    category: 'CLIENT',
    technology: 'Mobile Application',
    description: '',
    config: [],
  },
  {
    op: 'add_component',
    ref: 'api',
    name: 'Trip API',
    category: 'BACKEND',
    technology: 'REST API',
    description: '',
    config: [
      { key: 'port', value: '8080' },
      { key: 'stateless', value: 'true' },
    ],
  },
  {
    op: 'add_component',
    ref: 'db',
    name: 'Trips DB',
    category: 'DATABASE',
    technology: 'PostgreSQL',
    description: '',
    config: [],
  },
  { op: 'add_connection', from: 'web', to: 'api', protocol: 'HTTPS', description: 'Trip requests' },
  { op: 'add_connection', from: 'api', to: 'db', protocol: 'SQL', description: '' },
];

describe('operations', () => {
  it('designs a system from scratch with layered, non-overlapping layout and typed config', () => {
    const result = operationsToMutations({ components: [], edges: [] }, design, id);
    if ('error' in result) throw new Error(result.error);
    const graph = applyMutations({ components: [], edges: [] }, result.changes);
    expect(graph.components).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    const api = graph.components.find((c) => c.name === 'Trip API')!;
    expect(api.config).toEqual({ port: 8080, stateless: true });
    const [web, , db] = ['Rider App', 'Trip API', 'Trips DB'].map((n) =>
      graph.components.find((c) => c.name === n)!,
    );
    expect(web.x).toBeLessThan(api.x);
    expect(api.x).toBeLessThan(db.x);
    expect(result.summary).toContain('+ Trip API (REST API)');
  });
  it('updates, removes, and connects existing components by id or exact name', () => {
    const graph = shopSphereGraph();
    const result = operationsToMutations(
      graph,
      [
        {
          op: 'update_component',
          componentId: 'gateway',
          name: null,
          technology: null,
          description: null,
          config: [
            { key: 'rateLimiting', value: 'true' },
            { key: 'tls', value: null },
          ],
        },
        { op: 'remove_component', componentId: 'cdn' },
        {
          op: 'add_component',
          ref: 'waf',
          name: 'Edge WAF',
          category: 'INFRASTRUCTURE',
          technology: 'Load Balancer',
          description: '',
          config: [],
        },
        {
          op: 'add_connection',
          from: 'waf',
          to: 'API Gateway',
          protocol: 'HTTPS',
          description: '',
        },
      ],
      id,
    );
    if ('error' in result) throw new Error(result.error);
    const after = applyMutations(graph, result.changes);
    const gateway = after.components.find((c) => c.id === 'gateway')!;
    expect(gateway.config.rateLimiting).toBe(true);
    expect(gateway.config).not.toHaveProperty('tls');
    expect(after.components.some((c) => c.id === 'cdn')).toBe(false);
    expect(after.edges.some((e) => e.source === 'cdn' || e.target === 'cdn')).toBe(false);
    expect(after.edges.some((e) => e.target === 'gateway' && e.protocol === 'HTTPS')).toBe(true);
  });
  it('explains invalid operations so a model can correct them', () => {
    const graph = shopSphereGraph();
    const errors = [
      [{ op: 'add_connection', from: 'ghost', to: 'gateway', protocol: 'HTTPS', description: '' }],
      [
        {
          op: 'add_component',
          ref: 'x',
          name: 'API Gateway',
          category: 'BACKEND',
          technology: 'REST API',
          description: '',
          config: [],
        },
      ],
      [
        {
          op: 'update_component',
          componentId: 'nope',
          name: null,
          technology: null,
          description: null,
          config: [],
        },
      ],
      [{ op: 'remove_connection', connectionId: 'nope' }],
    ].map((ops) => operationsToMutations(graph, ops as Operation[], id));
    for (const e of errors) expect(e).toHaveProperty('error');
    expect((errors[1] as { error: string }).error).toContain('id "gateway"');
  });
});

describe('OpenAI agentic adapter', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('sends strict tools without storing input and replays reasoning only for reasoning models', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const bodies: any[] = [];
    const fake = vi.fn(async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'reasoning', encrypted_content: 'opaque' },
            { type: 'function_call', call_id: 'c1', name: 'read_architecture', arguments: '{}' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIAgenticProvider(fake as any);
    const tool = {
      name: 'read_architecture',
      description: 'd',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    };
    const step = await provider.step({
      model: 'gpt-5.5',
      instructions: 'i',
      input: [],
      tools: [tool],
    });
    expect(step.calls).toEqual([{ id: 'c1', name: 'read_architecture', arguments: '{}' }]);
    expect(step.replay).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
    });
    expect(bodies[0].tools[0]).toMatchObject({ type: 'function', strict: true });
    await provider.step({
      model: 'gpt-4.1',
      instructions: 'i',
      input: [],
      tools: [tool],
      finalOnly: true,
    });
    expect(bodies[1]).not.toHaveProperty('reasoning');
    expect(bodies[1].tool_choice).toBe('none');
  });
  it('reports failures without echoing the provider body', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const provider = new OpenAIAgenticProvider(
      (async () =>
        new Response(
          JSON.stringify({ error: { code: 'model_not_found', message: 'secret project text' } }),
          { status: 404 },
        )) as any,
    );
    await expect(
      provider.step({ model: 'x', instructions: '', input: [], tools: [] }),
    ).rejects.toThrow(/404, model_not_found/);
    await expect(
      provider.step({ model: 'x', instructions: '', input: [], tools: [] }),
    ).rejects.not.toThrow(/secret/);
  });
});

// A scripted model: each call to step() returns the next scripted response for the active agent.
type Script = (
  request: StepRequest,
  turn: number,
) => { text?: string; calls?: { name: string; args: unknown }[] };
class ScriptedProvider implements AgenticProvider {
  requests: StepRequest[] = [];
  private turns = new Map<string, number>();
  constructor(private script: Script) {}
  userMessage(text: string) {
    return { role: 'user', content: text };
  }
  toolResult(call: { id: string }, output: unknown) {
    return { type: 'function_call_output', call_id: call.id, output: JSON.stringify(output) };
  }
  async step(request: StepRequest) {
    this.requests.push(structuredClone(request));
    const key = request.instructions.slice(0, 400);
    const turn = this.turns.get(key) ?? 0;
    this.turns.set(key, turn + 1);
    const out = this.script(request, turn);
    const calls = (out.calls ?? []).map((c, i) => ({
      id: `call-${turn}-${i}`,
      name: c.name,
      arguments: JSON.stringify(c.args),
    }));
    return {
      text: out.text ?? '',
      calls,
      replay: calls.map((c) => ({
        type: 'function_call',
        call_id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
      inputTokens: 100,
      outputTokens: 20,
    };
  }
}
const lastToolOutputs = (request: StepRequest) =>
  (request.input as any[])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => JSON.parse(i.output));

let db: DB, app: FastifyInstance, runtime: Awaited<ReturnType<typeof buildApp>>['runtime'];
let ownerCookie: string,
  viewerCookie: string,
  projectId: string,
  architectId: string,
  securityId: string;
const headers = (cookie?: string) => ({
  'x-agentspace-request': '1',
  origin: 'http://localhost:5173',
  ...(cookie ? { cookie } : {}),
});
const call = (method: string, url: string, cookie: string, payload?: unknown) =>
  app.inject({
    method: method as any,
    url: `/api${url}`,
    headers: headers(cookie),
    ...(payload ? { payload } : {}),
  });
const useScript = (script: Script) => {
  const provider = new ScriptedProvider(script);
  setAgenticProvider('openai', provider);
  return provider;
};
beforeAll(async () => {
  db = await connectDatabase({ memory: true });
  await migrate(db);
  await seedDemo(db);
  const built = await buildApp(db, { worker: false, logger: false });
  app = built.app;
  runtime = built.runtime;
  await runtime.tick(); // Seeded local review.
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: headers(),
    payload: { email: 'demo@agentspace.local', password: 'ShopSphere-local-2026!' },
  });
  ownerCookie = login.headers['set-cookie']!.toString().split(';')[0];
  projectId = (await call('GET', '/projects', ownerCookie)).json().projects[0].id;
  const viewer = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: headers(),
    payload: { email: 'v@example.test', name: 'Vera Viewer', password: 'Safe-test-password-2026!' },
  });
  viewerCookie = viewer.headers['set-cookie']!.toString().split(';')[0];
  await db.query("INSERT INTO project_members VALUES($1,$2,'VIEWER')", [
    projectId,
    viewer.json().user.id,
  ]);
  expect(
    (
      await call('POST', `/projects/${projectId}/agents/model`, viewerCookie, {
        provider: 'openai',
        model: 'gpt-5.5',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await call('POST', `/projects/${projectId}/agents/model`, ownerCookie, {
        provider: 'openai',
        model: 'gpt-5.5',
      })
    ).json().updated,
  ).toBe(8);
  [{ id: architectId }] = await db.query(
    "SELECT id FROM agents WHERE project_id=$1 AND role='architect'",
    [projectId],
  );
  [{ id: securityId }] = await db.query(
    "SELECT id FROM agents WHERE project_id=$1 AND role='security'",
    [projectId],
  );
});
afterAll(async () => {
  setAgenticProvider('openai', new OpenAIAgenticProvider());
  await app?.close();
  await db?.close();
});

describe('tool-calling agents', () => {
  it('designs in a conversation: reads, fixes a rejected proposal, and answers with a pending change', async () => {
    const provider = useScript((request, turn) => {
      if (turn === 0) return { calls: [{ name: 'read_architecture', args: {} }] };
      if (turn === 1)
        return {
          calls: [
            {
              name: 'propose_change',
              args: {
                title: 'Add trip service',
                reason: 'New capability',
                risk: 'LOW',
                tradeoffs: 'More services',
                operations: [
                  ...design.slice(1, 3),
                  {
                    op: 'add_connection',
                    from: 'ghost',
                    to: 'db',
                    protocol: 'SQL',
                    description: '',
                  },
                ],
              },
            },
          ],
        };
      if (turn === 2) {
        expect(lastToolOutputs(request).at(-1).error).toContain('ghost');
        return {
          calls: [
            {
              name: 'propose_change',
              args: {
                title: 'Add trip service',
                reason: 'New capability',
                risk: 'LOW',
                tradeoffs: 'More services',
                operations: [
                  ...design.slice(1, 3),
                  { op: 'add_connection', from: 'api', to: 'db', protocol: 'SQL', description: '' },
                  {
                    op: 'add_connection',
                    from: 'gateway',
                    to: 'api',
                    protocol: 'REST',
                    description: '',
                  },
                ],
              },
            },
          ],
        };
      }
      return { text: 'I **proposed** a Trip API with its own database. Approve it to apply.' };
    });
    const created = await call('POST', `/projects/${projectId}/conversations`, ownerCookie, {
      content: '@SystemArchitect add a trip service',
    });
    expect(created.statusCode).toBe(200);
    await runtime.tick();
    const detail = (
      await call('GET', `/projects/${projectId}/conversations/${created.json().id}`, ownerCookie)
    ).json();
    expect(detail.messages.map((m: any) => m.actor_type)).toEqual(['human', 'agent']);
    expect(detail.messages[1].content).toContain('proposed');
    expect(detail.runs[0]).toMatchObject({
      status: 'completed',
      input_tokens: 400,
      output_tokens: 80,
    });
    expect(detail.steps.map((s: any) => [s.tool, s.status])).toEqual([
      ['project.graph.read', 'completed'],
      ['architecture.propose', 'rejected'],
      ['architecture.propose', 'completed'],
    ]);
    expect(detail.proposals).toHaveLength(1);
    expect(detail.proposals[0].operations).toHaveLength(4);
    // The briefing grounds the model in the real graph and conversation.
    const briefing = (provider.requests[0].input[0] as any).content as string;
    expect(briefing).toContain('gateway · API Gateway');
    expect(briefing).toContain('add a trip service');
    expect(provider.requests[0].tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'read_architecture',
        'propose_change',
        'write_artifact',
        'ask_agent',
      ]),
    );
    const inbox = (await call('GET', '/notifications', ownerCookie)).json();
    expect(
      inbox.notifications.some(
        (n: any) => n.kind === 'approval_request' && n.title.includes('System Architect'),
      ),
    ).toBe(true);
  });
  it('a proposal made on an older revision is re-validated and applied on the current graph', async () => {
    const [proposal] = await db.query("SELECT * FROM proposals WHERE title='Add trip service'");
    const [project] = await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]);
    // Someone else edits first, making the proposal's base revision stale.
    await call('POST', `/projects/${projectId}/graph`, ownerCookie, {
      revision: project.revision,
      summary: 'move',
      changes: [{ type: 'component.delete', id: 'cdn' }],
    });
    const decision = await call(
      'POST',
      `/projects/${projectId}/proposals/${proposal.id}/decision`,
      ownerCookie,
      { decision: 'APPROVED' },
    );
    expect(decision.statusCode).toBe(200);
    const names = (
      await db.query('SELECT name FROM components WHERE project_id=$1', [projectId])
    ).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Trip API', 'Trips DB']));
  });
  it('rebase fails clearly when the proposal no longer makes sense', async () => {
    const result = operationsToMutations(
      shopSphereGraph(),
      [{ op: 'remove_component', componentId: 'cdn' }],
      id,
    );
    if ('error' in result) throw new Error(result.error);
    await db.query(
      "INSERT INTO proposals(id,project_id,agent_id,title,reason,risk,tradeoffs,changes,operations,base_revision) VALUES('stale',$1,$2,'Remove CDN','r','LOW','t',$3,$4,0)",
      [
        projectId,
        architectId,
        JSON.stringify(result.changes),
        JSON.stringify([{ op: 'remove_component', componentId: 'cdn' }]),
      ],
    );
    const decision = await call(
      'POST',
      `/projects/${projectId}/proposals/stale/decision`,
      ownerCookie,
      { decision: 'APPROVED' },
    );
    expect(decision.statusCode).toBe(409);
    expect(decision.json().error).toContain('no longer applies');
  });
  it('only offers granted tools and denies forced calls to revoked ones', async () => {
    await db.query(
      "DELETE FROM agent_tool_grants WHERE agent_id=$1 AND tool='architecture.propose'",
      [securityId],
    );
    const security = (r: StepRequest) => r.instructions.includes('You are Security Engineer');
    const provider = useScript((request, turn) =>
      security(request) && turn === 0
        ? {
            calls: [
              {
                name: 'propose_change',
                args: {
                  title: 'Sneaky',
                  reason: 'x',
                  risk: 'LOW',
                  tradeoffs: '',
                  operations: [{ op: 'remove_component', componentId: 'gateway' }],
                },
              },
            ],
          }
        : { text: 'Done reviewing.' },
    );
    await call('POST', `/projects/${projectId}/messages`, ownerCookie, {
      content: '@SecurityAgent remove the gateway',
    });
    await runtime.tick();
    // Other runs (e.g. a live review of the previous edit) may interleave; look at Security only.
    const own = provider.requests.filter(security);
    expect(own[0].tools.map((t) => t.name)).not.toContain('propose_change');
    expect(lastToolOutputs(own[1])[0].error).toContain('denied');
    expect(await db.query("SELECT id FROM proposals WHERE title='Sneaky'")).toHaveLength(0);
    await db.query(
      "INSERT INTO agent_tool_grants VALUES($1,'architecture.propose',$2,'write','AUTO')",
      [securityId, projectId],
    );
  });
  it('agents ask each other; delegation is bounded and answers land in the same conversation', async () => {
    useScript((request, turn) => {
      const isArchitect = request.instructions.includes('You are System Architect');
      if (isArchitect && turn === 0)
        return {
          calls: [
            {
              name: 'ask_agent',
              args: { agent: 'security', question: 'Is the gateway exposed safely?' },
            },
            { name: 'ask_agent', args: { agent: 'nobody', question: 'hello there' } },
          ],
        };
      if (isArchitect) {
        const outputs = lastToolOutputs(request);
        expect(outputs[0].status).toContain('Security Engineer will answer');
        expect(outputs[1].status).toContain('No enabled agent');
        return { text: 'Asked Security.' };
      }
      // The delegated agent sees who asked and the question.
      expect((request.input[0] as any).content).toContain(
        'System Architect asked you: Is the gateway exposed safely?',
      );
      return turn === 0
        ? {
            calls: [
              {
                name: 'record_finding',
                args: {
                  componentId: 'gateway',
                  category: 'Security',
                  severity: 'HIGH',
                  confidence: 0.9,
                  title: 'Gateway lacks WAF',
                  description: 'd',
                  evidence: 'No WAF component in graph',
                  impact: 'i',
                  recommendation: 'r',
                },
              },
            ],
          }
        : { text: 'Recorded a WAF finding.' };
    });
    const created = (
      await call('POST', `/projects/${projectId}/conversations`, ownerCookie, {
        content: '@architect is the edge safe?',
      })
    ).json();
    await runtime.tick();
    const detail = (
      await call('GET', `/projects/${projectId}/conversations/${created.id}`, ownerCookie)
    ).json();
    expect(detail.messages.map((m: any) => m.author_name)).toEqual([
      'Alex Morgan',
      'System Architect',
      'Security Engineer',
    ]);
    expect(detail.findings.map((f: any) => f.title)).toEqual(['Gateway lacks WAF']);
  });
  it('writes artifacts that humans edit with revision checks', async () => {
    useScript((_r, turn) =>
      turn === 0
        ? {
            calls: [
              {
                name: 'write_artifact',
                args: {
                  artifactId: null,
                  title: 'Edge ADR',
                  kind: 'adr',
                  content: '# ADR\nUse a WAF.',
                },
              },
            ],
          }
        : { text: 'Wrote the ADR.' },
    );
    await call('POST', `/projects/${projectId}/messages`, ownerCookie, {
      content: '@architect write an ADR',
    });
    await runtime.tick();
    const list = (await call('GET', `/projects/${projectId}/artifacts`, ownerCookie)).json()
      .artifacts;
    const adr = list.find((a: any) => a.title === 'Edge ADR');
    expect(adr).toMatchObject({ kind: 'adr', author_type: 'agent', revision: 1 });
    const ok = await call('PATCH', `/projects/${projectId}/artifacts/${adr.id}`, ownerCookie, {
      title: 'Edge ADR',
      content: '# ADR\nUse a WAF and rate limits.',
      revision: 1,
    });
    expect(ok.json().revision).toBe(2);
    const stale = await call('PATCH', `/projects/${projectId}/artifacts/${adr.id}`, ownerCookie, {
      title: 'x',
      content: 'old',
      revision: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await call('PATCH', `/projects/${projectId}/artifacts/${adr.id}`, viewerCookie, {
          title: 'x',
          content: 'v',
          revision: 2,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('stops at the run token limit instead of spending more', async () => {
    vi.stubEnv('AGENT_RUN_TOKEN_LIMIT', '20000');
    await db.query('UPDATE agent_runs SET input_tokens=0 WHERE false');
    const provider = useScript(() => ({ calls: [{ name: 'read_architecture', args: {} }] }));
    const created = (
      await call('POST', `/projects/${projectId}/conversations`, ownerCookie, {
        content: '@architect loop forever',
      })
    ).json();
    await db.query('UPDATE agent_runs SET input_tokens=19990 WHERE conversation_id=$1', [
      created.id,
    ]);
    await runtime.tick();
    vi.unstubAllEnvs();
    const detail = (
      await call('GET', `/projects/${projectId}/conversations/${created.id}`, ownerCookie)
    ).json();
    expect(detail.messages[1].content).toContain('token limit');
    expect(provider.requests.length).toBeLessThanOrEqual(1);
  });
  it('one active run per conversation, parallel conversations allowed, viewers read-only', async () => {
    useScript(() => ({ text: 'ok' }));
    const a = (
      await call('POST', `/projects/${projectId}/conversations`, ownerCookie, {
        content: '@architect one',
      })
    ).json();
    expect(
      (
        await call('POST', `/projects/${projectId}/messages`, ownerCookie, {
          conversationId: a.id,
          content: '@architect two',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `/projects/${projectId}/conversations`, ownerCookie, {
          content: '@security parallel',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/projects/${projectId}/conversations`, viewerCookie, { content: 'hi' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/projects/${projectId}/conversations/${a.id}`, viewerCookie)).statusCode,
    ).toBe(200);
    await runtime.tick();
    const list = (await call('GET', `/projects/${projectId}/conversations`, viewerCookie)).json()
      .conversations;
    expect(list.every((c: any) => !c.active)).toBe(true);
  });
  it('a provider failure is visible in the conversation and fails the run', async () => {
    setAgenticProvider('openai', {
      userMessage: (t: string) => t,
      toolResult: () => ({}),
      step: async () => {
        throw new Error('OpenAI request failed (429, rate_limit_exceeded).');
      },
    } as AgenticProvider);
    const created = (
      await call('POST', `/projects/${projectId}/conversations`, ownerCookie, {
        content: '@architect hello',
      })
    ).json();
    await runtime.tick();
    const detail = (
      await call('GET', `/projects/${projectId}/conversations/${created.id}`, ownerCookie)
    ).json();
    expect(detail.runs[0].status).toBe('failed');
    expect(detail.messages.at(-1)).toMatchObject({ actor_type: 'system' });
    expect(detail.messages.at(-1).content).toContain('429');
  });
});

describe('delegation targets', () => {
  it('resolves loose specialty names to real agents and rejects unknown ones', async () => {
    const { resolveAgent } = await import('../server/agents/runtime');
    const agents = ['architect', 'security', 'devops', 'database'].map((role) => ({
      id: role,
      role,
      name: `${role[0].toUpperCase()}${role.slice(1)} Engineer`,
    })) as any;
    expect(resolveAgent('Security Architect', agents, 'architect')?.role).toBe('security');
    expect(resolveAgent('Site Reliability Engineer', agents, 'architect')?.role).toBe('devops');
    expect(resolveAgent('DBA', agents, 'architect')?.role).toBe('database');
    expect(resolveAgent('Devops Engineer', agents, 'architect')?.role).toBe('devops');
    expect(resolveAgent('nobody', agents, 'architect')).toBeUndefined();
    expect(resolveAgent('Architect', agents, 'architect')).toBeUndefined();
  });
});
