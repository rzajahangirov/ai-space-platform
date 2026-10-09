import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Bot,
  CheckCircle2,
  FileSearch,
  GitPullRequest,
  MessageSquare,
  Plus,
  Radar,
  ShieldCheck,
  Sparkles,
  Upload,
  UserPlus,
} from 'lucide-react';
import type { DiscoveredComponent, Discovery, DriftReport } from '../../server/discovery';
import type { Graph, Mutation, Notification, Snapshot } from '../../shared/domain';
import { shopSphereCompose } from '../../shared/samples';
import { api, post } from '../api';
import { Badge, ComponentIcon, Empty, relative } from './UI';

interface Observation {
  id: string;
  source_name: string;
  format: string;
  revision: number;
  drift: DriftReport;
  observed: Discovery;
  created_at: string;
  actor_name: string;
}
const confidenceTone = (c: number) => (c >= 0.8 ? 'green' : c >= 0.6 ? 'amber' : 'high');
const confidenceLabel = (c: number) =>
  `${Math.round(c * 100)}% ${c >= 0.8 ? 'confident' : c >= 0.6 ? '· review' : '· uncertain'}`;

function SourceInput({
  value,
  filename,
  onChange,
}: {
  value: string;
  filename: string;
  onChange: (value: string, filename: string) => void;
}) {
  return (
    <>
      <div className="source-input-row">
        <input
          aria-label="File name"
          value={filename}
          onChange={(e) => onChange(value, e.target.value)}
          placeholder="docker-compose.yml"
        />
        <label className="btn small">
          <Upload size={13} /> Choose file
          <input
            type="file"
            hidden
            accept=".yml,.yaml,.json,.txt"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file && file.size <= 200000) onChange(await file.text(), file.name);
            }}
          />
        </label>
        <button
          className="text-btn"
          type="button"
          onClick={() => onChange(shopSphereCompose, 'docker-compose.yml')}
        >
          Load sample Compose file
        </button>
      </div>
      <textarea
        className="code-input full"
        rows={10}
        spellCheck={false}
        aria-label="File content"
        placeholder="Paste docker-compose.yml, package.json, or requirements.txt"
        value={value}
        onChange={(e) => onChange(e.target.value, filename)}
      />
      <p className="help">
        Analysis is static: images, dependencies, and host names referenced in environment
        variables. Environment values are never stored.
      </p>
    </>
  );
}

export function ObservePanel({
  data,
  notify,
  onReview,
  onSelect,
  onMutation,
}: {
  data: Snapshot;
  notify: (message: string) => void;
  onReview: (prompt: string) => Promise<void>;
  onSelect: (componentId: string) => void;
  onMutation: (changes: Mutation[], summary: string) => Promise<void>;
}) {
  const [content, setContent] = useState(''),
    [filename, setFilename] = useState('docker-compose.yml'),
    [busy, setBusy] = useState(false),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const observations = useQuery({
    queryKey: ['observations', data.project.id],
    queryFn: () =>
      api<{ observations: Observation[] }>(`/projects/${data.project.id}/observations`),
  });
  const list = observations.data?.observations ?? [];
  const current = list.find((o) => o.id === selectedId) ?? list[0];
  const canReview = data.project.role !== 'VIEWER',
    editable = ['OWNER', 'ADMIN', 'EDITOR'].includes(data.project.role);
  const byName = new Map(data.graph.components.map((c) => [c.name, c.id]));
  async function compare() {
    setBusy(true);
    try {
      const result = await post<{ id: string; drift: DriftReport }>(
        `/projects/${data.project.id}/observations`,
        { content, filename: filename || undefined },
      );
      setSelectedId(result.id);
      await observations.refetch();
      notify(
        result.drift.total
          ? `${result.drift.total} drift item${result.drift.total === 1 ? '' : 's'} found. Agents can read this report.`
          : 'The observed system matches the design.',
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addToDesign(component: DiscoveredComponent) {
    const right = Math.max(0, ...data.graph.components.map((c) => c.x)) + 320;
    await onMutation(
      [
        {
          type: 'component.upsert',
          component: {
            id: crypto.randomUUID(),
            name: component.name,
            category: component.category,
            technology: component.technology,
            description: `Discovered from ${current?.source_name}: ${component.evidence}.`,
            x: right,
            y: 0,
            config: { ...component.config, environment: data.project.environment },
          },
        },
      ],
      `Added observed ${component.name}`,
    );
    notify(`${component.name} added to the design. Compare again to refresh drift.`);
  }
  const drift = current?.drift;
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">DESIGNED VS. OBSERVED</span>
          <h1>Observe mode</h1>
          <p>
            Compare what the architecture says with what a deployment manifest actually declares.
          </p>
        </div>
        <Badge>
          {list.length} observation{list.length === 1 ? '' : 's'}
        </Badge>
      </div>
      <div className="observe-layout">
        <section className="observe-source">
          <h2 className="subheading">
            <FileSearch size={15} /> New observation
          </h2>
          <SourceInput
            value={content}
            filename={filename}
            onChange={(v, f) => {
              setContent(v);
              setFilename(f);
            }}
          />
          <button
            className="btn primary full"
            disabled={!canReview || busy || !content.trim()}
            onClick={compare}
          >
            <Radar size={15} /> {busy ? 'Comparing…' : 'Compare with design'}
          </button>
          {list.length > 1 && (
            <>
              <h2 className="subheading">Previous observations</h2>
              {list.map((o) => (
                <button
                  key={o.id}
                  className={`version-button ${current?.id === o.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(o.id)}
                >
                  <Badge tone={o.drift.total ? 'amber' : 'green'}>{o.drift.total}</Badge>
                  <div>
                    <strong>{o.source_name}</strong>
                    <small>
                      v{o.revision} · {o.actor_name} · {relative(o.created_at)}
                    </small>
                  </div>
                </button>
              ))}
            </>
          )}
        </section>
        <section className="observe-report">
          {!current || !drift ? (
            <Empty
              title="No observation yet"
              description="Paste a Compose file or dependency manifest to detect architecture drift."
            />
          ) : (
            <>
              <div className="observe-summary">
                <div>
                  <strong>{current.source_name}</strong>
                  <small>
                    {current.format} · compared with v{current.revision} · {current.actor_name} ·{' '}
                    {relative(current.created_at)}
                  </small>
                </div>
                <div className="observe-stats">
                  <span>
                    <b>{drift.matches.length}</b> matched
                  </span>
                  <span className={drift.total ? 'warn' : ''}>
                    <b>{drift.total}</b> drift
                  </span>
                </div>
              </div>
              {current.revision !== data.project.revision && (
                <div className="notice">
                  <AlertTriangle size={15} />
                  <span>
                    The design changed since this comparison (now v{data.project.revision}). Compare
                    again for current drift.
                  </span>
                </div>
              )}
              {drift.warnings.map((w) => (
                <div className="notice danger" key={w}>
                  <ShieldCheck size={15} />
                  <span>{w}</span>
                </div>
              ))}
              {!drift.total && (
                <div className="notice">
                  <CheckCircle2 size={15} />
                  <span>No drift between the observed components and the design.</span>
                </div>
              )}
              {drift.expectedEdges.length > 0 && (
                <DriftGroup title="Designed connection, not observed" tone="amber">
                  {drift.expectedEdges.map((e) => (
                    <div className="drift-row" key={`${e.sourceName}>${e.targetName}`}>
                      <span className="drift-tag">EXPECTED</span>
                      <button
                        className="text-btn"
                        onClick={() => onSelect(byName.get(e.sourceName)!)}
                      >
                        {e.sourceName}
                      </button>
                      <ArrowRight size={13} />
                      <button
                        className="text-btn"
                        onClick={() => onSelect(byName.get(e.targetName)!)}
                      >
                        {e.targetName}
                      </button>
                      <Badge>{e.protocol}</Badge>
                    </div>
                  ))}
                </DriftGroup>
              )}
              {drift.unexpectedEdges.length > 0 && (
                <DriftGroup title="Observed connection, not designed" tone="high">
                  {drift.unexpectedEdges.map((e) => (
                    <div className="drift-row" key={`${e.sourceName}>${e.targetName}`}>
                      <span className="drift-tag observed">OBSERVED</span>
                      <button
                        className="text-btn"
                        onClick={() => onSelect(byName.get(e.sourceName)!)}
                      >
                        {e.sourceName}
                      </button>
                      <ArrowRight size={13} />
                      <button
                        className="text-btn"
                        onClick={() => onSelect(byName.get(e.targetName)!)}
                      >
                        {e.targetName}
                      </button>
                      <small>{e.evidence}</small>
                    </div>
                  ))}
                </DriftGroup>
              )}
              {drift.undeclared.length > 0 && (
                <DriftGroup title="Observed component missing from the design" tone="high">
                  {drift.undeclared.map((u) => {
                    const component = current.observed.components.find(
                      (c) => c.key === u.observedKey,
                    );
                    return (
                      <div className="drift-row" key={u.observedKey}>
                        {component && <ComponentIcon category={component.category} size={14} />}
                        <strong>{u.name}</strong>
                        <small>{u.technology}</small>
                        <Badge tone={confidenceTone(u.confidence)}>
                          {confidenceLabel(u.confidence)}
                        </Badge>
                        {editable && component && (
                          <button className="btn small" onClick={() => void addToDesign(component)}>
                            <Plus size={13} /> Add to design
                          </button>
                        )}
                      </div>
                    );
                  })}
                </DriftGroup>
              )}
              {drift.missingInObservation.length > 0 && (
                <DriftGroup title="Designed component not observed" tone="amber">
                  {drift.missingInObservation.map((m) => (
                    <div className="drift-row" key={m.componentId}>
                      <button className="text-btn" onClick={() => onSelect(m.componentId)}>
                        {m.name}
                      </button>
                      <small>{m.technology}</small>
                    </div>
                  ))}
                </DriftGroup>
              )}
              <details className="drift-matches">
                <summary>{drift.matches.length} matched components</summary>
                {drift.matches.map((m) => (
                  <div className="drift-row" key={m.observedKey}>
                    <code>{m.observedKey}</code>
                    <ArrowRight size={13} />
                    <span>{m.name}</span>
                    <Badge tone={m.basis === 'technology' ? 'amber' : 'neutral'}>
                      by {m.basis}
                    </Badge>
                  </div>
                ))}
              </details>
              {canReview && drift.total > 0 && (
                <button
                  className="btn primary"
                  onClick={() =>
                    void onReview(
                      'Analyze the latest observed-architecture drift report in the knowledge sources. Decide which side is wrong (design or deployment) for each item, cite evidence, and propose design changes only where the observed system is correct.',
                    )
                  }
                >
                  <Sparkles size={15} /> Ask agents to analyze this drift
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function DriftGroup({
  title,
  tone,
  children,
}: {
  title: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <section className={`drift-group ${tone}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Discovery-based import: the human picks which discovered components and connections to merge. */
export function DiscoveryImport({
  projectId,
  graph,
  environment,
  editable,
  onMerge,
}: {
  projectId: string;
  graph: Graph;
  environment: string;
  editable: boolean;
  onMerge: (changes: Mutation[], summary: string) => Promise<void>;
}) {
  const [content, setContent] = useState(''),
    [filename, setFilename] = useState(''),
    [result, setResult] = useState<{
      discovery: Discovery;
      matches: DriftReport['matches'];
    } | null>(null),
    [chosen, setChosen] = useState<Set<string>>(new Set()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const matched = new Map(result?.matches.map((m) => [m.observedKey, m]) ?? []);
  async function analyze() {
    setBusy(true);
    try {
      const value = await post<{ discovery: Discovery; matches: DriftReport['matches'] }>(
        `/projects/${projectId}/discover`,
        { content, filename: filename || undefined },
      );
      setResult(value);
      const known = new Set(value.matches.map((m) => m.observedKey));
      // Uncertain guesses start unselected: the human opts in instead of opting out.
      setChosen(
        new Set(
          value.discovery.components
            .filter((c) => !known.has(c.key) && c.confidence >= 0.6)
            .map((c) => c.key),
        ),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function mutations(): Mutation[] {
    if (!result) return [];
    const ids = new Map<string, string>(result.matches.map((m) => [m.observedKey, m.componentId]));
    const left = Math.max(0, ...graph.components.map((c) => c.x)) + 340;
    const rows = new Map<string, number>();
    const columns = [
      'FRONTEND',
      'CLIENT',
      'INFRASTRUCTURE',
      'AUTH',
      'BACKEND',
      'MESSAGING',
      'AI',
      'DATABASE',
      'STORAGE',
      'OBSERVABILITY',
      'EXTERNAL',
      'CUSTOM',
    ];
    const changes: Mutation[] = [];
    for (const c of result.discovery.components) {
      if (!chosen.has(c.key) || ids.has(c.key)) continue;
      const id = crypto.randomUUID();
      ids.set(c.key, id);
      const column = Math.floor(columns.indexOf(c.category) / 2);
      const row = rows.get(String(column)) ?? 0;
      rows.set(String(column), row + 1);
      changes.push({
        type: 'component.upsert',
        component: {
          id,
          name: c.name.slice(0, 100),
          category: c.category,
          technology: c.technology,
          description: `Discovered: ${c.evidence}`.slice(0, 4000),
          x: left + column * 280,
          y: row * 170,
          config: { ...c.config, environment, discoveryConfidence: c.confidence },
        },
      });
    }
    for (const e of result.discovery.edges) {
      const source = ids.get(e.source),
        target = ids.get(e.target);
      if (!source || !target) continue;
      if (
        graph.edges.some(
          (g) =>
            (g.source === source && g.target === target) ||
            (g.source === target && g.target === source),
        )
      )
        continue;
      changes.push({
        type: 'edge.upsert',
        edge: {
          id: crypto.randomUUID(),
          source,
          target,
          protocol: e.protocol,
          metadata: { discoveredFrom: e.evidence.slice(0, 1000), confidence: String(e.confidence) },
        },
      });
    }
    return changes;
  }
  const planned = mutations();
  return (
    <>
      <SourceInput
        value={content}
        filename={filename}
        onChange={(v, f) => {
          setContent(v);
          setFilename(f);
          setResult(null);
        }}
      />
      {error && <p className="form-error">{error}</p>}
      {!result ? (
        <button
          className="btn primary full"
          disabled={!editable || busy || !content.trim()}
          onClick={analyze}
        >
          <FileSearch size={15} /> {busy ? 'Analyzing…' : 'Discover architecture'}
        </button>
      ) : (
        <>
          <div className="discovery-list">
            {result.discovery.components.map((c) => {
              const match = matched.get(c.key);
              return (
                <label className={`discovery-item ${match ? 'matched' : ''}`} key={c.key}>
                  <input
                    type="checkbox"
                    disabled={!!match}
                    checked={!!match || chosen.has(c.key)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(c.key);
                      else next.delete(c.key);
                      setChosen(next);
                    }}
                  />
                  <ComponentIcon category={c.category} size={14} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {c.technology} · {c.evidence}
                    </small>
                  </span>
                  {match ? (
                    <Badge>matches {match.name}</Badge>
                  ) : (
                    <Badge tone={confidenceTone(c.confidence)}>
                      {confidenceLabel(c.confidence)}
                    </Badge>
                  )}
                </label>
              );
            })}
          </div>
          {result.discovery.warnings.map((w) => (
            <div className="notice danger" key={w}>
              <ShieldCheck size={15} />
              <span>{w}</span>
            </div>
          ))}
          <div className="notice">
            <span>
              {planned.filter((m) => m.type === 'component.upsert').length} new components ·{' '}
              {planned.filter((m) => m.type === 'edge.upsert').length} new connections. Existing
              components are kept; nothing is deleted. Discovery is inferred and may be wrong.
            </span>
          </div>
          <button
            className="btn primary full"
            disabled={!editable || busy || !planned.length || planned.length > 100}
            onClick={async () => {
              setBusy(true);
              try {
                await onMerge(
                  planned,
                  `Merged discovered architecture from ${filename || result.discovery.format}`,
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {planned.length > 100 ? 'Select at most 100 changes' : 'Merge reviewed selection'}
          </button>
        </>
      )}
    </>
  );
}

const kindIcon: Record<string, typeof Bell> = {
  mention: MessageSquare,
  approval_request: GitPullRequest,
  critical_finding: AlertTriangle,
  run_completed: CheckCircle2,
  run_failed: AlertTriangle,
  drift_detected: Radar,
  member_joined: UserPlus,
};
export function InboxPanel({
  notifications,
  onOpen,
  onReadAll,
}: {
  notifications: Notification[];
  onOpen: (n: Notification) => void;
  onReadAll: () => void;
}) {
  const unread = notifications.filter((n) => !n.read_at).length;
  return (
    <div className="page-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">WHAT NEEDS YOU</span>
          <h1>Inbox</h1>
          <p>Mentions, approval requests, critical findings, drift, and finished reviews.</p>
        </div>
        {unread > 0 && (
          <button className="btn small" onClick={onReadAll}>
            Mark all read
          </button>
        )}
      </div>
      {notifications.length ? (
        notifications.map((n) => {
          const Icon = kindIcon[n.kind] ?? Bell;
          return (
            <button
              className={`inbox-row ${n.read_at ? '' : 'unread'}`}
              key={n.id}
              onClick={() => onOpen(n)}
            >
              <span className={`inbox-icon ${n.kind}`}>
                {n.actor_name && n.kind !== 'mention' ? <Bot size={15} /> : <Icon size={15} />}
              </span>
              <span className="inbox-text">
                <strong>{n.title}</strong>
                {n.body && <small>{n.body}</small>}
              </span>
              <span className="inbox-meta">
                <Badge>{n.project_name}</Badge>
                <small>{relative(n.created_at)}</small>
              </span>
            </button>
          );
        })
      ) : (
        <Empty
          title="You’re all caught up"
          description="Mentions and approval requests will appear here."
        />
      )}
    </div>
  );
}
