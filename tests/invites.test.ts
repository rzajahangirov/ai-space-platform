import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { connectDatabase, migrate, type DB } from '../server/db';
import { seedDemo } from '../server/db/seed';
import { buildApp } from '../server/app';
import { hash, token, uid } from '../server/core';

let db: DB, app: FastifyInstance, owner: string, projectId: string;
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
// Registration is rate limited (as it should be); test users get sessions directly.
async function user(email: string, name: string) {
  const id = uid(),
    session = token();
  await db.query('INSERT INTO users(id,email,name) VALUES($1,$2,$3)', [id, email, name]);
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [hash(session), id],
  );
  return `agentspace_session=${session}`;
}
const tokenOf = (url: string) => url.split('/').at(-1)!;
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
  owner = login.headers['set-cookie']!.toString().split(';')[0];
  projectId = (await call('GET', '/projects', owner)).json().projects[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('share links', () => {
  it('a reusable link admits up to max uses, opens its conversation, and notifies the inviter', async () => {
    const conversation = (
      await call('POST', `/projects/${projectId}/conversations`, owner, { title: 'Checkout room' })
    ).json();
    const link = (
      await call('POST', `/projects/${projectId}/invites`, owner, {
        kind: 'link',
        role: 'REVIEWER',
        maxUses: 2,
        expiresInHours: 24,
        conversationId: conversation.id,
      })
    ).json();
    expect(link).toMatchObject({ kind: 'link', maxUses: 2, mailto: null });
    const value = tokenOf(link.url);
    const a = await user('a@example.test', 'Aysel A'),
      b = await user('b@example.test', 'Bob B'),
      c = await user('c@example.test', 'Cem C');
    const preview = (await call('GET', `/invites/${value}`, a)).json();
    expect(preview).toMatchObject({
      projectName: 'ShopSphere',
      conversationTitle: 'Checkout room',
      role: 'REVIEWER',
      alreadyMember: false,
    });
    const joined = (await call('POST', `/invites/${value}/accept`, a, {})).json();
    expect(joined).toEqual({ projectId, conversationId: conversation.id, joined: true });
    // Accepting again as a member is harmless and does not use up the link.
    expect((await call('POST', `/invites/${value}/accept`, a, {})).json().joined).toBe(false);
    expect((await call('POST', `/invites/${value}/accept`, b, {})).statusCode).toBe(200);
    expect((await call('POST', `/invites/${value}/accept`, c, {})).statusCode).toBe(410);
    const roles = await db.query(
      'SELECT role FROM project_members WHERE project_id=$1 AND role=$2',
      [projectId, 'REVIEWER'],
    );
    expect(roles).toHaveLength(2);
    const inbox = (await call('GET', '/notifications', owner)).json().notifications;
    expect(inbox.filter((n: any) => n.kind === 'member_joined').map((n: any) => n.title)).toEqual(
      expect.arrayContaining(['Aysel A joined as reviewer', 'Bob B joined as reviewer']),
    );
  });
  it('links cannot grant admin; email invites can, and come with a mail draft', async () => {
    expect(
      (await call('POST', `/projects/${projectId}/invites`, owner, { kind: 'link', role: 'ADMIN' }))
        .statusCode,
    ).toBe(400);
    const invite = (
      await call('POST', `/projects/${projectId}/invites`, owner, {
        kind: 'email',
        role: 'ADMIN',
        email: 'Lead@Example.test',
      })
    ).json();
    expect(invite.maxUses).toBe(1);
    expect(invite.mailto).toMatch(/^mailto:lead%40example\.test\?subject=/);
    expect(decodeURIComponent(invite.mailto)).toContain(invite.url);
    const other = await user('other@example.test', 'Other');
    expect(
      (await call('POST', `/invites/${tokenOf(invite.url)}/accept`, other, {})).statusCode,
    ).toBe(403);
    expect((await call('GET', `/invites/${tokenOf(invite.url)}`, other)).json().emailMatches).toBe(
      false,
    );
  });
  it('revoked links stop working immediately and only admins manage links', async () => {
    const link = (
      await call('POST', `/projects/${projectId}/invites`, owner, { kind: 'link', role: 'VIEWER' })
    ).json();
    const reviewer = await user('r@example.test', 'Rev');
    await db.query(
      "INSERT INTO project_members SELECT $1,id,'REVIEWER' FROM users WHERE email='r@example.test'",
      [projectId],
    );
    expect((await call('GET', `/projects/${projectId}/invites`, reviewer)).statusCode).toBe(403);
    expect(
      (await call('DELETE', `/projects/${projectId}/invites/${link.id}`, reviewer)).statusCode,
    ).toBe(403);
    const listed = (await call('GET', `/projects/${projectId}/invites`, owner)).json().invites;
    expect(listed.some((i: any) => i.id === link.id && i.use_count === 0)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(tokenOf(link.url));
    expect(
      (await call('DELETE', `/projects/${projectId}/invites/${link.id}`, owner)).statusCode,
    ).toBe(200);
    const late = await user('late@example.test', 'Late');
    expect((await call('POST', `/invites/${tokenOf(link.url)}/accept`, late, {})).statusCode).toBe(
      410,
    );
    expect(
      (await call('GET', `/projects/${projectId}/invites`, owner))
        .json()
        .invites.some((i: any) => i.id === link.id),
    ).toBe(false);
  });
  it('rejects conversations from other projects and expired links', async () => {
    expect(
      (
        await call('POST', `/projects/${projectId}/invites`, owner, {
          kind: 'link',
          role: 'VIEWER',
          conversationId: 'nope',
        })
      ).statusCode,
    ).toBe(404);
    const link = (
      await call('POST', `/projects/${projectId}/invites`, owner, { kind: 'link', role: 'VIEWER' })
    ).json();
    await db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [
      link.id,
    ]);
    const late = await user('expired@example.test', 'Expired');
    expect((await call('POST', `/invites/${tokenOf(link.url)}/accept`, late, {})).statusCode).toBe(
      410,
    );
  });
});
