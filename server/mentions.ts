import type { DB } from './db';
import { uid } from './core';

export const handle = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Lower-cased, punctuation-free handles written as @Name in free text. */
export function extractMentions(text: string): string[] {
  return [
    ...new Set([...text.matchAll(/(?:^|[^\w@])@([A-Za-z][\w.-]{0,60})/g)].map((m) => handle(m[1]))),
  ];
}

export function agentHandles(agent: { name: string; role: string }) {
  const name = handle(agent.name);
  // "@SecurityEngineer", "@security", and "@SecurityAgent" all address the security specialist.
  return new Set([name, agent.role, `${agent.role}agent`, name.replace(/engineer$/, 'agent')]);
}

export function memberHandles(member: { name: string; email: string }) {
  const first = member.name.trim().split(/\s+/)[0] ?? '';
  return new Set([handle(member.name), handle(first), handle(member.email.split('@')[0])]);
}

export function resolveMentions(
  text: string,
  agents: { id: string; name: string; role: string; enabled: boolean }[],
  members: { id: string; name: string; email: string }[],
) {
  const mentioned = extractMentions(text);
  const agentIds: string[] = [],
    userIds: string[] = [];
  for (const value of mentioned) {
    // Agents take precedence; a human called "Security" would otherwise hijack @security.
    const agent = agents.find((a) => a.enabled && agentHandles(a).has(value));
    if (agent) {
      if (!agentIds.includes(agent.id)) agentIds.push(agent.id);
      continue;
    }
    for (const m of members)
      if (memberHandles(m).has(value) && !userIds.includes(m.id)) userIds.push(m.id);
  }
  return { agentIds, userIds };
}

export async function projectParticipants(db: DB, projectId: string) {
  const agents = await db.query<{ id: string; name: string; role: string; enabled: boolean }>(
    'SELECT id,name,role,enabled FROM agents WHERE project_id=$1 ORDER BY created_at,id',
    [projectId],
  );
  const members = await db.query<{ id: string; name: string; email: string; role: string }>(
    'SELECT u.id,u.name,u.email,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1',
    [projectId],
  );
  return { agents, members };
}

export type NotificationKind =
  | 'mention'
  | 'approval_request'
  | 'critical_finding'
  | 'run_completed'
  | 'run_failed'
  | 'drift_detected'
  | 'member_joined';

export async function notify(
  db: DB,
  projectId: string,
  userIds: Iterable<string>,
  n: {
    kind: NotificationKind;
    title: string;
    body?: string;
    page?: string;
    componentId?: string | null;
    actorName?: string;
  },
  exceptUserId?: string,
) {
  for (const userId of new Set(userIds)) {
    if (userId === exceptUserId) continue;
    await db.query(
      'INSERT INTO notifications(id,user_id,project_id,kind,title,body,page,component_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        uid(),
        userId,
        projectId,
        n.kind,
        n.title.slice(0, 200),
        (n.body ?? '').slice(0, 1000),
        n.page ?? null,
        n.componentId ?? null,
        n.actorName ?? null,
      ],
    );
  }
}

export async function membersWithRoles(db: DB, projectId: string, roles: string[]) {
  return (
    await db.query<{ user_id: string }>(
      'SELECT user_id FROM project_members WHERE project_id=$1 AND role=ANY($2::text[])',
      [projectId, roles],
    )
  ).map((r) => r.user_id);
}
