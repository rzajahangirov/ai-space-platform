import { it, expect, vi } from 'vitest';
import { connectDatabase, migrate } from '../server/db';
import { seedDemo } from '../server/db/seed';
import { buildApp } from '../server/app';

it('routes a selected Meta reviewer through the existing workflow and fails closed without credentials', async () => {
  vi.stubEnv('MODEL_API_KEY', '');
  vi.stubEnv('LIVE_REVIEW', 'off');
  const db = await connectDatabase({ memory: true });
  await migrate(db);
  await seedDemo(db);
  const { app, runtime } = await buildApp(db, { worker: false, logger: false });
  try {
    const headers: Record<string, string> = {
      origin: 'http://localhost:5173',
      'x-agentspace-request': '1',
    };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { email: 'demo@agentspace.local', password: 'ShopSphere-local-2026!' },
    });
    expect(login.statusCode).toBe(200);
    headers.cookie = login.headers['set-cookie']!.toString().split(';')[0];
    const projects = (await app.inject({ url: '/api/projects', headers })).json().projects;
    const id = projects[0].id;
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/agents`,
      headers,
      payload: {
        name: 'Meta Reviewer',
        role: 'architect',
        description: '',
        provider: 'meta',
        model: 'muse-spark-1.3',
        instructions: 'Review evidence.',
        enabled: true,
      },
    });
    expect(created.statusCode).toBe(200);
    await runtime.tick(); // Drain the pre-existing local seed run first.
    const [before] = await db.query('SELECT revision FROM projects WHERE id=$1', [id]);
    const review = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/reviews`,
      headers,
      payload: {
        prompt: 'Review payment risks and assumptions.',
        componentId: 'payments',
        agentId: created.json().id,
      },
    });
    expect(review.statusCode).toBe(200);
    await runtime.tick();
    const runs = await db.query('SELECT status,error FROM agent_runs WHERE conversation_id=$1', [
      review.json().conversationId,
    ]);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toContain('MODEL_API_KEY');
    const [after] = await db.query('SELECT revision FROM projects WHERE id=$1', [id]);
    expect(after.revision).toBe(before.revision);
    vi.stubEnv('MODEL_API_KEY', 'mock-only');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  message:
                    'Mock review: payment access needs human assessment. Assumption: configuration reflects intent.',
                  findings: [],
                  additions: [],
                  delegates: [],
                  proposals: [
                    {
                      componentId: 'payments',
                      title: 'Mock scoped payment access',
                      reason: 'payments.config.databaseAccess',
                      risk: 'MEDIUM',
                      tradeoffs: 'Validate access requirements before implementation.',
                      configKey: 'databaseAccess',
                      configValue: 'payment schema only',
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const success = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/reviews`,
      headers,
      payload: {
        prompt: 'Review payment access.',
        componentId: 'payments',
        agentId: created.json().id,
      },
    });
    expect(success.statusCode).toBe(200);
    await runtime.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [message] = await db.query(
      "SELECT model FROM messages WHERE conversation_id=$1 AND actor_type='agent'",
      [success.json().conversationId],
    );
    expect(message.model).toBe('muse-spark-1.3');
    const [proposal] = await db.query(
      "SELECT id,status FROM proposals WHERE project_id=$1 AND title='Mock scoped payment access'",
      [id],
    );
    expect(proposal.status).toBe('PENDING');
    expect((await db.query('SELECT revision FROM projects WHERE id=$1', [id]))[0].revision).toBe(
      before.revision,
    );
    const approved = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/proposals/${proposal.id}/decision`,
      headers,
      payload: { decision: 'APPROVED' },
    });
    expect(approved.statusCode).toBe(200);
    expect((await db.query('SELECT revision FROM projects WHERE id=$1', [id]))[0].revision).toBe(
      before.revision + 1,
    );
  } finally {
    await app.close();
    await db.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
