import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { connectDatabase, migrate, type DB } from '../server/db';
import { seedDemo } from '../server/db/seed';
import { buildApp } from '../server/app';
import { setCouncilLLM } from '../server/routes-council';
import { triage, type Decision } from '../server/council/council';
import type { ChatRequest, CouncilLLM, Seat } from '../server/council/llm';

const headers = (cookie?: string) => ({
  'x-agentspace-request': '1',
  origin: 'http://localhost:5173',
  ...(cookie ? { cookie } : {}),
});
const vote = (seat: Seat, approve: boolean, confidence: number) => ({
  seat,
  approve,
  confidence,
  comment: '',
});
const decision = (risk: Decision['risk'], votes: Decision['votes']): Decision => ({
  title: 't',
  rationale: 'r',
  risk,
  votes,
});

describe('4-of-5 triage', () => {
  it('accepts four unanimous decisions and sends the lowest-ranked one to review', () => {
    const ds = [0.9, 0.8, 0.95, 0.7, 0.85].map((c) =>
      decision('LOW', [vote('openai', true, c), vote('google', true, c)]),
    );
    const r = triage(ds);
    expect(r.filter((x) => x.status === 'auto_accepted')).toHaveLength(4);
    expect(r[3].status).toBe('pending_review');
  });
  it('never auto-accepts a decision a seat rejected or did not vote on', () => {
    const ds = [
      decision('LOW', [vote('openai', true, 0.9), vote('google', false, 0.9)]),
      decision('LOW', [vote('openai', true, 0.9)]),
      decision('LOW', [vote('openai', true, 0.9), vote('google', true, 0.9)]),
      decision('LOW', [vote('openai', true, 0.9), vote('google', true, 0.9)]),
      decision('HIGH', [vote('openai', true, 0.9), vote('google', true, 0.9)]),
    ];
    const r = triage(ds);
    expect(r.map((x) => x.status)).toEqual([
      'pending_review',
      'pending_review',
      'auto_accepted',
      'auto_accepted',
      'auto_accepted',
    ]);
  });
  it('scales the quota with fewer decisions', () => {
    const ds = [1, 1, 1].map(() =>
      decision('LOW', [vote('openai', true, 1), vote('google', true, 1)]),
    );
    expect(triage(ds).filter((x) => x.status === 'auto_accepted')).toHaveLength(2);
  });
});

class FakeLLM implements CouncilLLM {
  calls: { seat: Seat; user: string }[] = [];
  constructor(private delayMs = 0) {}
  model(seat: Seat) {
    return `fake-${seat}`;
  }
  async embed(texts: string[]) {
    return { vectors: texts.map((t) => [t.includes('cache') ? 1 : 0, 1]), tokens: texts.length };
  }
  async chat(seat: Seat, r: ChatRequest) {
    this.calls.push({ seat, user: r.user });
    if (this.delayMs)
      await new Promise((res, rej) => {
        const t = setTimeout(res, this.delayMs);
        r.signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))));
      });
    const props = Object.keys((r.schema as any).properties);
    let out: unknown;
    if (props.includes('documentQuery'))
      out = {
        summary: `${seat} view`,
        strengths: ['ok'],
        risks: [],
        documentQuery: 'cache policy',
      };
    else if (props.includes('candidates'))
      out = {
        reply: 'agree',
        agreements: [],
        disagreements: [],
        candidates: [{ title: `${seat} idea`, rationale: 'x', risk: 'LOW' }],
      };
    else if (props.includes('decisions'))
      out = {
        decisions: [1, 2, 3, 4, 5].map((i) => ({
          title: `Decision ${i}`,
          rationale: 'because',
          risk: 'LOW',
        })),
      };
    else
      out = {
        votes: [0, 1, 2, 3, 4].map((index) => ({
          index,
          approve: true,
          confidence: 0.9 - index / 100,
          comment: 'fine',
        })),
      };
    return {
      text: JSON.stringify(out),
      inputTokens: 100,
      outputTokens: 50,
      model: this.model(seat),
    };
  }
}

let db: DB, app: FastifyInstance, cookie: string, projectId: string;
beforeAll(async () => {
  db = await connectDatabase({ memory: true });
  await migrate(db);
  await seedDemo(db);
  app = (await buildApp(db, { worker: false, logger: false })).app;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: headers(),
    payload: { email: 'demo@agentspace.local', password: 'ShopSphere-local-2026!' },
  });
  cookie = login.headers['set-cookie']!.toString().split(';')[0];
  projectId = (await app.inject({ url: '/api/projects', headers: headers(cookie) })).json()
    .projects[0].id;
});
afterAll(async () => {
  setCouncilLLM(undefined);
  await app.close();
  await db.close();
});
/** Registers a user and adds them to the project with a role (null: not a member). Returns their cookie. */
async function member(email: string, role: string | null) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: headers(),
    payload: { email, name: email.split('@')[0], password: 'Safe-test-password-2026!' },
  });
  if (role)
    await db.query('INSERT INTO project_members VALUES($1,$2,$3)', [
      projectId,
      r.json().user.id,
      role,
    ]);
  return r.headers['set-cookie']!.toString().split(';')[0];
}
async function waitFor(id: string) {
  for (let i = 0; i < 200; i++) {
    const r = (
      await app.inject({
        url: `/api/projects/${projectId}/council/${id}`,
        headers: headers(cookie),
      })
    ).json();
    if (r.session.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('council did not finish');
}

describe('council sessions', () => {
  it('runs both sandboxes, uses documents, and applies the 4-of-5 rule', async () => {
    const fake = new FakeLLM();
    setCouncilLLM(fake);
    await db.query(
      "INSERT INTO knowledge_sources(id,project_id,title,kind,content) VALUES('k1',$1,'Cache policy','document','Responses are cached for 15 minutes in Redis.')",
      [projectId],
    );
    const start = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/council`,
      headers: headers(cookie),
      payload: { topic: 'Review' },
    });
    expect(start.statusCode).toBe(200);
    const r = await waitFor(start.json().id);
    expect(r.session.status).toBe('completed');
    expect(r.session.rag_mode).toBe('embedding');
    expect(r.events.filter((e: any) => e.kind === 'sandbox_locked')).toHaveLength(2);
    expect(
      r.events.some((e: any) => e.kind === 'rag' && e.content.hits[0].title === 'Cache policy'),
    ).toBe(true);
    // Opinions are independent: neither room's first prompt contains the other seat's opinion.
    const opinions = fake.calls.slice(0, 2);
    expect(opinions.map((c) => c.seat).sort()).toEqual(['google', 'openai']);
    expect(opinions.every((c) => !/(openai|google) view/.test(c.user))).toBe(true);
    // The consultation is where each room first reads the other's opinion.
    const consult = fake.calls.find(
      (c) => c.seat === 'openai' && c.user.includes("Gemini's opinion"),
    );
    expect(consult?.user).toContain('google view');
    expect(r.decisions.filter((d: any) => d.status === 'auto_accepted')).toHaveLength(4);
    const pending = r.decisions.filter((d: any) => d.status === 'pending_review');
    expect(pending).toHaveLength(1);
    expect(r.session.report_artifact_id).toBeTruthy();

    // Senior review is for owners and admins only; viewers cannot start sessions; outsiders see nothing.
    const viewer = await member('council-viewer@example.test', 'VIEWER');
    const reviewer = await member('council-reviewer@example.test', 'REVIEWER');
    const outsider = await member('council-outsider@example.test', null);
    const decide = (who: string) =>
      app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/council/decisions/${pending[0].id}`,
        headers: headers(who),
        payload: { decision: 'approved' },
      });
    expect((await decide(viewer)).statusCode).toBe(403);
    expect((await decide(reviewer)).statusCode).toBe(403);
    expect((await decide(outsider)).statusCode).toBe(404);
    const viewerStart = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/council`,
      headers: headers(viewer),
      payload: {},
    });
    expect(viewerStart.statusCode).toBe(403);
    const outsiderRead = await app.inject({
      url: `/api/projects/${projectId}/council/${start.json().id}`,
      headers: headers(outsider),
    });
    expect(outsiderRead.statusCode).toBe(404);

    const review = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/council/decisions/${pending[0].id}`,
      headers: headers(cookie),
      payload: { decision: 'approved', note: 'Looks right.' },
    });
    expect(review.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/council/decisions/${pending[0].id}`,
      headers: headers(cookie),
      payload: { decision: 'rejected' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('stops at the token limit and keeps partial work for review', async () => {
    setCouncilLLM(new FakeLLM());
    process.env.COUNCIL_TOKEN_LIMIT = '4000';
    try {
      const start = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/council`,
        headers: headers(cookie),
        payload: {},
      });
      const r = await waitFor(start.json().id);
      expect(r.session.status).toBe('limit_reached');
      expect(r.session.tokens_used).toBeLessThanOrEqual(4000);
      expect(r.decisions.every((d: any) => d.status === 'pending_review')).toBe(true);
    } finally {
      delete process.env.COUNCIL_TOKEN_LIMIT;
    }
  });

  it('stops at the time limit', async () => {
    setCouncilLLM(new FakeLLM(40000));
    process.env.COUNCIL_TIME_LIMIT_SECONDS = '30';
    try {
      const start = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/council`,
        headers: headers(cookie),
        payload: {},
      });
      const second = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/council`,
        headers: headers(cookie),
        payload: {},
      });
      expect(second.statusCode).toBe(409);
      let r;
      for (let i = 0; i < 400; i++) {
        r = (
          await app.inject({
            url: `/api/projects/${projectId}/council/${start.json().id}`,
            headers: headers(cookie),
          })
        ).json();
        if (r.session.status !== 'running') break;
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(r.session.status).toBe('limit_reached');
      expect(
        r.events.some((e: any) => e.kind === 'limit_reached' && e.content.reason === 'time'),
      ).toBe(true);
    } finally {
      delete process.env.COUNCIL_TIME_LIMIT_SECONDS;
    }
  }, 45000);
});
