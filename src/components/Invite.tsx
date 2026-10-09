import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  Copy,
  Link2,
  Loader2,
  Mail,
  MessagesSquare,
  Trash2,
  Users,
} from 'lucide-react';
import { api, post } from '../api';
import { Badge, Logo, Modal } from './UI';

function expiresIn(date: string) {
  const minutes = Math.round((new Date(date).getTime() - Date.now()) / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`;
  return `in ${Math.round(minutes / 1440)} days`;
}

interface Created {
  id: string;
  url: string;
  kind: 'email' | 'link';
  role: string;
  maxUses: number;
  expiresAt: string;
  mailto: string | null;
}
interface ActiveInvite {
  id: string;
  kind: 'email' | 'link';
  role: string;
  email: string | null;
  max_uses: number;
  use_count: number;
  expires_at: string;
  created_at: string;
  conversation_title: string | null;
  created_by_name: string;
}
const roleHelp: Record<string, string> = {
  EDITOR: 'changes the architecture and talks to agents',
  REVIEWER: 'runs reviews, comments, and talks to agents',
  VIEWER: 'reads everything, cannot change anything',
  ADMIN: 'also approves proposals and manages access',
};

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input aria-label={label} value={value} readOnly onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* The field stays selectable for manual copy. */
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function InviteModal({
  projectId,
  conversation,
  onClose,
}: {
  projectId: string;
  conversation?: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [mode, setMode] = useState<'link' | 'email'>('link'),
    [role, setRole] = useState('EDITOR'),
    [email, setEmail] = useState(''),
    [maxUses, setMaxUses] = useState(25),
    [hours, setHours] = useState(168),
    [toConversation, setToConversation] = useState(!!conversation),
    [created, setCreated] = useState<Created | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const invites = useQuery({
    queryKey: ['invites', projectId],
    queryFn: () => api<{ invites: ActiveInvite[] }>(`/projects/${projectId}/invites`),
  });
  const roles =
    mode === 'link' ? ['EDITOR', 'REVIEWER', 'VIEWER'] : ['EDITOR', 'REVIEWER', 'VIEWER', 'ADMIN'];
  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await post<Created>(`/projects/${projectId}/invites`, {
        kind: mode,
        role,
        ...(mode === 'email' ? { email } : { maxUses, expiresInHours: hours }),
        ...(toConversation && conversation ? { conversationId: conversation.id } : {}),
      });
      setCreated(result);
      void client.invalidateQueries({ queryKey: ['invites', projectId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={conversation ? `Invite to “${conversation.title}”` : 'Invite people'}
      onClose={onClose}
    >
      <div className="segmented" role="tablist">
        {(
          [
            ['link', 'Share link', Link2],
            ['email', 'Invite by email', Mail],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? 'active' : ''}
            onClick={() => {
              setMode(value);
              setCreated(null);
              setError('');
              if (value === 'link' && role === 'ADMIN') setRole('EDITOR');
            }}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>
      {created ? (
        <div className="invite-created">
          <p className="help">
            {created.kind === 'link'
              ? `Anyone with this link can join as ${created.role.toLowerCase()} — up to ${created.maxUses} people, until ${new Date(created.expiresAt).toLocaleString()}.`
              : `Only ${email.toLowerCase()} can use this link, once, until ${new Date(created.expiresAt).toLocaleString()}.`}{' '}
            The link is shown only now; create a new one if you lose it.
          </p>
          <CopyField value={created.url} label="Invitation link" />
          {created.mailto && (
            <a className="btn primary full" href={created.mailto}>
              <Mail size={14} /> Open in email app
            </a>
          )}
          <button className="text-btn" onClick={() => setCreated(null)}>
            Create another invitation
          </button>
        </div>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {mode === 'email' && (
            <label>
              Email address
              <input
                type="email"
                required
                placeholder="teammate@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          <label>
            Role
            <select
              aria-label="Invitation role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r.toLowerCase()} — {roleHelp[r]}
                </option>
              ))}
            </select>
          </label>
          {mode === 'link' && (
            <div className="form-row">
              <label>
                Can be used by
                <select
                  aria-label="Maximum uses"
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                >
                  {[1, 5, 25, 100].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 person' : `up to ${n} people`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Expires after
                <select
                  aria-label="Link expiry"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                >
                  <option value={24}>1 day</option>
                  <option value={168}>7 days</option>
                  <option value={720}>30 days</option>
                </select>
              </label>
            </div>
          )}
          {conversation && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={toConversation}
                onChange={(e) => setToConversation(e.target.checked)}
              />{' '}
              Open “{conversation.title}” after joining
            </label>
          )}
          <p className="help">
            {mode === 'link'
              ? 'Share the link in chat or email. Admin access needs an email invitation.'
              : 'AgentSpace does not send email itself: you get the link and a ready-made email draft. The recipient must sign in with this address.'}
          </p>
          {error && <p className="form-error">{error}</p>}
          <button className="btn primary full" disabled={busy}>
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : mode === 'link' ? (
              <Link2 size={14} />
            ) : (
              <Mail size={14} />
            )}
            {mode === 'link' ? 'Create share link' : 'Create email invitation'}
          </button>
        </form>
      )}
      {created && error && <p className="form-error">{error}</p>}
      <div className="active-invites">
        <h3>
          <Users size={13} /> Active invitations
        </h3>
        {invites.data?.invites.length ? (
          invites.data.invites.map((i) => (
            <div className="invite-row" key={i.id}>
              {i.kind === 'link' ? <Link2 size={14} /> : <Mail size={14} />}
              <span>
                <strong>{i.kind === 'link' ? 'Share link' : i.email}</strong>
                <small>
                  {i.role.toLowerCase()} · {i.use_count}/{i.max_uses} used · expires{' '}
                  {expiresIn(i.expires_at)}
                  {i.conversation_title ? ` · opens “${i.conversation_title}”` : ''}
                </small>
              </span>
              <button
                className="icon-btn"
                aria-label="Revoke invitation"
                title="Revoke"
                onClick={async () => {
                  try {
                    await api(`/projects/${projectId}/invites/${i.id}`, { method: 'DELETE' });
                    void client.invalidateQueries({ queryKey: ['invites', projectId] });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        ) : (
          <p className="help">No active invitations.</p>
        )}
      </div>
    </Modal>
  );
}

interface Preview {
  projectName: string;
  workspaceName: string;
  inviterName: string;
  role: string;
  conversationTitle: string | null;
  emailRestricted: boolean;
  emailMatches: boolean;
  alreadyMember: boolean;
}
export function AcceptInvite({
  token,
  email,
  onJoined,
  onDismiss,
}: {
  token: string;
  email: string;
  onJoined: (projectId: string, conversationId: string | null) => void;
  onDismiss: () => void;
}) {
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<Preview>(`/invites/${token}`),
    retry: false,
  });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const value = preview.data;
  return (
    <div className="auth-page">
      <div className="auth-card invite-card">
        <Logo />
        {preview.isPending ? (
          <p>Checking the invitation…</p>
        ) : !value ? (
          <>
            <h1>Invitation unavailable</h1>
            <p className="form-error">{preview.error?.message}</p>
            <p className="help">Ask the person who invited you for a new link.</p>
          </>
        ) : (
          <>
            <span className="eyebrow">{value.workspaceName}</span>
            <h1>Join {value.projectName}</h1>
            <p>
              <strong>{value.inviterName}</strong> invited you as{' '}
              <Badge>{value.role.toLowerCase()}</Badge>
            </p>
            {value.conversationTitle && (
              <p className="invite-conversation">
                <MessagesSquare size={14} /> You will land in “{value.conversationTitle}”.
              </p>
            )}
            <p className="help">Signed in as {email}.</p>
            {!value.emailMatches && (
              <p className="form-error">
                This invitation is for a different email address. Sign out and sign in with the
                invited address.
              </p>
            )}
            {value.alreadyMember && (
              <p className="help">You are already a member; your role stays the same.</p>
            )}
            {error && <p className="form-error">{error}</p>}
            <button
              className="btn primary"
              disabled={busy || !value.emailMatches}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await post<{ projectId: string; conversationId: string | null }>(
                    `/invites/${token}/accept`,
                    {},
                  );
                  onJoined(result.projectId, result.conversationId);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {value.alreadyMember ? 'Open project' : 'Accept invitation'} <ArrowRight size={16} />
            </button>
          </>
        )}
        <button className="text-btn" onClick={onDismiss}>
          Return to workspace
        </button>
      </div>
    </div>
  );
}
