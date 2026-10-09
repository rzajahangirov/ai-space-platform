import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db';
import { audit, authorize, hash, HttpError, token, uid } from './core';
import { notify } from './mentions';
import type { RealtimeHub } from './realtime';

const pid = (r: FastifyRequest) => (r.params as { id: string }).id;
const createInvite = z
  .object({
    kind: z.enum(['email', 'link']).optional(),
    role: z.enum(['ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER']),
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase())
      .optional(),
    maxUses: z.number().int().min(1).max(100).optional(),
    expiresInHours: z
      .union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)])
      .optional(),
    conversationId: z.string().max(100).optional(),
  })
  .strict()
  // Callers that only pass an email get an email invitation, as before share links existed.
  .transform((value) => ({ ...value, kind: value.kind ?? (value.email ? 'email' : 'link') }))
  .superRefine((value, ctx) => {
    if (value.kind === 'email' && !value.email)
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'An email invitation needs an email address.',
      });
    // A link anyone can forward must never grant administration.
    if (value.kind === 'link' && value.role === 'ADMIN')
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'Admin access requires an email invitation.',
      });
  });

export function registerInviteRoutes(
  app: FastifyInstance,
  db: DB,
  hub: RealtimeHub,
  origin: string,
) {
  app.post('/api/projects/:id/invites', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'manage');
    const data = createInvite.parse(request.body);
    const [project] = await db.query<{ name: string }>('SELECT name FROM projects WHERE id=$1', [
      projectId,
    ]);
    let conversationTitle: string | null = null;
    if (data.conversationId) {
      const [conversation] = await db.query<{ title: string }>(
        'SELECT title FROM conversations WHERE project_id=$1 AND id=$2',
        [projectId, data.conversationId],
      );
      if (!conversation) throw new HttpError(404, 'Conversation not found.');
      conversationTitle = conversation.title;
    }
    const email = data.kind === 'email' ? data.email! : null;
    const maxUses = data.kind === 'email' ? 1 : (data.maxUses ?? 25);
    const hours = data.expiresInHours ?? (data.kind === 'email' ? 48 : 168);
    // Only a hash is stored; the link itself is shown once to its creator.
    const value = token(),
      id = uid();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx.query<{ expires_at: string }>(
        `INSERT INTO invitations(id,project_id,token_hash,role,email,created_by,expires_at,kind,max_uses,conversation_id)
         VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(hours=>$7::int),$8,$9,$10) RETURNING expires_at`,
        [
          id,
          projectId,
          hash(value),
          data.role,
          email,
          request.actor.id,
          hours,
          data.kind,
          maxUses,
          data.conversationId ?? null,
        ],
      );
      await audit(
        tx,
        projectId,
        request.actor,
        'invite.created',
        data.kind === 'email'
          ? `Invited ${email} as ${data.role.toLowerCase()}.`
          : `Created a ${data.role.toLowerCase()} share link (${maxUses} uses, ${hours}h).`,
        {
          invitationId: id,
          kind: data.kind,
          email,
          maxUses,
          hours,
          conversationId: data.conversationId ?? null,
        },
      );
      return inserted;
    });
    const url = `${origin}/invite/${value}`;
    const where = conversationTitle
      ? `the “${conversationTitle}” conversation in ${project.name}`
      : project.name;
    const subject = `${request.actor.name} invited you to ${project.name} on AgentSpace`;
    const body = `${request.actor.name} invited you to join ${where} as ${data.role.toLowerCase()}.\n\nOpen this link to join (sign in or create an account with this email address):\n${url}\n\nThe link expires ${new Date(row.expires_at).toUTCString()}.`;
    hub.broadcast(projectId);
    return {
      id,
      url,
      kind: data.kind,
      role: data.role,
      maxUses,
      expiresAt: row.expires_at,
      // AgentSpace does not send email itself; this opens the inviter's own mail client.
      mailto: email
        ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
        : null,
    };
  });

  app.get('/api/projects/:id/invites', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'manage');
    return {
      invites: await db.query(
        `SELECT i.id,i.kind,i.role,i.email,i.max_uses,i.use_count,i.expires_at,i.created_at,i.conversation_id,
           c.title AS conversation_title,u.name AS created_by_name
         FROM invitations i JOIN users u ON u.id=i.created_by LEFT JOIN conversations c ON c.id=i.conversation_id
         WHERE i.project_id=$1 AND i.revoked_at IS NULL AND i.expires_at>now() AND i.use_count<i.max_uses
         ORDER BY i.created_at DESC LIMIT 100`,
        [projectId],
      ),
    };
  });

  app.delete('/api/projects/:id/invites/:inviteId', async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'manage');
    const inviteId = (request.params as { inviteId: string }).inviteId;
    const rows = await db.query(
      'UPDATE invitations SET revoked_at=now() WHERE project_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',
      [projectId, inviteId],
    );
    if (!rows.length) throw new HttpError(404, 'Invitation not found.');
    await audit(db, projectId, request.actor, 'invite.revoked', 'Revoked an invitation link.', {
      invitationId: inviteId,
    });
    hub.broadcast(projectId);
    return { ok: true };
  });

  const tokenParam = (request: FastifyRequest) =>
    z
      .string()
      .min(30)
      .max(100)
      .parse((request.params as { token: string }).token);
  const usable = (invite: any) =>
    invite &&
    !invite.revoked_at &&
    new Date(invite.expires_at) > new Date() &&
    invite.use_count < invite.max_uses;

  // Preview for the signed-in recipient: what they are about to join, without granting anything.
  app.get(
    '/api/invites/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const [invite] = await db.query(
        `SELECT i.*,p.name AS project_name,w.name AS workspace_name,u.name AS inviter_name,c.title AS conversation_title
       FROM invitations i JOIN projects p ON p.id=i.project_id JOIN workspaces w ON w.id=p.workspace_id
       JOIN users u ON u.id=i.created_by LEFT JOIN conversations c ON c.id=i.conversation_id
       WHERE i.token_hash=$1`,
        [hash(tokenParam(request))],
      );
      if (!usable(invite))
        throw new HttpError(410, 'This invitation has expired, was revoked, or was already used.');
      const [member] = await db.query(
        'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',
        [invite.project_id, request.actor.id],
      );
      return {
        projectName: invite.project_name,
        workspaceName: invite.workspace_name,
        inviterName: invite.inviter_name,
        role: invite.role,
        conversationTitle: invite.conversation_title,
        emailRestricted: !!invite.email,
        emailMatches: !invite.email || invite.email === request.actor.email,
        alreadyMember: !!member,
        expiresAt: invite.expires_at,
      };
    },
  );

  app.post(
    '/api/invites/:token/accept',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const value = tokenParam(request);
      const result = await db.transaction(async (tx) => {
        const [invite] = await tx.query(
          'SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE',
          [hash(value)],
        );
        if (!usable(invite))
          throw new HttpError(
            410,
            'This invitation has expired, was revoked, or was already used.',
          );
        if (invite.email && invite.email !== request.actor.email)
          throw new HttpError(403, 'This invitation belongs to a different email address.');
        const [member] = await tx.query(
          'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',
          [invite.project_id, request.actor.id],
        );
        // Existing members keep their role and do not consume a use; links never downgrade or upgrade access.
        if (member)
          return {
            projectId: invite.project_id,
            conversationId: invite.conversation_id,
            joined: false,
          };
        // Project invitation deliberately grants no access to sibling projects or workspace administration.
        await tx.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [
          invite.project_id,
          request.actor.id,
          invite.role,
        ]);
        await tx.query('INSERT INTO invitation_acceptances(invitation_id,user_id) VALUES($1,$2)', [
          invite.id,
          request.actor.id,
        ]);
        await tx.query(
          'UPDATE invitations SET use_count=use_count+1,accepted_by=COALESCE(accepted_by,$1),accepted_at=COALESCE(accepted_at,now()) WHERE id=$2',
          [request.actor.id, invite.id],
        );
        await audit(
          tx,
          invite.project_id,
          request.actor,
          'member.joined',
          `Joined as ${invite.role.toLowerCase()} through an invitation.`,
          {
            invitationId: invite.id,
          },
        );
        await notify(tx, invite.project_id, [invite.created_by], {
          kind: 'member_joined',
          title: `${request.actor.name} joined as ${invite.role.toLowerCase()}`,
          body: request.actor.email,
          page: invite.conversation_id ? 'Conversations' : 'Architecture',
          actorName: request.actor.name,
        });
        return {
          projectId: invite.project_id,
          conversationId: invite.conversation_id,
          joined: true,
        };
      });
      hub.broadcast(result.projectId);
      return result;
    },
  );
}
