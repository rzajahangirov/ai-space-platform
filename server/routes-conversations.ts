import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db';
import { audit, authorize, emit, HttpError, uid, type Actor } from './core';
import { enqueueRun, generalConversation } from './agents/runtime';
import { notify, projectParticipants, resolveMentions } from './mentions';
import type { RealtimeHub } from './realtime';

const pid = (r: FastifyRequest) => (r.params as { id: string }).id;
const param = (r: FastifyRequest, name: string) => (r.params as Record<string, string>)[name];
const content = z.string().trim().min(1).max(8000);
const artifactKinds = [
  'document',
  'review',
  'plan',
  'api_spec',
  'runbook',
  'report',
  'adr',
] as const;

async function conversationOf(db: DB, projectId: string, conversationId: string) {
  const [conversation] = await db.query(
    'SELECT * FROM conversations WHERE project_id=$1 AND id=$2',
    [projectId, conversationId],
  );
  if (!conversation) throw new HttpError(404, 'Conversation not found.');
  return conversation;
}

/** Saves a human message; @mentioned (or explicitly chosen) agents answer in the same conversation. */
export async function postMessage(
  db: DB,
  actor: Actor,
  projectId: string,
  input: { content: string; conversationId?: string; agentIds?: string[]; componentId?: string },
) {
  await authorize(db, actor, projectId, 'comment');
  const conversationId = input.conversationId
    ? (await conversationOf(db, projectId, input.conversationId)).id
    : await generalConversation(db, projectId);
  const participants = await projectParticipants(db, projectId);
  const mentions = resolveMentions(input.content, participants.agents, participants.members);
  const agentIds = [...new Set([...(input.agentIds ?? []), ...mentions.agentIds])];
  let run: unknown = null;
  // Queue validation comes before saving the message; a rejected request creates no duplicate.
  await db.transaction(async (tx) => {
    if (agentIds.length)
      run = await enqueueRun(tx, projectId, actor, {
        prompt: input.content,
        componentId: input.componentId,
        agentIds,
        source: 'chat',
        conversationId,
      });
    await tx.query(
      'INSERT INTO messages(id,project_id,conversation_id,user_id,actor_type,author_name,content) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [uid(), projectId, conversationId, actor.id, 'human', actor.name, input.content],
    );
    await tx.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversationId]);
    await notify(
      tx,
      projectId,
      mentions.userIds,
      {
        kind: 'mention',
        title: `${actor.name} mentioned you in a conversation`,
        body: input.content.slice(0, 300),
        actorName: actor.name,
        page: 'Conversations',
        componentId: input.componentId,
      },
      actor.id,
    );
    await emit(tx, projectId, 'MESSAGE_CREATED', { conversationId });
  });
  return { ok: true, run, conversationId };
}

export function registerConversationRoutes(app: FastifyInstance, db: DB, hub: RealtimeHub) {
  app.post('/api/projects/:id/messages', async (request) => {
    const data = z
      .object({
        content,
        conversationId: z.string().max(100).optional(),
        agentId: z.string().max(100).optional(),
        agentIds: z.array(z.string().max(100)).max(3).optional(),
        componentId: z.string().max(100).optional(),
      })
      .parse(request.body);
    const result = await postMessage(db, request.actor, pid(request), {
      content: data.content,
      conversationId: data.conversationId,
      agentIds: [...(data.agentId ? [data.agentId] : []), ...(data.agentIds ?? [])],
      componentId: data.componentId,
    });
    hub.broadcast(pid(request));
    return result;
  });

  app.get('/api/projects/:id/conversations', async (request) => {
    await authorize(db, request.actor, pid(request));
    return {
      conversations: await db.query(
        `SELECT c.id,c.title,c.kind,c.updated_at,c.created_at,u.name AS created_by_name,
           (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS message_count,
           (SELECT left(m.content,140) FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS preview,
           (SELECT m.author_name FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS preview_author,
           EXISTS(SELECT 1 FROM agent_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running')) AS active
         FROM conversations c LEFT JOIN users u ON u.id=c.created_by
         WHERE c.project_id=$1 ORDER BY c.updated_at DESC LIMIT 100`,
        [pid(request)],
      ),
    };
  });

  app.post('/api/projects/:id/conversations', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'comment');
    const data = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        content: content.optional(),
        agentIds: z.array(z.string().max(100)).max(3).optional(),
        componentId: z.string().max(100).optional(),
      })
      .strict()
      .parse(request.body);
    const id = uid();
    const title =
      data.title ??
      (data.content ? data.content.replace(/\s+/g, ' ').slice(0, 70) : 'New conversation');
    await db.query(
      'INSERT INTO conversations(id,project_id,title,created_by) VALUES($1,$2,$3,$4)',
      [id, projectId, title, request.actor.id],
    );
    let run: unknown = null;
    if (data.content)
      try {
        run = (
          await postMessage(db, request.actor, projectId, {
            content: data.content,
            conversationId: id,
            agentIds: data.agentIds,
            componentId: data.componentId,
          })
        ).run;
      } catch (e) {
        await db.query('DELETE FROM conversations WHERE id=$1', [id]);
        throw e;
      }
    hub.broadcast(projectId);
    return { id, title, run };
  });

  app.get('/api/projects/:id/conversations/:conversationId', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId);
    const conversation = await conversationOf(db, projectId, param(request, 'conversationId'));
    const messages = (
      await db.query(
        'SELECT id,author_name,actor_type,content,created_at,agent_id,user_id,run_id,model FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 200',
        [conversation.id],
      )
    ).reverse();
    const runs = await db.query(
      `SELECT id,status,source,error,current_agent_id,current_step,input_tokens,output_tokens,participant_ids,created_at,started_at,finished_at
       FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 40`,
      [conversation.id],
    );
    const ids = runs.map((r) => r.id);
    return {
      conversation,
      messages,
      runs,
      steps: ids.length
        ? await db.query(
            'SELECT id,run_id,agent_id,tool,operation,status,input_summary,result_summary,duration_ms,created_at FROM tool_executions WHERE run_id=ANY($1::text[]) ORDER BY created_at',
            [ids],
          )
        : [],
      proposals: ids.length
        ? await db.query(
            'SELECT p.*,a.name AS agent_name FROM proposals p JOIN agents a ON a.id=p.agent_id WHERE p.run_id=ANY($1::text[]) ORDER BY p.created_at',
            [ids],
          )
        : [],
      findings: ids.length
        ? await db.query(
            'SELECT id,run_id,agent_id,component_id,severity,category,title,status FROM findings WHERE run_id=ANY($1::text[]) ORDER BY created_at',
            [ids],
          )
        : [],
      artifacts: ids.length
        ? await db.query(
            'SELECT id,run_id,agent_id,title,kind,revision,updated_at FROM artifacts WHERE run_id=ANY($1::text[]) ORDER BY created_at',
            [ids],
          )
        : [],
    };
  });

  app.patch('/api/projects/:id/conversations/:conversationId', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'comment');
    const data = z
      .object({ title: z.string().trim().min(1).max(120) })
      .strict()
      .parse(request.body);
    const conversation = await conversationOf(db, projectId, param(request, 'conversationId'));
    await db.query('UPDATE conversations SET title=$1 WHERE id=$2', [data.title, conversation.id]);
    hub.broadcast(projectId);
    return { ok: true };
  });

  // A review is its own conversation, so its discussion stays together.
  app.post('/api/projects/:id/reviews', async (request) => {
    const projectId = pid(request);
    const data = z
      .object({
        prompt: content,
        componentId: z.string().max(100).optional(),
        agentId: z.string().max(100).optional(),
      })
      .parse(request.body);
    await authorize(db, request.actor, projectId, 'review');
    const [component] = data.componentId
      ? await db.query('SELECT name FROM components WHERE project_id=$1 AND id=$2', [
          projectId,
          data.componentId,
        ])
      : [];
    const conversationId = uid();
    const result = await db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO conversations(id,project_id,title,created_by) VALUES($1,$2,$3,$4)',
        [
          conversationId,
          projectId,
          component ? `Review: ${component.name}` : 'Architecture review',
          request.actor.id,
        ],
      );
      const run = await enqueueRun(tx, projectId, request.actor, {
        prompt: data.prompt,
        componentId: data.componentId,
        agentIds: data.agentId ? [data.agentId] : [],
        source: 'review',
        conversationId,
      });
      await tx.query(
        'INSERT INTO messages(id,project_id,conversation_id,user_id,actor_type,author_name,content) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          uid(),
          projectId,
          conversationId,
          request.actor.id,
          'human',
          request.actor.name,
          data.prompt,
        ],
      );
      return run;
    });
    hub.broadcast(projectId);
    return result;
  });

  // ---------- Artifacts ----------
  app.get('/api/projects/:id/artifacts', async (request) => {
    await authorize(db, request.actor, pid(request));
    return {
      artifacts: await db.query(
        `SELECT ar.id,ar.title,ar.kind,ar.revision,ar.updated_at,ar.created_at,ar.conversation_id,
           COALESCE(a.name,u.name) AS author_name, CASE WHEN ar.agent_id IS NULL THEN 'human' ELSE 'agent' END AS author_type,
           length(ar.content) AS size
         FROM artifacts ar LEFT JOIN agents a ON a.id=ar.agent_id LEFT JOIN users u ON u.id=ar.user_id
         WHERE ar.project_id=$1 ORDER BY ar.updated_at DESC LIMIT 200`,
        [pid(request)],
      ),
    };
  });
  app.get('/api/projects/:id/artifacts/:artifactId', async (request) => {
    await authorize(db, request.actor, pid(request));
    const [artifact] = await db.query(
      `SELECT ar.*,COALESCE(a.name,u.name) AS author_name FROM artifacts ar LEFT JOIN agents a ON a.id=ar.agent_id
       LEFT JOIN users u ON u.id=ar.user_id WHERE ar.project_id=$1 AND ar.id=$2`,
      [pid(request), param(request, 'artifactId')],
    );
    if (!artifact) throw new HttpError(404, 'Artifact not found.');
    return { artifact };
  });
  app.post('/api/projects/:id/artifacts', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'edit');
    const data = z
      .object({
        title: z.string().trim().min(1).max(160),
        kind: z.enum(artifactKinds),
        content: z.string().min(1).max(60000),
      })
      .strict()
      .parse(request.body);
    const id = uid();
    await db.query(
      'INSERT INTO artifacts(id,project_id,title,kind,content,user_id) VALUES($1,$2,$3,$4,$5,$6)',
      [id, projectId, data.title, data.kind, data.content, request.actor.id],
    );
    await audit(db, projectId, request.actor, 'artifact.created', data.title);
    hub.broadcast(projectId);
    return { id };
  });
  app.patch('/api/projects/:id/artifacts/:artifactId', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'edit');
    const data = z
      .object({
        title: z.string().trim().min(1).max(160),
        content: z.string().min(1).max(60000),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    // Optimistic concurrency: an edit based on an older revision never overwrites newer work.
    const [row] = await db.query(
      'UPDATE artifacts SET title=$1,content=$2,revision=revision+1,user_id=$3,agent_id=NULL,updated_at=now() WHERE project_id=$4 AND id=$5 AND revision=$6 RETURNING revision',
      [
        data.title,
        data.content,
        request.actor.id,
        projectId,
        param(request, 'artifactId'),
        data.revision,
      ],
    );
    if (!row)
      throw new HttpError(409, 'This document changed since you opened it. Reload before saving.');
    await audit(db, projectId, request.actor, 'artifact.updated', data.title);
    hub.broadcast(projectId);
    return { revision: row.revision };
  });

  // ---------- Model routing for all project agents ----------
  app.post('/api/projects/:id/agents/model', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'manage');
    const data = z
      .object({
        provider: z.enum(['local', 'openai', 'anthropic', 'google']),
        model: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(request.body);
    const rows = await db.query(
      'UPDATE agents SET provider=$1,model=$2,updated_at=now() WHERE project_id=$3 RETURNING id',
      [data.provider, data.model, projectId],
    );
    await audit(
      db,
      projectId,
      request.actor,
      'agent.configured',
      `Switched ${rows.length} agents to ${data.provider}/${data.model}.`,
      data,
    );
    hub.broadcast(projectId);
    return { updated: rows.length };
  });
}
