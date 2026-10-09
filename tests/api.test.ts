import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { connectDatabase, migrate, type DB } from '../server/db';
import { seedDemo } from '../server/db/seed';
import { buildApp } from '../server/app';
import { hash, uid } from '../server/core';
import { ToolRegistry } from '../server/agents/tools';
import { z } from 'zod';
let db: DB, app: FastifyInstance, runtime: Awaited<ReturnType<typeof buildApp>>['runtime'];
let ownerCookie: string,
  viewerCookie: string,
  reviewerCookie: string,
  outsiderCookie: string,
  projectId: string,
  viewerId: string,
  ownerId: string;
const headers = (cookie?: string) => ({
  'x-agentspace-request': '1',
  origin: 'http://localhost:5173',
  ...(cookie ? { cookie } : {}),
});
async function register(email: string, name: string) {
  const result = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: headers(),
    payload: { email, name, password: 'Safe-test-password-2026!' },
  });
  expect(result.statusCode).toBe(200);
  return {
    cookie: result.headers['set-cookie']!.toString().split(';')[0],
    user: result.json().user,
  };
}
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
  expect(login.statusCode).toBe(200);
  ownerCookie = login.headers['set-cookie']!.toString().split(';')[0];
  ownerId = login.json().user.id;
  projectId = (await app.inject({ url: '/api/projects', headers: headers(ownerCookie) })).json()
    .projects[0].id;
  const viewer = await register('viewer@example.test', 'Viewer');
  viewerCookie = viewer.cookie;
  viewerId = viewer.user.id;
  const reviewer = await register('reviewer@example.test', 'Reviewer');
  reviewerCookie = reviewer.cookie;
  const outsider = await register('outsider@example.test', 'Outsider');
  outsiderCookie = outsider.cookie;
  await db.query("INSERT INTO project_members VALUES($1,$2,'VIEWER'),($1,$3,'REVIEWER')", [
    projectId,
    viewerId,
    reviewer.user.id,
  ]);
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});
describe('authentication and tenancy', () => {
  it('rejects unauthenticated and cross-origin WebSocket upgrades', async () => {
    await expect(
      app.injectWS(`/api/projects/${projectId}/live`, {
        headers: { origin: 'http://localhost:5173' },
      }),
    ).rejects.toThrow();
    await expect(
      app.injectWS(`/api/projects/${projectId}/live`, {
        headers: { cookie: ownerCookie, origin: 'https://attacker.test' },
      }),
    ).rejects.toThrow();
  });
  it('requires a session', async () =>
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401));
  it('rejects missing CSRF header and foreign origin', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { cookie: ownerCookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...headers(ownerCookie), origin: 'https://attacker.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it('cannot read a project through guessed identifiers', async () => {
    expect(
      (
        await app.inject({
          url: `/api/projects/${projectId}/snapshot`,
          headers: headers(outsiderCookie),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/projects', headers: headers(outsiderCookie) })).json()
        .projects,
    ).toEqual([]);
  });
  it('viewer cannot mutate, invite, review, or send messages', async () => {
    for (const [endpoint, payload] of [
      [
        'graph',
        { revision: 0, changes: [{ type: 'component.delete', id: 'web' }], summary: 'delete' },
      ],
      ['invites', { role: 'EDITOR' }],
      ['reviews', { prompt: 'review' }],
      ['messages', { content: 'hello' }],
    ] as const) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/${endpoint}`,
            headers: headers(viewerCookie),
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }
  });
  it('invites are hashed, email-restricted, single-use, and project-scoped', async () => {
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/invites`,
      headers: headers(ownerCookie),
      payload: { role: 'EDITOR', email: 'outsider@example.test' },
    });
    expect(invitation.statusCode).toBe(200);
    const value = invitation.json().url.split('/').at(-1);
    const [record] = await db.query('SELECT * FROM invitations WHERE token_hash=$1', [hash(value)]);
    expect(record.token_hash).not.toBe(value);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/invites/${value}/accept`,
          headers: headers(viewerCookie),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/invites/${value}/accept`,
          headers: headers(outsiderCookie),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/invites/${value}/accept`,
          headers: headers(outsiderCookie),
          payload: {},
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (await app.inject({ url: '/api/workspaces', headers: headers(outsiderCookie) })).json()
        .workspaces,
    ).toHaveLength(0);
  });
});
describe('graph persistence and proposals', () => {
  it('serializes competing edits and saves exactly one version', async () => {
    const before = (
      await app.inject({
        url: `/api/projects/${projectId}/snapshot`,
        headers: headers(ownerCookie),
      })
    ).json();
    const requests = [1, 2].map((n) =>
      app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/graph`,
        headers: headers(ownerCookie),
        payload: {
          revision: before.project.revision,
          summary: `Concurrent ${n}`,
          changes: [
            {
              type: 'component.upsert',
              component: { ...before.graph.components[0], name: `Changed ${n}` },
            },
          ],
        },
      }),
    );
    expect((await Promise.all(requests)).map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const after = (
      await app.inject({
        url: `/api/projects/${projectId}/snapshot`,
        headers: headers(ownerCookie),
      })
    ).json();
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect(after.versions).toHaveLength(before.versions.length + 1);
  });
  it('rejects cross-project edge endpoints atomically', async () => {
    const [project] = await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]);
    const result = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/graph`,
      headers: headers(ownerCookie),
      payload: {
        revision: project.revision,
        summary: 'bad edge',
        changes: [
          {
            type: 'edge.upsert',
            edge: {
              id: 'bad',
              source: 'web',
              target: 'foreign-node',
              protocol: 'HTTPS',
              metadata: {},
            },
          },
        ],
      },
    });
    expect(result.statusCode).toBe(400);
    expect(
      (await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]))[0].revision,
    ).toBe(project.revision);
  });
  it('multi-agent reviews create evidence and proposals without mutating the graph', async () => {
    const [before] = await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]);
    await runtime.tick();
    const snapshot = (
      await app.inject({
        url: `/api/projects/${projectId}/snapshot`,
        headers: headers(ownerCookie),
      })
    ).json();
    expect(snapshot.project.revision).toBe(before.revision);
    expect(
      snapshot.messages.filter((m: any) => m.actor_type === 'agent').length,
    ).toBeGreaterThanOrEqual(3);
    expect(snapshot.findings.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.proposals.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.activity.some((a: any) => a.action === 'agent.delegated')).toBe(true);
    expect(snapshot.runs[0].status).toBe('completed');
  });
  it('only admins can approve, and approval is atomic and single-use', async () => {
    const [proposal] = await db.query(
      "SELECT * FROM proposals WHERE project_id=$1 AND status='PENDING' ORDER BY created_at LIMIT 1",
      [projectId],
    );
    expect(proposal).toBeTruthy();
    const url = `/api/projects/${projectId}/proposals/${proposal.id}/decision`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers(reviewerCookie),
          payload: { decision: 'APPROVED' },
        })
      ).statusCode,
    ).toBe(403);
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url,
          headers: headers(ownerCookie),
          payload: { decision: 'APPROVED' },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const [decided] = await db.query('SELECT * FROM proposals WHERE id=$1', [proposal.id]);
    expect(decided.decided_by).toBe(ownerId);
    expect(decided.before_state).not.toEqual(decided.after_state);
    expect(decided.status).toBe('APPROVED');
  });
  it('rejects a stale proposal but allows explicitly rejecting it', async () => {
    const [proposal] = await db.query(
      "SELECT * FROM proposals WHERE project_id=$1 AND status='PENDING' LIMIT 1",
      [projectId],
    );
    const url = `/api/projects/${projectId}/proposals/${proposal.id}/decision`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers(ownerCookie),
          payload: { decision: 'APPROVED' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers(ownerCookie),
          payload: { decision: 'REJECTED' },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('tool authorization rejects mismatched resources and records denied access', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test.write',
      description: 'test',
      operation: 'write',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('must never execute');
      },
    });
    const [agent] = await db.query('SELECT id FROM agents WHERE project_id=$1 LIMIT 1', [
      projectId,
    ]);
    const [run] = await db.query('SELECT id FROM agent_runs WHERE project_id=$1 LIMIT 1', [
      projectId,
    ]);
    const context = { db, projectId, agentId: agent.id, runId: run.id };
    await expect(registry.execute('test.write', 'foreign', {}, context)).rejects.toThrow('outside');
    await expect(registry.execute('test.write', projectId, {}, context)).rejects.toThrow('denied');
    expect(
      (await db.query("SELECT status FROM tool_executions WHERE tool='test.write'"))[0].status,
    ).toBe('denied');
  });
  it('expired sessions are rejected and cookies have security attributes', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: headers(),
      payload: { email: 'viewer@example.test', password: 'Safe-test-password-2026!' },
    });
    const cookie = login.headers['set-cookie']!.toString();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const value = cookie.split(';')[0].split('=')[1];
    await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [
      hash(value),
    ]);
    expect(
      (await app.inject({ url: '/api/projects', headers: headers(cookie.split(';')[0]) }))
        .statusCode,
    ).toBe(401);
  });
  it('deleting a component reviews the remaining graph and never restores the deletion', async () => {
    await db.query(
      "UPDATE agent_runs SET created_at=now()-interval '10 minutes' WHERE project_id=$1",
      [projectId],
    );
    const [project] = await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/graph`,
      headers: headers(ownerCookie),
      payload: {
        revision: project.revision,
        summary: 'Remove Redis cache',
        changes: [{ type: 'component.delete', id: 'redis' }],
      },
    });
    expect(response.statusCode).toBe(200);
    await runtime.tick();
    expect(
      await db.query("SELECT id FROM components WHERE project_id=$1 AND id='redis'", [projectId]),
    ).toHaveLength(0);
    expect(
      await db.query(
        "SELECT id FROM findings WHERE project_id=$1 AND title='Read-heavy service has no cache connection'",
        [projectId],
      ),
    ).toHaveLength(1);
    expect(
      (await db.query('SELECT revision FROM projects WHERE id=$1', [projectId]))[0].revision,
    ).toBe(project.revision + 1);
  });
});
