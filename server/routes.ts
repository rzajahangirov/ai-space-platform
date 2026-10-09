import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db';
import { uid, hash, token, authorize, HttpError, audit, emit } from './core';
import { mutationSchema, categories, graphSchema, roles } from '../shared/domain';
import { readGraph, mutateGraph, decideProposal } from './graph';
import { createProject } from './db/seed';
import { enqueueReview } from './agents/runtime';
import { registry } from './agents/tools';
import type { RealtimeHub } from './realtime';
import { notify, projectParticipants, resolveMentions } from './mentions';
import { registerObserveRoutes } from './routes-observe';
import { registerConversationRoutes } from './routes-conversations';
import { registerInviteRoutes } from './routes-invites';
import { registerCouncilRoutes } from './routes-council';
import { grantStandardTools } from './agents/defaults';
const pid = (r: FastifyRequest) => (r.params as { id: string }).id;
const text = z.string().trim().min(1).max(4000);

export function registerRoutes(app: FastifyInstance, db: DB, hub: RealtimeHub, origin: string) {
  app.get('/api/projects', async (request) => ({
    projects: await db.query(
      `SELECT p.*,m.role,w.name AS workspace_name FROM projects p JOIN project_members m ON m.project_id=p.id JOIN workspaces w ON w.id=p.workspace_id WHERE m.user_id=$1 ORDER BY p.created_at`,
      [request.actor.id],
    ),
  }));
  app.get('/api/workspaces', async (request) => ({
    workspaces: await db.query(
      'SELECT w.*,m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1',
      [request.actor.id],
    ),
  }));
  app.post('/api/projects', async (request) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        workspaceName: z.string().trim().min(1).max(80),
        workspaceId: z.string().optional(),
      })
      .parse(request.body);
    const id = await db.transaction(async (tx) => {
      if (
        data.workspaceId &&
        !(
          await tx.query(
            "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('OWNER','ADMIN')",
            [data.workspaceId, request.actor.id],
          )
        ).length
      )
        throw new HttpError(403, 'Workspace administration is required to create a project here.');
      return createProject(tx, request.actor, data.name, data.workspaceName, data.workspaceId);
    });
    return { id };
  });
  app.get('/api/notifications', async (request) => {
    // Membership is rechecked on read: removed members stop seeing a project's notifications.
    const notifications = await db.query(
      `SELECT n.*,p.name AS project_name FROM notifications n JOIN projects p ON p.id=n.project_id
       JOIN project_members m ON m.project_id=n.project_id AND m.user_id=n.user_id
       WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 60`,
      [request.actor.id],
    );
    return { notifications, unread: notifications.filter((n) => !n.read_at).length };
  });
  app.post('/api/notifications/read', async (request) => {
    const data = z
      .object({ ids: z.array(z.string().max(100)).max(100).optional() })
      .strict()
      .parse(request.body ?? {});
    await db.query(
      'UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND ($2::text[] IS NULL OR id=ANY($2::text[]))',
      [request.actor.id, data.ids ?? null],
    );
    return { ok: true };
  });
  registerObserveRoutes(app, db, hub);
  registerConversationRoutes(app, db, hub);
  registerInviteRoutes(app, db, hub, origin);
  registerCouncilRoutes(app, db, hub);
  app.get('/api/projects/:id/snapshot', async (request) =>
    db.transaction(async (tx) => {
      const id = pid(request),
        role = await authorize(tx, request.actor, id);
      const [project] = await tx.query(
        'SELECT p.*,w.name AS workspace_name FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1 FOR SHARE OF p',
        [id],
      );
      const graph = await readGraph(tx, id);
      const views = await tx.query(
        "SELECT * FROM architecture_views WHERE project_id=$1 ORDER BY CASE WHEN name='System overview' THEN 0 ELSE 1 END,name",
        [id],
      );
      const agents = await tx.query(
        'SELECT * FROM agents WHERE project_id=$1 ORDER BY created_at,id',
        [id],
      );
      const findings = await tx.query(
        'SELECT f.*,a.name AS agent_name FROM findings f JOIN agents a ON a.id=f.agent_id WHERE f.project_id=$1 ORDER BY f.created_at DESC LIMIT 300',
        [id],
      );
      const proposals = await tx.query(
        'SELECT p.*,a.name AS agent_name FROM proposals p JOIN agents a ON a.id=p.agent_id WHERE p.project_id=$1 ORDER BY p.created_at DESC LIMIT 100',
        [id],
      );
      const messages = (
        await tx.query(
          'SELECT * FROM messages WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
          [id],
        )
      ).reverse();
      const activity = await tx.query(
        'SELECT * FROM audit_logs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
        [id],
      );
      const members = await tx.query(
        'SELECT u.id,u.name,u.email,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.name',
        [id],
      );
      const versions = await tx.query(
        'SELECT v.*,u.name AS actor_name FROM architecture_versions v JOIN users u ON u.id=v.actor_id WHERE v.project_id=$1 ORDER BY revision DESC LIMIT 30',
        [id],
      );
      const comments = await tx.query(
        `SELECT c.*,COALESCE(u.name,a.name) AS author_name,CASE WHEN c.agent_id IS NULL THEN 'human' ELSE 'agent' END AS actor_type
         FROM comments c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN agents a ON a.id=c.agent_id WHERE c.project_id=$1 ORDER BY c.created_at`,
        [id],
      );
      const runs = await tx.query(
        'SELECT id,status,prompt,error,source,conversation_id,current_agent_id,current_step,input_tokens,output_tokens,created_at FROM agent_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',
        [id],
      );
      const usage = await tx.query(
        'SELECT * FROM usage_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 500',
        [id],
      );
      return {
        project: { ...project, role },
        graph,
        views,
        agents,
        findings,
        proposals,
        messages,
        activity,
        members,
        versions,
        comments,
        runs,
        usage,
        // Which model providers have server-side credentials (never the keys themselves).
        availableProviders: {
          openai: !!process.env.OPENAI_API_KEY,
          anthropic: !!process.env.ANTHROPIC_API_KEY,
          google: !!process.env.GOOGLE_API_KEY,
        },
        defaultModel: process.env.OPENAI_MODEL || 'gpt-5.5',
      };
    }),
  );
  app.post('/api/projects/:id/graph', async (request) => {
    const data = z
      .object({
        revision: z.number().int().nonnegative(),
        changes: z.array(mutationSchema).min(1).max(100),
        summary: z.string().min(1).max(200),
      })
      .strict()
      .parse(request.body);
    const result = await mutateGraph(
      db,
      pid(request),
      request.actor,
      data.revision,
      data.changes,
      data.summary,
    );
    hub.broadcast(pid(request));
    return { revision: result.revision };
  });
  app.post('/api/projects/:id/views', async (request) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        categories: z.array(z.enum(categories)).max(12),
      })
      .parse(request.body);
    await authorize(db, request.actor, pid(request), 'edit');
    const id = uid();
    await db.query(
      'INSERT INTO architecture_views(id,project_id,name,categories) VALUES($1,$2,$3,$4)',
      [id, pid(request), data.name, JSON.stringify(data.categories)],
    );
    await audit(db, pid(request), request.actor, 'view.created', data.name);
    hub.broadcast(pid(request));
    return { id };
  });
  app.patch('/api/projects/:id/members/:userId', async (request) => {
    await authorize(db, request.actor, pid(request), 'manage');
    const userId = (request.params as any).userId;
    const data = z
      .object({ role: z.enum(['ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER']) })
      .parse(request.body);
    const rows = await db.query(
      "UPDATE project_members SET role=$1 WHERE project_id=$2 AND user_id=$3 AND role<>'OWNER' RETURNING user_id",
      [data.role, pid(request), userId],
    );
    if (!rows.length) throw new HttpError(400, 'Cannot change this member.');
    await audit(
      db,
      pid(request),
      request.actor,
      'member.role_changed',
      `Changed a member role to ${data.role}.`,
      { userId },
    );
    hub.broadcast(pid(request));
    return { ok: true };
  });
  app.post('/api/projects/:id/proposals/:proposalId/decision', async (request) => {
    const data = z.object({ decision: z.enum(['APPROVED', 'REJECTED']) }).parse(request.body);
    const result = await decideProposal(
      db,
      pid(request),
      (request.params as any).proposalId,
      request.actor,
      data.decision,
    );
    hub.broadcast(pid(request));
    return result;
  });
  app.patch('/api/projects/:id/findings/:findingId', async (request) => {
    await authorize(db, request.actor, pid(request), 'review');
    const data = z
      .object({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']) })
      .parse(request.body);
    const rows = await db.query(
      'UPDATE findings SET status=$1 WHERE project_id=$2 AND id=$3 RETURNING id',
      [data.status, pid(request), (request.params as any).findingId],
    );
    if (!rows.length) throw new HttpError(404, 'Finding not found.');
    await audit(
      db,
      pid(request),
      request.actor,
      'finding.updated',
      `Marked finding ${data.status.toLowerCase()}.`,
      { findingId: (request.params as any).findingId },
    );
    hub.broadcast(pid(request));
    return { ok: true };
  });
  app.post('/api/projects/:id/comments', async (request) => {
    await authorize(db, request.actor, pid(request), 'comment');
    const data = z.object({ componentId: z.string(), content: text }).parse(request.body);
    if (
      !(
        await db.query('SELECT id FROM components WHERE project_id=$1 AND id=$2', [
          pid(request),
          data.componentId,
        ])
      ).length
    )
      throw new HttpError(404, 'Component not found.');
    const participants = await projectParticipants(db, pid(request));
    const mentions = resolveMentions(data.content, participants.agents, participants.members);
    await db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO comments(id,project_id,component_id,user_id,content) VALUES($1,$2,$3,$4,$5)',
        [uid(), pid(request), data.componentId, request.actor.id, data.content],
      );
      await emit(tx, pid(request), 'COMMENT_CREATED', { componentId: data.componentId });
      await notify(
        tx,
        pid(request),
        mentions.userIds,
        {
          kind: 'mention',
          title: `${request.actor.name} mentioned you on a component`,
          body: data.content.slice(0, 300),
          componentId: data.componentId,
          actorName: request.actor.name,
        },
        request.actor.id,
      );
    });
    // The comment is saved even if the agents are busy; the author is told instead of losing it.
    let agentNotice: string | null = null;
    if (mentions.agentIds.length)
      try {
        await enqueueReview(
          db,
          pid(request),
          request.actor,
          `Component thread question: ${data.content}`,
          data.componentId,
          mentions.agentIds[0],
          'comment',
          mentions.agentIds,
        );
        agentNotice = 'Mentioned agents will reply in this thread.';
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        agentNotice =
          e.statusCode === 403
            ? 'Your role cannot request agent reviews; the comment was saved.'
            : `Comment saved. Agents could not start: ${e.message}`;
      }
    hub.broadcast(pid(request));
    return { ok: true, agentNotice };
  });
  app.patch('/api/projects/:id/comments/:commentId', async (request) => {
    await authorize(db, request.actor, pid(request), 'review');
    const data = z.object({ resolved: z.boolean() }).parse(request.body);
    const rows = await db.query(
      'UPDATE comments SET resolved=$1 WHERE id=$2 AND project_id=$3 RETURNING id',
      [data.resolved, (request.params as any).commentId, pid(request)],
    );
    if (!rows.length) throw new HttpError(404, 'Comment not found.');
    hub.broadcast(pid(request));
    return { ok: true };
  });
  const agentConfig = z
    .object({
      name: z.string().trim().min(1).max(80),
      role: z.enum([
        'architect',
        'backend',
        'security',
        'database',
        'performance',
        'devops',
        'qa',
        'frontend',
      ]),
      description: z.string().max(2000),
      provider: z.enum(['local', 'openai', 'anthropic', 'google']),
      model: z.string().trim().min(1).max(100),
      instructions: z.string().max(8000),
      enabled: z.boolean(),
      reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    })
    .strict();
  app.post('/api/projects/:id/agents', async (request) => {
    await authorize(db, request.actor, pid(request), 'manage');
    const data = agentConfig.parse(request.body),
      id = uid();
    await db.transaction(async (tx) => {
      const [project] = await tx.query('SELECT workspace_id FROM projects WHERE id=$1', [
        pid(request),
      ]);
      await tx.query(
        'INSERT INTO agents(id,workspace_id,project_id,name,role,description,provider,model,instructions,enabled,created_by,settings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          id,
          project.workspace_id,
          pid(request),
          data.name,
          data.role,
          data.description,
          data.provider,
          data.model,
          data.instructions,
          data.enabled,
          request.actor.id,
          JSON.stringify(data.reasoningEffort ? { reasoningEffort: data.reasoningEffort } : {}),
        ],
      );
      await grantStandardTools(tx, id, pid(request));
      await audit(tx, pid(request), request.actor, 'agent.created', data.name);
    });
    hub.broadcast(pid(request));
    return { id };
  });
  app.patch('/api/projects/:id/agents/:agentId', async (request) => {
    await authorize(db, request.actor, pid(request), 'manage');
    const data = agentConfig.parse(request.body);
    const rows = await db.query(
      `UPDATE agents SET name=$1,role=$2,description=$3,provider=$4,model=$5,instructions=$6,enabled=$7,updated_at=now(),
       settings=CASE WHEN $10::text IS NULL THEN settings - 'reasoningEffort' ELSE settings || jsonb_build_object('reasoningEffort',$10::text) END
       WHERE id=$8 AND project_id=$9 RETURNING id`,
      [
        data.name,
        data.role,
        data.description,
        data.provider,
        data.model,
        data.instructions,
        data.enabled,
        (request.params as any).agentId,
        pid(request),
        data.reasoningEffort ?? null,
      ],
    );
    if (!rows.length) throw new HttpError(404, 'Agent not found.');
    await audit(db, pid(request), request.actor, 'agent.configured', `Updated ${data.name}.`, {
      provider: data.provider,
      model: data.model,
    });
    hub.broadcast(pid(request));
    return { ok: true };
  });
  app.get('/api/projects/:id/tools', async (request) => {
    await authorize(db, request.actor, pid(request));
    return {
      tools: registry.list(),
      executions: await db.query(
        'SELECT * FROM tool_executions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
        [pid(request)],
      ),
      grants: await db.query(
        'SELECT g.* FROM agent_tool_grants g JOIN agents a ON a.id=g.agent_id WHERE a.project_id=$1',
        [pid(request)],
      ),
    };
  });
  app.get('/api/projects/:id/knowledge', async (request) => {
    await authorize(db, request.actor, pid(request));
    return {
      sources: await db.query(
        'SELECT * FROM knowledge_sources WHERE project_id=$1 ORDER BY created_at DESC',
        [pid(request)],
      ),
    };
  });
  app.post('/api/projects/:id/knowledge', async (request) => {
    await authorize(db, request.actor, pid(request), 'edit');
    const data = z
      .object({ title: z.string().min(1).max(120), content: z.string().min(1).max(30000) })
      .parse(request.body);
    await db.query(
      'INSERT INTO knowledge_sources(id,project_id,title,kind,content) VALUES($1,$2,$3,$4,$5)',
      [uid(), pid(request), data.title, 'document', data.content],
    );
    await audit(db, pid(request), request.actor, 'knowledge.created', data.title);
    return { ok: true };
  });
  app.get('/api/projects/:id/skills', async (request) => {
    await authorize(db, request.actor, pid(request));
    return {
      skills: await db.query(
        'SELECT s.* FROM skills s JOIN projects p ON p.workspace_id=s.workspace_id WHERE p.id=$1',
        [pid(request)],
      ),
    };
  });
  app.patch('/api/projects/:id/skills/:skillId', async (request) => {
    await authorize(db, request.actor, pid(request), 'manage');
    const data = z.object({ instructions: text }).parse(request.body);
    // A project admin cannot alter workspace-wide behavior without workspace authority.
    const rows = await db.query(
      `UPDATE skills SET instructions=$1,revision=revision+1 WHERE id=$2 AND workspace_id IN
      (SELECT p.workspace_id FROM projects p JOIN workspace_members m ON m.workspace_id=p.workspace_id WHERE p.id=$3 AND m.user_id=$4 AND m.role IN ('OWNER','ADMIN')) RETURNING id`,
      [data.instructions, (request.params as any).skillId, pid(request), request.actor.id],
    );
    if (!rows.length)
      throw new HttpError(403, 'Workspace administration is required to update shared skills.');
    await audit(
      db,
      pid(request),
      request.actor,
      'skill.updated',
      'Updated shared skill instructions.',
    );
    return { ok: true };
  });
}
