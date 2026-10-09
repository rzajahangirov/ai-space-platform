import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Check,
  X,
  ArrowUpRight,
  Clock,
  GitPullRequest,
  Activity,
  FileText,
  Play,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Send,
  Terminal,
  Copy,
} from 'lucide-react';
import { type Snapshot, type Agent, type Mutation, health } from '../../shared/domain';
import { api, post, patch } from '../api';
import { Badge, Empty, relative, initials, Modal } from './UI';
import { ProposalCard } from './Conversations';
type Common = { data: Snapshot; refresh: () => void; notify: (message: string) => void };
export function AgentPanel({
  data,
  refresh,
  notify,
}: {
  data: Snapshot;
  refresh: () => void;
  notify: (s: string) => void;
}) {
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);
  const manage = ['OWNER', 'ADMIN'].includes(data.project.role);
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR ENGINEERING TEAM</span>
          <h1>
            Agent library <span>{data.agents.length}</span>
          </h1>
          <p>Specialists that share your system, context, and decisions.</p>
        </div>
        {manage && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={15} /> Create agent
          </button>
        )}
      </div>
      <div className="notice">
        <ShieldCheck size={18} />
        <span>
          Agents can inspect this project and propose changes.{' '}
          <strong>You control what gets applied.</strong>
        </span>
      </div>
      {manage && <ModelRouting data={data} refresh={refresh} notify={notify} />}
      <div className="agent-grid">
        {data.agents.map((agent) => {
          const usage = data.usage.filter((u) => u.agent_id === agent.id);
          return (
            <article className="agent-card" key={agent.id}>
              <div className="agent-card-top">
                <span className={`agent-avatar role-${agent.role}`}>
                  <Bot size={22} />
                </span>
                <Badge tone={agent.enabled ? 'green' : 'neutral'}>
                  {agent.enabled ? agent.status : 'disabled'}
                </Badge>
              </div>
              <h3>{agent.name}</h3>
              <p>{agent.description}</p>
              <div className="agent-model">
                <span className="tiny-dot" />
                {agent.provider === 'local'
                  ? 'Local rules · no API calls'
                  : agent.provider === 'openai'
                    ? 'OpenAI · tool-calling agent'
                    : agent.provider}{' '}
                <code>{agent.model}</code>
              </div>
              <div className="agent-capabilities">
                <span>Architecture</span>
                <span>Search</span>
                <span>Proposals</span>
                <span>Findings</span>
                <span>Documents</span>
                <span>Delegation</span>
              </div>
              <footer>
                <small>
                  {usage.length} calls ·{' '}
                  {usage.some((u) => u.estimated_cost === null)
                    ? 'cost not configured'
                    : `$${usage.reduce((n, u) => n + Number(u.estimated_cost), 0).toFixed(4)}`}
                </small>
                {manage && (
                  <button
                    className="icon-btn"
                    aria-label={`Configure ${agent.name}`}
                    onClick={() => setEditing(agent)}
                  >
                    <Settings2 size={16} />
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
      {editing && (
        <AgentEditor
          agent={editing}
          projectId={data.project.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
            notify('Agent configuration saved.');
          }}
        />
      )}
    </div>
  );
}
const openaiModels = ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-6.1-sol', 'gpt-4.1'];
function ModelRouting({ data, refresh, notify }: Common) {
  const [provider, setProvider] = useState('openai'),
    [model, setModel] = useState('gpt-5.5'),
    [busy, setBusy] = useState(false);
  const models = [...new Set(data.agents.map((a) => `${a.provider}/${a.model}`))];
  return (
    <form
      className="model-routing"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const result = await post<{ updated: number }>(
            `/projects/${data.project.id}/agents/model`,
            { provider, model },
          );
          refresh();
          notify(`${result.updated} agents now use ${provider}/${model}.`);
        } catch (error) {
          notify((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span>
        <strong>Model for all agents</strong>
        <small>Currently: {models.join(', ')}</small>
      </span>
      <select
        aria-label="Provider for all agents"
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value);
          setModel(
            e.target.value === 'local' ? 'rules-v1' : e.target.value === 'openai' ? 'gpt-5.5' : '',
          );
        }}
      >
        {['openai', 'local', 'anthropic', 'google'].map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <input
        aria-label="Model for all agents"
        list="openai-models"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        required
      />
      <datalist id="openai-models">
        {openaiModels.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button className="btn" disabled={busy}>
        Apply to all
      </button>
    </form>
  );
}
function AgentEditor({
  agent,
  projectId,
  onClose,
  onSaved,
}: {
  agent: Agent | 'new';
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const original =
    agent === 'new'
      ? {
          name: '',
          role: 'architect',
          description: '',
          provider: 'local',
          model: 'rules-v1',
          instructions:
            'Review architecture using explicit evidence. Propose changes for human approval.',
          enabled: true,
        }
      : agent;
  const [form, setForm] = useState({
      name: original.name,
      role: original.role,
      description: original.description,
      provider: original.provider,
      model: original.model,
      instructions: original.instructions,
      enabled: original.enabled,
      reasoningEffort: ((agent !== 'new' && (agent.settings?.reasoningEffort as string)) ||
        '') as string,
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={agent === 'new' ? 'Create an engineering agent' : `Configure ${agent.name}`}
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const { reasoningEffort, ...rest } = form;
            const body = { ...rest, ...(reasoningEffort ? { reasoningEffort } : {}) };
            if (agent === 'new') await post(`/projects/${projectId}/agents`, body);
            else await patch(`/projects/${projectId}/agents/${agent.id}`, body);
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Specialty
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {[
              'architect',
              'backend',
              'security',
              'database',
              'performance',
              'devops',
              'qa',
              'frontend',
            ].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label>
            Provider
            <select
              value={form.provider}
              onChange={(e) =>
                setForm({
                  ...form,
                  provider: e.target.value,
                  model: e.target.value === 'local' ? 'rules-v1' : '',
                })
              }
            >
              {['local', 'openai', 'anthropic', 'google'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Model ID
            <input
              required
              list={form.provider === 'openai' ? 'agent-openai-models' : undefined}
              value={form.model}
              placeholder="Exact provider model ID"
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
            <datalist id="agent-openai-models">
              {openaiModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>
        {form.provider === 'openai' && (
          <label>
            Reasoning effort
            <select
              value={form.reasoningEffort}
              onChange={(e) => setForm({ ...form, reasoningEffort: e.target.value })}
            >
              <option value="">Default (low)</option>
              {['minimal', 'low', 'medium', 'high'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        <p className="help">
          Provider API keys stay on the server. Model availability depends on your provider account.
          Local rules use no LLM.
        </p>
        <label>
          Description
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label>
          System instructions
          <textarea
            rows={5}
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />{' '}
          Enabled in this project
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          Save agent
        </button>
      </form>
    </Modal>
  );
}
export function FindingsPanel({
  data,
  refresh,
  notify,
  onSelect,
}: Common & { onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('OPEN');
  const findings = data.findings.filter((f) => filter === 'ALL' || f.status === filter);
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">EVIDENCE, NOT GUESSWORK</span>
          <h1>Engineering findings</h1>
          <p>Trace every recommendation back to the system.</p>
        </div>
        <select
          aria-label="Finding status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {['OPEN', 'RESOLVED', 'DISMISSED', 'ALL'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </div>
      {findings.length ? (
        findings.map((f) => (
          <article className="finding-card" key={f.id}>
            <div className="finding-card-top">
              <Badge tone={f.severity.toLowerCase()}>{f.severity}</Badge>
              <span>{f.category}</span>
              <small>{Math.round(f.confidence * 100)}% confidence</small>
            </div>
            <h3>{f.title}</h3>
            <p>{f.description}</p>
            <div className="evidence">
              <span>EVIDENCE</span>
              <p>{f.evidence}</p>
            </div>
            <p>
              <strong>Recommendation</strong> · {f.recommendation}
            </p>
            <footer>
              <span className="author">
                <Bot size={15} />
                {f.agent_name}
              </span>
              <div>
                {f.component_id && (
                  <button className="text-btn" onClick={() => onSelect(f.component_id!)}>
                    Inspect component <ArrowUpRight size={14} />
                  </button>
                )}
                {data.project.role !== 'VIEWER' && (
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        await patch(`/projects/${data.project.id}/findings/${f.id}`, {
                          status: f.status === 'OPEN' ? 'RESOLVED' : 'OPEN',
                        });
                        refresh();
                      } catch (e) {
                        notify((e as Error).message);
                      }
                    }}
                  >
                    {f.status === 'OPEN' ? 'Mark resolved' : 'Reopen'}
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))
      ) : (
        <Empty
          title="No findings here"
          description="Run an architecture review to produce findings backed by configuration evidence."
        />
      )}
    </div>
  );
}
export function ProposalsPanel({ data, refresh, notify }: Common) {
  const [pending, setPending] = useState<string | null>(null);
  const manage = ['OWNER', 'ADMIN'].includes(data.project.role);
  async function decide(id: string, decision: string) {
    setPending(id);
    try {
      await post(`/projects/${data.project.id}/proposals/${id}/decision`, { decision });
      refresh();
      notify(
        decision === 'APPROVED'
          ? 'Proposal approved and architecture version saved.'
          : 'Proposal rejected.',
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">HUMANS MAKE THE CALL</span>
          <h1>Change proposals</h1>
          <p>Review the evidence, tradeoffs, and exact change before approval.</p>
        </div>
        <Badge>{data.proposals.filter((p) => p.status === 'PENDING').length} awaiting review</Badge>
      </div>
      {data.proposals.length ? (
        data.proposals.map((p) => (
          <div className="proposal-wrapper" key={p.id}>
            <small className="proposal-meta">
              <Bot size={13} /> {p.agent_name} · {relative(p.created_at)}
            </small>
            <ProposalCard proposal={p} data={data} notify={notify} onDecided={refresh} />
          </div>
        ))
      ) : (
        <Empty
          title="No proposals yet"
          description="Agents propose changes after a review. Nothing is applied without an owner or admin's approval."
        />
      )}
    </div>
  );
}
function nameOf(changes: Mutation[], data: Snapshot, id: string) {
  const proposed = changes.find((c) => c.type === 'component.upsert' && c.component.id === id);
  return (
    data.graph.components.find((c) => c.id === id)?.name ??
    (proposed?.type === 'component.upsert' ? proposed.component.name : 'removed component')
  );
}
export function HealthPanel({ data }: { data: Snapshot }) {
  const result = health(data.findings);
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">TRANSPARENT BY DESIGN</span>
          <h1>Architecture health</h1>
          <p>A finding-based review index. Not a production readiness certification.</p>
        </div>
        <div className="health-big">
          {result.score}
          <small>/ 100</small>
        </div>
      </div>
      <div className="notice">
        <Activity size={18} />
        <span>
          Starts at 100. Open findings deduct: critical 20, high 10, medium 5, low 2, info 0. No
          runtime telemetry is connected.
        </span>
      </div>
      <div className="health-grid">
        {result.categories.map((c) => (
          <details className="health-card" key={c.category}>
            <summary>
              <strong>{c.category}</strong>
              <span>{c.findings.length ? `${c.score}/100` : 'Not assessed'}</span>
            </summary>
            <div className="score-track">
              <i style={{ width: `${c.score}%` }} />
            </div>
            {c.findings.length ? (
              c.findings.map((f, i) => (
                <p key={i}>
                  <Badge tone={f.severity.toLowerCase()}>{f.severity}</Badge>{' '}
                  {'title' in f ? String(f.title) : 'Open finding'}
                </p>
              ))
            ) : (
              <p>
                No open findings in this category. This does not establish coverage or correctness.
              </p>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}
export function ActivityPanel({ data }: { data: Snapshot }) {
  const tools = useQuery({
    queryKey: ['tools', data.project.id, data.activity[0]?.id],
    queryFn: () => api(`/projects/${data.project.id}/tools`),
  });
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">NOTHING BEHIND THE CURTAIN</span>
          <h1>Activity & audit trail</h1>
          <p>Operational steps, tool access, and human decisions.</p>
        </div>
      </div>
      <div className="timeline">
        {data.activity.map((a) => (
          <article key={a.id}>
            <span className="timeline-icon">
              {a.action.startsWith('agent') ? <Bot size={16} /> : <Activity size={16} />}
            </span>
            <div>
              <strong>{a.actor_name}</strong>
              <Badge>{a.action}</Badge>
              <p>{a.detail}</p>
              <small>{new Date(a.created_at).toLocaleString()}</small>
            </div>
          </article>
        ))}
      </div>
      <h2 className="subheading">Tool executions</h2>
      {tools.data?.executions.map((t: any) => (
        <div className="tool-row" key={t.id}>
          <Terminal size={15} />
          <code>{t.tool}</code>
          <Badge>{t.operation}</Badge>
          <Badge tone={t.status === 'completed' ? 'green' : 'amber'}>{t.status}</Badge>
          <small>
            {t.duration_ms}ms · {t.policy}
          </small>
        </div>
      ))}
    </div>
  );
}
export function TasksPanel({ data }: { data: Snapshot }) {
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">BOUNDED, OBSERVABLE WORK</span>
          <h1>Review tasks</h1>
          <p>Every review has a durable run, bounded budget, and visible outcome.</p>
        </div>
      </div>
      {data.runs.length ? (
        data.runs.map((r) => (
          <article className="task-row" key={r.id}>
            <span className="task-icon">
              {r.status === 'completed' ? (
                <CheckCircle2 size={20} />
              ) : r.status === 'failed' ? (
                <AlertTriangle size={20} />
              ) : (
                <Clock size={20} />
              )}
            </span>
            <div>
              <h3>{r.prompt}</h3>
              <small>{relative(r.created_at)}</small>
              {r.error && <p className="form-error">{r.error}</p>}
            </div>
            <Badge
              tone={r.status === 'completed' ? 'green' : r.status === 'failed' ? 'high' : 'amber'}
            >
              {r.status}
            </Badge>
          </article>
        ))
      ) : (
        <Empty
          title="Ready for the first review"
          description="Run an architecture review or ask a specific agent to investigate a component."
        />
      )}
    </div>
  );
}
export function VersionsPanel({
  data,
  onMutation,
}: {
  data: Snapshot;
  onMutation: (m: Mutation[], s: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(data.versions[0]?.id);
  const [confirm, setConfirm] = useState(false);
  const version = data.versions.find((v) => v.id === selected);
  const editable = ['OWNER', 'ADMIN', 'EDITOR'].includes(data.project.role);
  const previous = version
    ? data.versions.find((v) => v.revision === version.revision - 1)
    : undefined;
  const changes = version
    ? {
        added: version.graph.components.filter(
          (c) => !previous?.graph.components.some((p) => p.id === c.id),
        ),
        removed:
          previous?.graph.components.filter(
            (c) => !version.graph.components.some((p) => p.id === c.id),
          ) ?? [],
        changed: version.graph.components.filter((c) =>
          previous?.graph.components.some(
            (p) => p.id === c.id && JSON.stringify(p) !== JSON.stringify(c),
          ),
        ),
        addedEdges: version.graph.edges.filter(
          (e) => !previous?.graph.edges.some((p) => p.id === e.id),
        ),
        removedEdges:
          previous?.graph.edges.filter((e) => !version.graph.edges.some((p) => p.id === e.id)) ??
          [],
      }
    : null;
  const label = (id: string) =>
    version?.graph.components.find((c) => c.id === id)?.name ??
    previous?.graph.components.find((c) => c.id === id)?.name ??
    id;
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AN EVOLVING SYSTEM</span>
          <h1>Architecture history</h1>
          <p>Restoring a version creates a new, audited revision.</p>
        </div>
      </div>
      <div className="version-layout">
        <div>
          {data.versions.map((v) => (
            <button
              key={v.id}
              className={`version-button ${selected === v.id ? 'active' : ''}`}
              onClick={() => {
                setSelected(v.id);
                setConfirm(false);
              }}
            >
              <Badge>v{v.revision}</Badge>
              <div>
                <strong>{v.summary}</strong>
                <small>
                  {v.actor_name} · {relative(v.created_at)}
                </small>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
        {version && (
          <div className="version-detail">
            <h2>Version {version.revision}</h2>
            <p>
              {version.graph.components.length} components · {version.graph.edges.length}{' '}
              connections
            </p>
            <div className="diff-counts">
              <Badge tone="green">+{changes?.added.length} added</Badge>
              <Badge tone="high">−{changes?.removed.length} removed</Badge>
              <Badge tone="amber">{changes?.changed.length} changed</Badge>
              <Badge tone="green">+{changes?.addedEdges.length} connections</Badge>
              <Badge tone="high">−{changes?.removedEdges.length} connections</Badge>
            </div>
            {changes?.added.map((c) => (
              <p className="diff-added" key={c.id}>
                + {c.name}
              </p>
            ))}
            {changes?.removed.map((c) => (
              <p className="diff-removed" key={c.id}>
                − {c.name}
              </p>
            ))}
            {changes?.addedEdges.map((e) => (
              <p className="diff-added" key={e.id}>
                + {label(e.source)} → {label(e.target)} · {e.protocol}
              </p>
            ))}
            {changes?.removedEdges.map((e) => (
              <p className="diff-removed" key={e.id}>
                − {label(e.source)} → {label(e.target)} · {e.protocol}
              </p>
            ))}
            {changes?.changed.map((c) => (
              <details key={c.id}>
                <summary>{c.name}</summary>
                <pre>{JSON.stringify(c.config, null, 2)}</pre>
              </details>
            ))}
            {editable && version.revision !== data.project.revision && (
              <button
                className="btn"
                onClick={() => {
                  if (!confirm) setConfirm(true);
                  else
                    void onMutation(
                      [{ type: 'graph.restore', graph: version.graph }],
                      `Restored version ${version.revision}`,
                    );
                }}
              >
                {confirm ? 'Confirm restore (replaces current graph)' : 'Restore this version'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
export function KnowledgePanel({ data, notify }: Common) {
  const sources = useQuery({
    queryKey: ['knowledge', data.project.id],
    queryFn: () => api(`/projects/${data.project.id}/knowledge`),
  });
  const [adding, setAdding] = useState(false),
    [title, setTitle] = useState(''),
    [content, setContent] = useState('');
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">SHARED PROJECT CONTEXT</span>
          <h1>Knowledge</h1>
          <p>Architecture briefs, requirements, and documentation your agents can retrieve.</p>
        </div>
        {['OWNER', 'ADMIN', 'EDITOR'].includes(data.project.role) && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> Add document
          </button>
        )}
      </div>
      {sources.data?.sources.map((s: any) => (
        <article className="knowledge-card" key={s.id}>
          <FileText size={20} />
          <div>
            <h3>{s.title}</h3>
            <Badge>{s.kind}</Badge>
            <p>{s.content}</p>
          </div>
        </article>
      ))}
      {adding && (
        <Modal title="Add project knowledge" onClose={() => setAdding(false)}>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post(`/projects/${data.project.id}/knowledge`, { title, content });
                await sources.refetch();
                setAdding(false);
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <label>
              Title
              <input required value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Content
              <textarea
                required
                rows={12}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>
            <p className="help">
              Do not paste secrets. Authorized project agents may send relevant excerpts to their
              configured model provider.
            </p>
            <button className="btn primary">Save document</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
/** Completes the trailing @token with an agent or teammate handle. */
export function MentionSuggestions({
  data,
  value,
  onPick,
}: {
  data: Snapshot;
  value: string;
  onPick: (value: string) => void;
}) {
  const match = /(^|\s)@([\w-]*)$/.exec(value);
  if (!match) return null;
  const query = match[2].toLowerCase();
  const options = [
    ...data.agents
      .filter((a) => a.enabled)
      .map((a) => ({ handle: a.name.replace(/\s+/g, ''), label: a.name, agent: true })),
    ...data.members.map((m) => ({
      handle: m.name.split(/\s+/)[0],
      label: m.name,
      agent: false,
    })),
  ]
    .filter((o) => o.handle.toLowerCase().includes(query) || o.label.toLowerCase().includes(query))
    .slice(0, 6);
  if (!options.length) return null;
  return (
    <div className="mention-suggestions" role="listbox" aria-label="Mention suggestions">
      {options.map((o) => (
        <button
          type="button"
          role="option"
          aria-selected={false}
          key={`${o.agent}-${o.label}`}
          // Keep focus in the text box so typing continues after the completed mention.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const next = `${value.slice(0, value.length - match[2].length)}${o.handle} `;
            const area = e.currentTarget.closest('form')?.querySelector('textarea');
            onPick(next);
            requestAnimationFrame(() => {
              area?.focus();
              area?.setSelectionRange(next.length, next.length);
            });
          }}
        >
          {o.agent ? <Bot size={13} /> : <span className="mini-avatar">{initials(o.label)}</span>}
          <span>@{o.handle}</span>
          <small>{o.agent ? 'agent' : 'teammate'}</small>
        </button>
      ))}
    </div>
  );
}
export function Collaboration({
  data,
  onSend,
  onClose,
}: {
  data: Snapshot;
  onSend: (content: string, agentId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [message, setMessage] = useState(''),
    [target, setTarget] = useState(data.agents.find((a) => a.role === 'architect')?.id ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="collaboration">
      <header>
        <div>
          <span className="green-dot" />
          <strong>Engineering room</strong>
          <Badge>{data.agents.filter((a) => a.enabled).length} agents</Badge>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close engineering room">
          <X size={16} />
        </button>
      </header>
      <div className="room-context">
        <ShieldCheck size={13} /> Connected to your architecture · v{data.project.revision}
      </div>
      <div className="messages">
        {data.messages.length ? (
          data.messages.map((m) => (
            <article className="message" key={m.id}>
              <span className={`message-avatar ${m.actor_type === 'agent' ? 'ai' : ''}`}>
                {m.actor_type === 'agent' ? <Bot size={17} /> : initials(m.author_name)}
              </span>
              <div>
                <div className="message-meta">
                  <strong>{m.author_name}</strong>
                  {m.actor_type === 'agent' && <Badge>AGENT</Badge>}
                  <small>{relative(m.created_at)}</small>
                </div>
                <p>{m.content}</p>
              </div>
            </article>
          ))
        ) : (
          <Empty
            title="Start the engineering conversation"
            description="Ask an agent to inspect a component or discuss a system tradeoff."
          />
        )}
        {data.agents
          .filter((a) => a.status !== 'idle')
          .map((a) => (
            <div className="agent-thinking" key={a.id}>
              <span className="pulse-dot" />
              {a.name} · {a.status}
            </div>
          ))}
      </div>
      <form
        className="composer"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSend(message, target || undefined);
            setMessage('');
            setError('');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <textarea
          aria-label="Message engineering room"
          placeholder="Discuss your system. @mention agents (e.g. @SecurityAgent) or teammates…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          maxLength={4000}
        />
        <MentionSuggestions data={data} value={message} onPick={setMessage} />
        <div>
          <select
            aria-label="Message recipient"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Team discussion</option>
            {data.agents
              .filter((a) => a.enabled)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.name}
                </option>
              ))}
          </select>
          <button
            className="send-btn"
            aria-label="Send message"
            disabled={busy || data.project.role === 'VIEWER'}
          >
            <Send size={16} />
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </section>
  );
}
