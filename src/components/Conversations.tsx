import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  UserPlus,
  X,
} from 'lucide-react';
import type {
  Agent,
  ArtifactSummary,
  ConversationDetail,
  ConversationSummary,
  Proposal,
  Snapshot,
  ToolStep,
} from '../../shared/domain';
import type { Operation } from '../../shared/operations';
import { api, patch, post } from '../api';
import { Badge, Empty, initials, relative } from './UI';
import { MentionSuggestions } from './Panels';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const toolLabels: Record<string, string> = {
  'project.graph.read': 'Read the architecture',
  'project.component.read': 'Inspected a component',
  'project.search': 'Searched the project',
  'artifact.read': 'Read a document',
  'architecture.propose': 'Proposed a change',
  'finding.record': 'Recorded a finding',
  'artifact.write': 'Wrote a document',
  'agent.ask': 'Asked another agent',
};
const stepLabels: Record<string, string> = {
  read_architecture: 'reading the architecture',
  inspect_component: 'inspecting a component',
  search_project: 'searching the project',
  read_artifact: 'reading a document',
  propose_change: 'drafting a proposal',
  record_finding: 'recording a finding',
  write_artifact: 'writing a document',
  ask_agent: 'asking a teammate',
  thinking: 'thinking',
  'reading context': 'reading context',
  reviewing: 'reviewing',
};
const friendlyStep = (step: string | null) => (step ? (stepLabels[step] ?? step) : 'queued');

function opLabel(op: Operation, name: (id: string) => string): [string, string] {
  if (op.op === 'add_component') return ['add', `${op.name} · ${op.technology}`];
  if (op.op === 'remove_component') return ['remove', name(op.componentId)];
  if (op.op === 'remove_connection') return ['remove', `connection ${name(op.connectionId)}`];
  if (op.op === 'add_connection')
    return ['add', `${name(op.from)} → ${name(op.to)} · ${op.protocol}`];
  const fields = [
    op.name && `name → ${op.name}`,
    op.technology && `technology → ${op.technology}`,
    op.description !== null && 'description',
    ...op.config.map((c) => (c.value === null ? `−${c.key}` : `${c.key}=${c.value}`)),
  ].filter(Boolean);
  return ['change', `${name(op.componentId)}: ${fields.join(', ')}`];
}

export function ProposalCard({
  proposal,
  data,
  onDecided,
  notify,
  compact,
}: {
  proposal: Proposal;
  data: Snapshot;
  onDecided: () => void;
  notify: (message: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(!compact);
  const manage = ['OWNER', 'ADMIN'].includes(data.project.role);
  const refs = new Map(
    (proposal.operations ?? [])
      .filter((o): o is Extract<Operation, { op: 'add_component' }> => o.op === 'add_component')
      .map((o) => [o.ref, o.name]),
  );
  const edgeName = (id: string) => {
    const edge = data.graph.edges.find((e) => e.id === id);
    if (!edge) return id;
    const n = (c: string) => data.graph.components.find((x) => x.id === c)?.name ?? c;
    return `${n(edge.source)} → ${n(edge.target)}`;
  };
  const name = (id: string) =>
    refs.get(id) ?? data.graph.components.find((c) => c.id === id)?.name ?? edgeName(id);
  const lines = proposal.operations
    ? proposal.operations.map((op) => opLabel(op, name))
    : proposal.changes.map((c): [string, string] =>
        c.type === 'component.upsert'
          ? [
              data.graph.components.some((n) => n.id === c.component.id) ? 'change' : 'add',
              c.component.name,
            ]
          : c.type === 'edge.upsert'
            ? ['add', `${name(c.edge.source)} → ${name(c.edge.target)} · ${c.edge.protocol}`]
            : c.type === 'component.delete'
              ? ['remove', name(c.id)]
              : c.type === 'edge.delete'
                ? ['remove', edgeName(c.id)]
                : ['change', 'Restore a previous version'],
      );
  const stale = proposal.base_revision !== data.project.revision;
  const shown = expanded ? lines : lines.slice(0, 6);
  async function decide(decision: 'APPROVED' | 'REJECTED') {
    setBusy(true);
    try {
      await post(`/projects/${data.project.id}/proposals/${proposal.id}/decision`, { decision });
      notify(
        decision === 'APPROVED'
          ? 'Applied to the architecture. A new version was saved.'
          : 'Proposal rejected.',
      );
      onDecided();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`inline-proposal ${proposal.status.toLowerCase()}`}>
      <header>
        <GitPullRequest size={15} />
        <strong>{proposal.title}</strong>
        <Badge
          tone={
            proposal.status === 'APPROVED'
              ? 'green'
              : proposal.status === 'PENDING'
                ? 'amber'
                : 'neutral'
          }
        >
          {proposal.status === 'PENDING' ? 'awaiting approval' : proposal.status.toLowerCase()}
        </Badge>
        <small>{proposal.risk.toLowerCase()} risk</small>
      </header>
      {!compact && <p className="proposal-reason">{proposal.reason}</p>}
      <ul className="op-list">
        {shown.map(([kind, text], i) => (
          <li key={i} className={`op-${kind}`}>
            <span>{kind === 'add' ? '+' : kind === 'remove' ? '−' : '~'}</span>
            {text}
          </li>
        ))}
      </ul>
      {lines.length > shown.length && (
        <button className="text-btn" onClick={() => setExpanded(true)}>
          Show all {lines.length} changes
        </button>
      )}
      {!compact && proposal.tradeoffs && (
        <p className="proposal-tradeoffs">
          <strong>Tradeoffs:</strong> {proposal.tradeoffs}
        </p>
      )}
      {proposal.status === 'PENDING' && (
        <footer>
          {stale && (
            <small className="stale-note">
              {proposal.operations
                ? `Drafted on v${proposal.base_revision}; it will be re-checked against v${data.project.revision}.`
                : 'The architecture changed; this proposal can only be rejected.'}
            </small>
          )}
          {manage ? (
            <div>
              <button className="btn small" disabled={busy} onClick={() => decide('REJECTED')}>
                <X size={13} /> Reject
              </button>
              <button
                className="btn primary small"
                disabled={busy || (stale && !proposal.operations)}
                onClick={() => decide('APPROVED')}
              >
                <Check size={13} /> Apply to architecture
              </button>
            </div>
          ) : (
            <small>Waiting for an owner or admin to decide.</small>
          )}
        </footer>
      )}
    </article>
  );
}

function StepList({ steps }: { steps: ToolStep[] }) {
  return (
    <ul className="step-list">
      {steps.map((s) => (
        <li key={s.id} className={`step-${s.status}`}>
          {s.status === 'running' ? (
            <Loader2 size={12} className="spin" />
          ) : s.status === 'completed' ? (
            <CheckCircle2 size={12} />
          ) : (
            <AlertTriangle size={12} />
          )}
          <span>{toolLabels[s.tool] ?? s.tool}</span>
          {s.input_summary && s.input_summary !== '{}' && <code>{s.input_summary}</code>}
          {s.status !== 'completed' && s.status !== 'running' && <small>{s.status}</small>}
          {s.duration_ms > 0 && <small>{s.duration_ms}ms</small>}
        </li>
      ))}
    </ul>
  );
}

function AgentAvatar({ agent }: { agent?: Agent }) {
  return (
    <span className={`message-avatar ai role-${agent?.role ?? 'architect'}`}>
      <Bot size={16} />
    </span>
  );
}

export function ConversationThread({
  data,
  conversationId,
  notify,
  onSelectComponent,
  onOpenArtifact,
  compact,
}: {
  data: Snapshot;
  conversationId: string;
  notify: (message: string) => void;
  onSelectComponent?: (id: string) => void;
  onOpenArtifact?: (id: string) => void;
  compact?: boolean;
}) {
  const client = useQueryClient();
  const key = ['conversation', data.project.id, conversationId];
  const detail = useQuery({
    queryKey: key,
    queryFn: () =>
      api<ConversationDetail>(`/projects/${data.project.id}/conversations/${conversationId}`),
    // Live updates arrive over the socket; polling is a fallback while agents work.
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => ['queued', 'running'].includes(r.status)) ? 2500 : false,
  });
  const bottom = useRef<HTMLDivElement>(null);
  const value = detail.data;
  const count = (value?.messages.length ?? 0) + (value?.steps.length ?? 0);
  // Block body on purpose: scrollIntoView may return a Promise, which must not become a cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['snapshot', data.project.id] });
  };
  if (detail.isPending)
    return (
      <div className="thread-loading">
        <Loader2 className="spin" size={18} />
      </div>
    );
  if (!value) return <p className="form-error">{detail.error?.message}</p>;
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const active = value.runs.find((r) => ['queued', 'running'].includes(r.status));
  // Output an agent produced in a run belongs under that agent's message.
  const outputs = (runId: string | null, agentId: string | undefined) => ({
    steps: value.steps.filter((s) => s.run_id === runId && s.agent_id === agentId),
    proposals: value.proposals.filter((p) => p.run_id === runId && p.agent_id === agentId),
    findings: value.findings.filter((f) => f.run_id === runId && f.agent_id === agentId),
    artifacts: value.artifacts.filter((a) => a.run_id === runId && a.agent_id === agentId),
  });
  const answered = new Set(
    value.messages.filter((m) => m.actor_type === 'agent').map((m) => `${m.run_id}:${m.agent_id}`),
  );
  const liveSteps = active
    ? value.steps.filter(
        (s) =>
          s.run_id === active.id &&
          s.agent_id === active.current_agent_id &&
          !answered.has(`${active.id}:${s.agent_id}`),
      )
    : [];
  return (
    <div className={`thread ${compact ? 'compact' : ''}`}>
      {!value.messages.length && !active && (
        <Empty
          title="Start the conversation"
          description="Mention an agent with @ or pick one below."
        />
      )}
      {value.messages.map((m) => {
        if (m.actor_type === 'system')
          return (
            <div className="system-message" key={m.id}>
              <AlertTriangle size={14} /> {m.content}
            </div>
          );
        const agent = m.agent_id ? agentById.get(m.agent_id) : undefined;
        const out = m.actor_type === 'agent' ? outputs(m.run_id, m.agent_id) : null;
        return (
          <article className={`chat-message ${m.actor_type}`} key={m.id}>
            {m.actor_type === 'agent' ? (
              <AgentAvatar agent={agent} />
            ) : (
              <span className="message-avatar">{initials(m.author_name)}</span>
            )}
            <div className="chat-body">
              <div className="message-meta">
                <strong>{m.author_name}</strong>
                {m.actor_type === 'agent' &&
                  (m.model === 'rules-v1' ? (
                    <Badge tone="amber">offline rules · not an LLM</Badge>
                  ) : (
                    <Badge>{m.model ?? agent?.model ?? 'agent'}</Badge>
                  ))}
                <small>{relative(m.created_at)}</small>
              </div>
              {out && out.steps.length > 0 && (
                <details className="steps">
                  <summary>
                    <Wrench size={12} /> Used {out.steps.length} tool
                    {out.steps.length === 1 ? '' : 's'}
                    <ChevronRight size={12} />
                  </summary>
                  <StepList steps={out.steps} />
                </details>
              )}
              <Markdown>{m.content}</Markdown>
              {out?.proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  data={data}
                  notify={notify}
                  onDecided={refresh}
                  compact={compact}
                />
              ))}
              {out && (out.findings.length > 0 || out.artifacts.length > 0) && (
                <div className="output-chips">
                  {out.findings.map((f) => (
                    <button
                      key={f.id}
                      className={`chip severity-${f.severity.toLowerCase()}`}
                      onClick={() => f.component_id && onSelectComponent?.(f.component_id)}
                    >
                      <ShieldCheck size={12} /> {f.severity} · {f.title}
                    </button>
                  ))}
                  {out.artifacts.map((a) => (
                    <button key={a.id} className="chip" onClick={() => onOpenArtifact?.(a.id)}>
                      <FileText size={12} /> {a.title} · v{a.revision}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </article>
        );
      })}
      {active && (
        <div className="agent-working">
          <AgentAvatar
            agent={active.current_agent_id ? agentById.get(active.current_agent_id) : undefined}
          />
          <div>
            <strong>
              {active.current_agent_id ? agentById.get(active.current_agent_id)?.name : 'Agents'}
            </strong>
            <span>
              <Loader2 size={12} className="spin" /> {friendlyStep(active.current_step)}…
            </span>
            {liveSteps.length > 0 && <StepList steps={liveSteps} />}
          </div>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}

/** Composer with @mention completion and sticky agent selection. */
export function Composer({
  data,
  busy,
  onSend,
  placeholder,
  autoFocus,
  initialText = '',
  conversationId,
}: {
  data: Snapshot;
  busy?: boolean;
  onSend: (content: string, agentIds: string[]) => Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
  initialText?: string;
  conversationId?: string;
}) {
  const [text, setText] = useState(initialText),
    // null: follow the default recipient; an array: the user's explicit choice.
    [chosen, setChosen] = useState<string[] | null>(null),
    [sending, setSending] = useState(false),
    [error, setError] = useState('');
  const enabled = data.agents.filter((a) => a.enabled);
  const viewer = data.project.role === 'VIEWER';
  const mentionsAgent = /(^|\s)@[A-Za-z]/.test(text);
  const thread = useQuery({
    queryKey: ['conversation', data.project.id, conversationId],
    queryFn: () =>
      api<ConversationDetail>(`/projects/${data.project.id}/conversations/${conversationId}`),
    enabled: !!conversationId,
  });
  // A plain message continues with the agent who answered last, or the architect in a new thread.
  const lastAgent = thread.data?.messages.filter((m) => m.actor_type === 'agent').at(-1)?.agent_id;
  const fallback = [lastAgent, enabled.find((a) => a.role === 'architect')?.id].find(
    (id) => id && enabled.some((a) => a.id === id),
  );
  const agents = chosen ?? (mentionsAgent || !fallback ? [] : [fallback]);
  const setAgents = (update: (list: string[]) => string[]) => setChosen(update(agents));
  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await onSend(text.trim(), agents);
      setText('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <MentionSuggestions data={data} value={text} onPick={setText} />
      <textarea
        aria-label="Message"
        autoFocus={autoFocus}
        disabled={viewer}
        placeholder={
          viewer
            ? 'Viewers can read conversations.'
            : (placeholder ?? 'Ask your engineering team… use @ to mention an agent or teammate')
        }
        value={text}
        maxLength={8000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <div className="agent-picks" role="group" aria-label="Agents that will answer">
          {enabled.map((a) => (
            <button
              type="button"
              key={a.id}
              aria-pressed={agents.includes(a.id)}
              className={agents.includes(a.id) ? 'picked' : ''}
              onClick={() =>
                setAgents((list) =>
                  list.includes(a.id) ? list.filter((x) => x !== a.id) : [...list, a.id].slice(-3),
                )
              }
            >
              <Bot size={11} /> {a.name}
            </button>
          ))}
        </div>
        <button
          className="send-btn"
          aria-label="Send message"
          disabled={viewer || sending || busy || !text.trim()}
        >
          {sending ? <Loader2 size={15} className="spin" /> : <ArrowUp size={16} />}
        </button>
      </div>
      {!agents.length && !mentionsAgent && text.trim() && (
        <small className="composer-hint">
          No agent is addressed — teammates will see this message.
        </small>
      )}
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

const starters = [
  ['Design a new system', '@SystemArchitect Design the architecture for '],
  [
    'Security review',
    '@SecurityAgent Review the current architecture for security risks and record findings.',
  ],
  [
    'Database design',
    '@DatabaseAgent Propose the data stores and key tables for this system, as an artifact.',
  ],
  [
    'Write an ADR',
    '@SystemArchitect Write an ADR for the most important open architecture decision.',
  ],
] as const;

export function ConversationsPage({
  data,
  notify,
  conversationId,
  onSelectConversation,
  onSelectComponent,
  onOpenArtifact,
  onInvite,
}: {
  data: Snapshot;
  notify: (message: string) => void;
  conversationId: string | null;
  onSelectConversation: (id: string | null) => void;
  onSelectComponent: (id: string) => void;
  onOpenArtifact: (id: string) => void;
  onInvite?: (conversation: { id: string; title: string }) => void;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState(''),
    [renaming, setRenaming] = useState<string | null>(null),
    [draft, setDraft] = useState('');
  const list = useQuery({
    queryKey: ['conversations', data.project.id],
    queryFn: () =>
      api<{ conversations: ConversationSummary[] }>(`/projects/${data.project.id}/conversations`),
  });
  const conversations = list.data?.conversations ?? [];
  const current = conversations.find((c) => c.id === conversationId);
  const shown = useMemo(
    () =>
      conversations.filter((c) =>
        `${c.title} ${c.preview ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
      ),
    [conversations, filter],
  );
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['conversations', data.project.id] });
    void client.invalidateQueries({ queryKey: ['conversation', data.project.id] });
  };
  return (
    <div className="conversations-page">
      <aside className="conversation-list">
        <button className="btn primary full" onClick={() => onSelectConversation(null)}>
          <MessageSquarePlus size={15} /> New conversation
        </button>
        <label className="list-search">
          <Search size={13} />
          <input
            aria-label="Filter conversations"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {shown.map((c) => (
          <button
            key={c.id}
            className={`conversation-item ${c.id === conversationId ? 'active' : ''}`}
            onClick={() => onSelectConversation(c.id)}
          >
            <span className="conversation-title">
              {c.active && <i className="pulse-dot" />}
              {c.kind === 'live_review' && <Sparkles size={12} />}
              {c.title}
            </span>
            <small>
              {c.preview_author ? `${c.preview_author}: ` : ''}
              {c.preview ? c.preview.replace(/[*_`#>]/g, '') : 'No messages yet'}
            </small>
            <small className="conversation-time">{relative(c.updated_at)}</small>
          </button>
        ))}
      </aside>
      <section className="conversation-main">
        {conversationId && current ? (
          <>
            <header className="conversation-header">
              {renaming === current.id ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await patch(`/projects/${data.project.id}/conversations/${current.id}`, {
                        title: draft,
                      });
                      setRenaming(null);
                      invalidate();
                    } catch (error) {
                      notify((error as Error).message);
                    }
                  }}
                >
                  <input
                    aria-label="Conversation title"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button className="icon-btn" aria-label="Save title">
                    <Save size={14} />
                  </button>
                </form>
              ) : (
                <>
                  <h2>{current.title}</h2>
                  {data.project.role !== 'VIEWER' && (
                    <button
                      className="icon-btn"
                      aria-label="Rename conversation"
                      onClick={() => {
                        setDraft(current.title);
                        setRenaming(current.id);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </>
              )}
              <small>
                {current.message_count} messages · shared with everyone in {data.project.name}
              </small>
              {onInvite && (
                <button
                  className="btn small"
                  onClick={() => onInvite({ id: current.id, title: current.title })}
                >
                  <UserPlus size={13} /> Invite to this conversation
                </button>
              )}
            </header>
            <div className="conversation-scroll">
              <LocalAgentsNotice data={data} notify={notify} />
              <ConversationThread
                data={data}
                conversationId={current.id}
                notify={notify}
                onSelectComponent={onSelectComponent}
                onOpenArtifact={onOpenArtifact}
              />
            </div>
            <Composer
              key={current.id}
              data={data}
              conversationId={current.id}
              busy={current.active}
              onSend={async (content, agentIds) => {
                await post(`/projects/${data.project.id}/messages`, {
                  conversationId: current.id,
                  content,
                  agentIds,
                });
                invalidate();
              }}
            />
          </>
        ) : (
          <NewConversation
            notify={notify}
            data={data}
            onCreated={(id) => {
              invalidate();
              onSelectConversation(id);
            }}
          />
        )}
      </section>
    </div>
  );
}

function NewConversation({
  data,
  onCreated,
  notify,
}: {
  data: Snapshot;
  onCreated: (id: string) => void;
  notify: (m: string) => void;
}) {
  const [seed, setSeed] = useState(0),
    [prefill, setPrefill] = useState('');
  return (
    <div className="new-conversation">
      <LocalAgentsNotice data={data} notify={notify} />
      <div className="new-conversation-hero">
        <span className="eyebrow">YOUR ENGINEERING TEAM</span>
        <h1>What are we building?</h1>
        <p>
          Agents read this project's architecture, findings, and documents. They propose changes;
          you decide what is applied.
        </p>
        <div className="starter-grid">
          {starters.map(([label, text]) => (
            <button
              key={label}
              onClick={() => {
                setPrefill(text);
                setSeed((n) => n + 1);
              }}
            >
              <Sparkles size={13} /> {label}
            </button>
          ))}
        </div>
      </div>
      <Composer
        key={seed}
        data={data}
        initialText={prefill}
        autoFocus
        onSend={async (content, agentIds) => {
          const result = await post<{ id: string }>(`/projects/${data.project.id}/conversations`, {
            content,
            agentIds,
          });
          onCreated(result.id);
        }}
      />
    </div>
  );
}

/** Compact conversation panel next to the canvas: design while watching the graph change. */
export function RoomDrawer({
  data,
  notify,
  conversationId,
  onSelectConversation,
  onClose,
  onSelectComponent,
  onOpenArtifact,
  selectedComponent,
}: {
  data: Snapshot;
  notify: (message: string) => void;
  conversationId: string | null;
  onSelectConversation: (id: string | null) => void;
  onClose: () => void;
  onSelectComponent: (id: string) => void;
  onOpenArtifact: (id: string) => void;
  selectedComponent: string | null;
}) {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['conversations', data.project.id],
    queryFn: () =>
      api<{ conversations: ConversationSummary[] }>(`/projects/${data.project.id}/conversations`),
  });
  const conversations = list.data?.conversations ?? [];
  const id = conversationId ?? conversations.find((c) => c.kind === 'chat')?.id ?? null;
  const current = conversations.find((c) => c.id === id);
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['conversations', data.project.id] });
    void client.invalidateQueries({ queryKey: ['conversation', data.project.id] });
  };
  const component = data.graph.components.find((c) => c.id === selectedComponent);
  return (
    <section className="collaboration room-drawer">
      <header>
        <select
          aria-label="Conversation"
          value={id ?? ''}
          onChange={(e) => onSelectConversation(e.target.value || null)}
        >
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.active ? '● ' : ''}
              {c.title}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          aria-label="New conversation"
          title="New conversation"
          disabled={data.project.role === 'VIEWER'}
          onClick={async () => {
            try {
              const created = await post<{ id: string }>(
                `/projects/${data.project.id}/conversations`,
                { title: 'New conversation' },
              );
              invalidate();
              onSelectConversation(created.id);
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <Plus size={15} />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close engineering room">
          <X size={16} />
        </button>
      </header>
      <div className="room-context">
        <ShieldCheck size={13} /> Agents see architecture v{data.project.revision}
        {component ? ` · focused on ${component.name}` : ''}
      </div>
      <div className="messages">
        <LocalAgentsNotice data={data} notify={notify} />
        {id ? (
          <ConversationThread
            data={data}
            conversationId={id}
            notify={notify}
            onSelectComponent={onSelectComponent}
            onOpenArtifact={onOpenArtifact}
            compact
          />
        ) : (
          <Empty title="No conversations yet" description="Start one with the + button." />
        )}
      </div>
      {id && (
        <Composer
          key={id}
          data={data}
          conversationId={id}
          busy={current?.active}
          placeholder={component ? `Ask about ${component.name}… (@ to mention)` : undefined}
          onSend={async (content, agentIds) => {
            await post(`/projects/${data.project.id}/messages`, {
              conversationId: id,
              content,
              agentIds,
              componentId: component?.id,
            });
            invalidate();
          }}
        />
      )}
    </section>
  );
}

// ---------- Artifacts ----------
const kindLabels: Record<string, string> = {
  document: 'Document',
  review: 'Review',
  plan: 'Plan',
  api_spec: 'API spec',
  runbook: 'Runbook',
  report: 'Report',
  adr: 'ADR',
};
export function ArtifactsPage({
  data,
  notify,
  openId,
  onOpen,
}: {
  data: Snapshot;
  notify: (message: string) => void;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['artifacts', data.project.id],
    queryFn: () => api<{ artifacts: ArtifactSummary[] }>(`/projects/${data.project.id}/artifacts`),
  });
  const artifacts = list.data?.artifacts ?? [];
  const id = openId ?? artifacts[0]?.id ?? null;
  const editable = ['OWNER', 'ADMIN', 'EDITOR'].includes(data.project.role);
  const [creating, setCreating] = useState(false);
  return (
    <div className="page-panel artifacts-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">SHARED KNOWLEDGE</span>
          <h1>Artifacts</h1>
          <p>Documents written by agents and teammates. Agents reuse them as context.</p>
        </div>
        {editable && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New document
          </button>
        )}
      </div>
      {!artifacts.length && !creating ? (
        <Empty
          title="No artifacts yet"
          description="Ask an agent to write a review, plan, API spec, or ADR."
        />
      ) : (
        <div className="artifact-layout">
          <aside>
            {artifacts.map((a) => (
              <button
                key={a.id}
                className={`artifact-item ${a.id === id && !creating ? 'active' : ''}`}
                onClick={() => {
                  setCreating(false);
                  onOpen(a.id);
                }}
              >
                <FileText size={15} />
                <span>
                  <strong>{a.title}</strong>
                  <small>
                    {kindLabels[a.kind] ?? a.kind} · v{a.revision} ·{' '}
                    {a.author_type === 'agent' ? '🤖 ' : ''}
                    {a.author_name} · {relative(a.updated_at)}
                  </small>
                </span>
              </button>
            ))}
          </aside>
          {creating ? (
            <ArtifactEditor
              data={data}
              onCancel={() => setCreating(false)}
              onSaved={(newId) => {
                setCreating(false);
                void client.invalidateQueries({ queryKey: ['artifacts', data.project.id] });
                onOpen(newId);
              }}
              notify={notify}
            />
          ) : (
            id && (
              <ArtifactViewer
                key={id}
                data={data}
                artifactId={id}
                notify={notify}
                editable={editable}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
function ArtifactViewer({
  data,
  artifactId,
  notify,
  editable,
}: {
  data: Snapshot;
  artifactId: string;
  notify: (m: string) => void;
  editable: boolean;
}) {
  const client = useQueryClient();
  const artifact = useQuery({
    queryKey: ['artifact', data.project.id, artifactId],
    queryFn: () =>
      api<{
        artifact: {
          id: string;
          title: string;
          kind: string;
          content: string;
          revision: number;
          author_name: string;
          updated_at: string;
        };
      }>(`/projects/${data.project.id}/artifacts/${artifactId}`),
  });
  const [editing, setEditing] = useState(false);
  const value = artifact.data?.artifact;
  if (!value)
    return (
      <div className="artifact-view">
        {artifact.error?.message ?? <Loader2 className="spin" size={16} />}
      </div>
    );
  if (editing)
    return (
      <ArtifactEditor
        data={data}
        existing={value}
        notify={notify}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void client.invalidateQueries({ queryKey: ['artifact', data.project.id, artifactId] });
          void client.invalidateQueries({ queryKey: ['artifacts', data.project.id] });
        }}
      />
    );
  return (
    <article className="artifact-view">
      <header>
        <div>
          <Badge>{kindLabels[value.kind] ?? value.kind}</Badge>
          <small>
            v{value.revision} · {value.author_name} · {relative(value.updated_at)}
          </small>
        </div>
        {editable && (
          <button className="btn small" onClick={() => setEditing(true)}>
            <Pencil size={13} /> Edit
          </button>
        )}
      </header>
      <h2>{value.title}</h2>
      <Markdown>{value.content}</Markdown>
    </article>
  );
}
function ArtifactEditor({
  data,
  existing,
  onCancel,
  onSaved,
  notify,
}: {
  data: Snapshot;
  existing?: { id: string; title: string; kind: string; content: string; revision: number };
  onCancel: () => void;
  onSaved: (id: string) => void;
  notify: (m: string) => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? ''),
    [kind, setKind] = useState(existing?.kind ?? 'document'),
    [content, setContent] = useState(existing?.content ?? ''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="artifact-view artifact-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          if (existing) {
            await patch(`/projects/${data.project.id}/artifacts/${existing.id}`, {
              title,
              content,
              revision: existing.revision,
            });
            onSaved(existing.id);
          } else {
            const created = await post<{ id: string }>(`/projects/${data.project.id}/artifacts`, {
              title,
              kind,
              content,
            });
            onSaved(created.id);
          }
          notify('Document saved.');
        } catch (error) {
          notify((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-row">
        <input
          aria-label="Document title"
          required
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {!existing && (
          <select aria-label="Document kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(kindLabels).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        aria-label="Document content"
        className="code-input full"
        rows={22}
        required
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Markdown"
      />
      <div className="editor-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          <Save size={14} /> Save
        </button>
      </div>
    </form>
  );
}

/** Explains when agents run offline rules instead of an LLM, with a one-click switch for admins. */
export function LocalAgentsNotice({
  data,
  notify,
}: {
  data: Snapshot;
  notify: (m: string) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const local = data.agents.filter((a) => a.enabled && a.provider === 'local');
  if (!local.length) return null;
  const manage = ['OWNER', 'ADMIN'].includes(data.project.role);
  const canUseOpenAI = !!data.availableProviders?.openai;
  return (
    <div className="notice danger local-agents-notice" role="alert">
      <AlertTriangle size={15} />
      <span>
        <strong>
          {local.length === data.agents.filter((a) => a.enabled).length ? 'All' : local.length}{' '}
          agents in this project use offline rules, not an LLM.
        </strong>{' '}
        Their answers are fixed configuration checks.
        {!canUseOpenAI && ' Add OPENAI_API_KEY to the server .env and restart it to use OpenAI.'}
        {canUseOpenAI && !manage && ' Ask a project owner or admin to switch them to OpenAI.'}
      </span>
      {canUseOpenAI && manage && (
        <button
          className="btn primary small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await post<{ updated: number }>(
                `/projects/${data.project.id}/agents/model`,
                {
                  provider: 'openai',
                  model: data.defaultModel ?? 'gpt-5.5',
                },
              );
              notify(`${result.updated} agents now use OpenAI ${data.defaultModel ?? 'gpt-5.5'}.`);
              void client.invalidateQueries({ queryKey: ['snapshot', data.project.id] });
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Use OpenAI for
          all agents
        </button>
      )}
    </div>
  );
}
