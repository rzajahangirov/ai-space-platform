import {
  randomUUID,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import type { DB } from './db';
import type { Role } from '../shared/domain';
const scrypt = promisify(scryptCallback);
export const uid = () => randomUUID();
/** Identifies this process behind a load balancer (health checks, council session ownership). */
export const instanceId = process.env.INSTANCE_ID || `${hostname()}:${process.env.PORT || 3001}`;
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * Exact origin match. Outside production, loopback aliases on the same scheme and port are
 * equivalent (http://127.0.0.1:5173 ≡ http://localhost:5173); they cannot be reached cross-site.
 */
export function originAllowed(value: string | undefined, origin: string) {
  if (!value) return false;
  if (value === origin) return true;
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const a = new URL(value),
      b = new URL(origin);
    return (
      a.protocol === b.protocol &&
      a.port === b.port &&
      loopback.has(a.hostname) &&
      loopback.has(b.hostname)
    );
  } catch {
    return false;
  }
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export async function passwordHash(password: string) {
  const salt = token();
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const computed = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, 'hex');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
export interface Actor {
  id: string;
  name: string;
  email: string;
}
export type Permission = 'read' | 'comment' | 'edit' | 'review' | 'approve' | 'manage';
export function can(role: Role, action: Permission) {
  if (action === 'read') return true;
  if (action === 'comment') return role !== 'VIEWER';
  if (action === 'review') return ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'].includes(role);
  if (action === 'edit') return ['OWNER', 'ADMIN', 'EDITOR'].includes(role);
  return ['OWNER', 'ADMIN'].includes(role);
}
export async function authorize(
  db: DB,
  actor: Actor,
  projectId: string,
  permission: Permission = 'read',
) {
  const [member] = await db.query<{ role: Role }>(
    'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',
    [projectId, actor.id],
  );
  if (!member) throw new HttpError(404, 'Project not found.');
  if (!can(member.role, permission))
    throw new HttpError(403, 'Your project role does not allow this action.');
  return member.role;
}
export async function audit(
  db: DB,
  projectId: string,
  actor: Actor | { id: string; name: string; type: 'agent' },
  action: string,
  detail: string,
  data: unknown = {},
  resource = projectId,
) {
  await db.query(
    'INSERT INTO audit_logs(id,project_id,actor_id,actor_type,actor_name,action,resource,detail,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      uid(),
      projectId,
      actor.id,
      'type' in actor ? actor.type : 'human',
      actor.name,
      action,
      resource,
      detail,
      JSON.stringify(data),
    ],
  );
}
export async function emit(db: DB, projectId: string, kind: string, payload: unknown = {}) {
  await db.query('INSERT INTO events(id,project_id,kind,payload) VALUES($1,$2,$3,$4)', [
    uid(),
    projectId,
    kind,
    JSON.stringify(payload),
  ]);
}
