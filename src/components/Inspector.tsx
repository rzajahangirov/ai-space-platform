import { useState } from 'react';
import {
  Bot,
  X,
  ArrowUpRight,
  Trash2,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Save,
} from 'lucide-react';
import {
  protocols,
  type Component,
  type Edge,
  type Snapshot,
  type Mutation,
} from '../../shared/domain';
import { Badge, ComponentIcon, relative, Empty } from './UI';
import { MentionSuggestions } from './Panels';
export default function Inspector({
  selected,
  data,
  editable,
  onClose,
  onMutation,
  onComment,
  onResolve,
  onReview,
}: {
  selected: string;
  data: Snapshot;
  editable: boolean;
  onClose: () => void;
  onMutation: (changes: Mutation[], summary: string) => Promise<void>;
  onComment: (id: string, content: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onReview: (componentId: string) => void;
}) {
  const [tab, setTab] = useState('Overview');
  const [comment, setComment] = useState('');
  const [actionError, setActionError] = useState('');
  const node = data.graph.components.find((c) => c.id === selected),
    edge = data.graph.edges.find((e) => `edge:${e.id}` === selected);
  const findings = data.findings.filter((f) => f.component_id === selected && f.status === 'OPEN'),
    comments = data.comments.filter((c) => c.component_id === selected);
  if (edge)
    return (
      <EdgeInspector edge={edge} editable={editable} onClose={onClose} onMutation={onMutation} />
    );
  if (!node) return null;
  const tabs = ['Overview', 'Configuration', 'Dependencies', 'AI analysis', 'Comments', 'History'];
  return (
    <aside className="inspector">
      <div className="panel-label">
        COMPONENT INSPECTOR
        <button className="icon-btn" aria-label="Close inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className={`inspector-heading category-${node.category.toLowerCase()}`}>
        <span className="node-icon">
          <ComponentIcon category={node.category} size={24} />
        </span>
        <h2>{node.name}</h2>
        <p>
          {node.technology}
          <Badge>{node.category.toLowerCase()}</Badge>
        </p>
      </div>
      <div className="inspector-tabs">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
            {t === 'AI analysis' && findings.length > 0 && <b>{findings.length}</b>}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {tab === 'Overview' && (
          <>
            <div className="section-label">ABOUT THIS COMPONENT</div>
            <p className="body-copy">{node.description || 'No description yet.'}</p>
            <dl className="properties">
              <dt>Technology</dt>
              <dd>{node.technology}</dd>
              <dt>Environment</dt>
              <dd>
                <span className="tiny-dot" />
                {String(node.config.environment ?? data.project.environment)}
              </dd>
              <dt>Owner</dt>
              <dd>{String(node.config.owner ?? 'Unassigned')}</dd>
              <dt>Component ID</dt>
              <dd className="mono">{node.id}</dd>
              {Object.entries(node.config)
                .filter(([k]) => !['environment', 'owner'].includes(k))
                .map(([key, value]) => (
                  <div className="property-row" key={key}>
                    <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
            <div className="inspector-callout">
              <ShieldCheck size={18} />
              <div>
                <strong>Human-controlled architecture</strong>
                <p>Agent recommendations require approval before changing this component.</p>
              </div>
            </div>
            {findings.length > 0 && (
              <button className="issue-summary" onClick={() => setTab('AI analysis')}>
                <span>{findings.length} open findings</span>
                <ArrowUpRight size={16} />
              </button>
            )}
            <button className="btn full" onClick={() => onReview(node.id)}>
              <Sparkles size={15} /> Ask agents to review
            </button>
          </>
        )}
        {tab === 'Configuration' && (
          <NodeForm
            key={`${node.id}:${data.project.revision}`}
            node={node}
            editable={editable}
            onSave={async (component) =>
              onMutation([{ type: 'component.upsert', component }], `Updated ${component.name}`)
            }
            onDelete={async () => {
              await onMutation([{ type: 'component.delete', id: node.id }], `Removed ${node.name}`);
              onClose();
            }}
          />
        )}
        {tab === 'Dependencies' && (
          <>
            {data.graph.edges
              .filter((e) => e.source === node.id || e.target === node.id)
              .map((e) => (
                <div className="dependency" key={e.id}>
                  <ComponentIcon
                    category={
                      data.graph.components.find(
                        (c) => c.id === (e.source === node.id ? e.target : e.source),
                      )?.category ?? 'CUSTOM'
                    }
                  />
                  <div>
                    <strong>
                      {
                        data.graph.components.find(
                          (c) => c.id === (e.source === node.id ? e.target : e.source),
                        )?.name
                      }
                    </strong>
                    <small>
                      {e.source === node.id ? 'Outgoing' : 'Incoming'} · {e.protocol}
                    </small>
                  </div>
                </div>
              ))}
          </>
        )}
        {tab === 'AI analysis' && (
          <>
            {findings.length ? (
              findings.map((f) => (
                <article className="mini-finding" key={f.id}>
                  <Badge tone={f.severity.toLowerCase()}>{f.severity}</Badge>
                  <h3>{f.title}</h3>
                  <p>{f.evidence}</p>
                  <small>
                    {f.agent_name} · {Math.round(f.confidence * 100)}% confidence
                  </small>
                  <p>{f.recommendation}</p>
                </article>
              ))
            ) : (
              <Empty
                title="No open findings"
                description="Run a review to inspect the current configuration."
              />
            )}
          </>
        )}
        {tab === 'Comments' && (
          <>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await onComment(node.id, comment);
                  setComment('');
                  setActionError('');
                } catch (error) {
                  setActionError((error as Error).message);
                }
              }}
            >
              <textarea
                aria-label="Component comment"
                placeholder="Discuss this component. @SecurityAgent replies in this thread…"
                required
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <MentionSuggestions data={data} value={comment} onPick={setComment} />
              <button className="btn" type="submit" disabled={data.project.role === 'VIEWER'}>
                <MessageSquare size={14} /> Comment
              </button>
            </form>
            {actionError && (
              <p className="form-error" role="alert">
                {actionError}
              </p>
            )}
            {comments.map((c) => (
              <div
                className={`comment ${c.resolved ? 'resolved' : ''} ${c.actor_type === 'agent' ? 'agent' : ''}`}
                key={c.id}
              >
                <strong>
                  {c.actor_type === 'agent' && <Bot size={13} />} {c.author_name}
                </strong>
                {c.actor_type === 'agent' && <Badge>AGENT</Badge>}
                <small>{relative(c.created_at)}</small>
                <p>{c.content}</p>
                <button
                  className="text-btn"
                  disabled={data.project.role === 'VIEWER'}
                  onClick={async () => {
                    try {
                      await onResolve(c.id, !c.resolved);
                    } catch (error) {
                      setActionError((error as Error).message);
                    }
                  }}
                >
                  {c.resolved ? 'Reopen discussion' : 'Resolve'}
                </button>
              </div>
            ))}
          </>
        )}
        {tab === 'History' &&
          data.versions
            .filter((v) => v.graph.components.some((c) => c.id === node.id))
            .map((v) => (
              <div className="history-item" key={v.id}>
                <Badge>v{v.revision}</Badge>
                <div>
                  <strong>{v.summary}</strong>
                  <small>
                    {v.actor_name} · {relative(v.created_at)}
                  </small>
                </div>
              </div>
            ))}
      </div>
    </aside>
  );
}
function NodeForm({
  node,
  editable,
  onSave,
  onDelete,
}: {
  node: Component;
  editable: boolean;
  onSave: (node: Component) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(node.name),
    [description, setDescription] = useState(node.description),
    [config, setConfig] = useState(JSON.stringify(node.config, null, 2)),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false);
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const value = JSON.parse(config);
          if (!value || Array.isArray(value) || typeof value !== 'object')
            throw new Error('Configuration must be a JSON object.');
          await onSave({ ...node, name, description, config: value });
          setError('');
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={!editable}
        />
      </label>
      <label>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!editable}
        />
      </label>
      <label>
        Configuration <span>JSON</span>
        <textarea
          className="code-input"
          rows={14}
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          disabled={!editable}
          spellCheck={false}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      {editable && (
        <>
          <button className="btn primary" type="submit">
            <Save size={14} /> Save component
          </button>
          <div className="danger-zone">
            <p>Removing a component also removes its connections and comments.</p>
            <button
              className="btn danger"
              type="button"
              onClick={async () => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                try {
                  await onDelete();
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            >
              <Trash2 size={14} />
              {confirm ? 'Confirm removal' : 'Remove component'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
function EdgeInspector({
  edge,
  editable,
  onClose,
  onMutation,
}: {
  edge: Edge;
  editable: boolean;
  onClose: () => void;
  onMutation: (changes: Mutation[], summary: string) => Promise<void>;
}) {
  const [protocol, setProtocol] = useState(edge.protocol),
    [metadata, setMetadata] = useState(JSON.stringify(edge.metadata, null, 2)),
    [error, setError] = useState('');
  return (
    <aside className="inspector">
      <div className="panel-label">
        CONNECTION INSPECTOR
        <button className="icon-btn" onClick={onClose} aria-label="Close inspector">
          <X size={16} />
        </button>
      </div>
      <div className="inspector-body">
        <h2>
          {edge.source} → {edge.target}
        </h2>
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onMutation(
                [
                  {
                    type: 'edge.upsert',
                    edge: { ...edge, protocol, metadata: JSON.parse(metadata) },
                  },
                ],
                'Updated connection metadata',
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            Protocol
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as Edge['protocol'])}
            >
              {protocols.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Metadata
            <textarea
              className="code-input"
              rows={12}
              value={metadata}
              onChange={(e) => setMetadata(e.target.value)}
            />
          </label>
          <small>String values: endpoint, authentication, average_latency, traffic.</small>
          {error && <p className="form-error">{error}</p>}
          {editable && (
            <>
              <button className="btn primary">Save connection</button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  try {
                    await onMutation([{ type: 'edge.delete', id: edge.id }], 'Removed connection');
                    onClose();
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                Remove connection
              </button>
            </>
          )}
        </form>
      </div>
    </aside>
  );
}
