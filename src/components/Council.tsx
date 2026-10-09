import { memo, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  MarkerType,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import { Check, ExternalLink, Gavel, LockKeyhole, Play, X } from 'lucide-react';
import type { Snapshot } from '../../shared/domain';
import { api, post } from '../api';
import { Badge, Empty, relative } from './UI';

type Common = { data: Snapshot; refresh: () => void; notify: (message: string) => void };
type State = 'idle' | 'active' | 'done' | 'skipped' | 'error';
type FlowData = {
  title: string;
  subtitle?: string;
  lines?: string[];
  state: State;
  locked?: boolean;
};

const phases = ['sandbox', 'opinion', 'documents', 'consultation', 'decision', 'triage', 'done'];

const FlowNode = memo(function FlowNode({ data }: NodeProps<Node<FlowData>>) {
  return (
    <div className={`council-node state-${data.state}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="council-node-title">
        {data.locked && <LockKeyhole size={12} />}
        {data.title}
      </div>
      {data.subtitle && <div className="council-node-sub">{data.subtitle}</div>}
      {data.lines?.map((l, i) => (
        <div className="council-node-line" key={i}>
          {l}
        </div>
      ))}
    </div>
  );
});
const nodeTypes = { flow: FlowNode };

function buildFlow(detail: any, config: any) {
  const s = detail?.session;
  const events: any[] = detail?.events ?? [];
  const decisions: any[] = detail?.decisions ?? [];
  const at = s ? phases.indexOf(s.phase) : -1;
  const finished = s && s.status !== 'running';
  const state = (phase: string): State => {
    if (!s) return 'idle';
    const i = phases.indexOf(phase);
    if (finished && s.status !== 'completed' && i >= at) return i === at ? 'error' : 'idle';
    return i < at || s.phase === 'done' ? 'done' : i === at ? 'active' : 'idle';
  };
  const ev = (room: string, kind: string) => events.find((e) => e.room === room && e.kind === kind);
  const seat = (key: 'openai' | 'google') => {
    const label = config?.seats.find((x: any) => x.seat === key);
    const op = ev(key, 'opinion'),
      rag = ev(key, 'rag'),
      cons = ev(key, 'consultation'),
      vote = ev(key, 'vote');
    const tok = events
      .filter((e) => e.room === key)
      .reduce((n, e) => n + e.input_tokens + e.output_tokens, 0);
    return {
      title: `${label?.label ?? key} sandbox`,
      subtitle: label?.model,
      locked: true,
      state: (!s
        ? 'idle'
        : vote
          ? 'done'
          : op
            ? 'active'
            : ev(key, 'sandbox_locked')
              ? 'active'
              : 'idle') as State,
      lines: [
        op
          ? `Opinion: ${op.content.risks.length} risks · ${(op.latency_ms / 1000).toFixed(1)} s`
          : 'Opinion: waiting',
        rag ? `RAG: ${rag.content.hits.length} chunks` : 'RAG: —',
        cons ? `Candidates: ${cons.content.candidates.length}` : 'Consultation: waiting',
        vote ? `Voted on ${vote.content.votes.length}` : 'Vote: waiting',
        `${tok.toLocaleString()} tokens`,
      ],
    };
  };
  const auto = decisions.filter((d) => d.status === 'auto_accepted').length;
  const review = decisions.filter((d) => d.status === 'pending_review').length;
  const ragSkipped = events.some((e) => e.kind === 'rag_skipped');
  const raw: { id: string; position: { x: number; y: number }; data: FlowData }[] = [
    {
      id: 'arch',
      position: { x: 0, y: 150 },
      data: {
        title: 'Architecture snapshot',
        subtitle: 'frozen, read-only',
        lines: [
          `${detail?.events?.[0]?.content?.snapshotRevision != null ? `revision ${detail.events[0].content.snapshotRevision}` : ''}`,
        ],
        state: state('sandbox'),
      },
    },
    { id: 'openai', position: { x: 250, y: 20 }, data: seat('openai') },
    { id: 'google', position: { x: 250, y: 260 }, data: seat('google') },
    {
      id: 'docs',
      position: { x: 520, y: 150 },
      data: {
        title: 'Documents (RAG)',
        subtitle: ragSkipped
          ? 'no documents: skipped'
          : s?.rag_mode
            ? `${s.rag_mode} · ${s.documents_used} docs`
            : 'Documents + Knowledge',
        lines: s ? [`${s.embedding_tokens} embedding tokens`] : [],
        state: ragSkipped ? 'skipped' : state('documents'),
      },
    },
    {
      id: 'channel',
      position: { x: 760, y: 150 },
      data: {
        title: 'Consultation channel',
        subtitle: 'the only link between rooms',
        lines: [
          `${events.filter((e) => e.room === 'shared' && e.kind === 'message').length} messages exchanged`,
        ],
        state: state('consultation'),
      },
    },
    {
      id: 'decide',
      position: { x: 1000, y: 150 },
      data: {
        title: 'Decision + vote',
        subtitle: 'chair merges ≤ 5, both vote',
        lines: decisions.length ? [`${decisions.length} decisions`] : [],
        state: state('decision'),
      },
    },
    {
      id: 'rule',
      position: { x: 1240, y: 150 },
      data: { title: '4-of-5 rule', subtitle: 'unanimous + ranked', state: state('triage') },
    },
    {
      id: 'auto',
      position: { x: 1470, y: 40 },
      data: {
        title: 'Accepted automatically',
        lines: [`${auto} decisions`],
        state: finished && decisions.length ? 'done' : 'idle',
      },
    },
    {
      id: 'review',
      position: { x: 1470, y: 260 },
      data: {
        title: 'Senior review',
        lines: [`${review} waiting`],
        state: review ? 'active' : finished && decisions.length ? 'done' : 'idle',
      },
    },
  ];
  const nodes: Node<FlowData>[] = raw.map((n) => ({ ...n, type: 'flow', draggable: false }));
  const link = (a: string, b: string, label?: string, active = false): Edge => ({
    id: `${a}-${b}`,
    source: a,
    target: b,
    label,
    animated: active,
    markerEnd: { type: MarkerType.ArrowClosed },
  });
  const running = s?.status === 'running';
  const edges = [
    link('arch', 'openai', 'snapshot', running && s.phase === 'opinion'),
    link('arch', 'google', 'snapshot', running && s.phase === 'opinion'),
    link('openai', 'docs', 'query', running && s.phase === 'documents'),
    link('google', 'docs', 'query', running && s.phase === 'documents'),
    link('docs', 'channel', 'evidence', running && s.phase === 'consultation'),
    link('channel', 'decide', 'candidates', running && s.phase === 'decision'),
    link('decide', 'rule', 'votes'),
    link('rule', 'auto', `${auto}`),
    link('rule', 'review', `${review}`),
  ];
  return { nodes, edges };
}

function Meter({
  label,
  value,
  max,
  unit,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="council-meter">
      <div>
        <span>{label}</span>
        <b>
          {Math.round(value).toLocaleString()} / {max.toLocaleString()} {unit}
        </b>
      </div>
      <div className="council-meter-track">
        <i style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : ''} />
      </div>
    </div>
  );
}

const statusTone: Record<string, string> = {
  running: 'info',
  completed: 'green',
  limit_reached: 'amber',
  failed: 'high',
  auto_accepted: 'green',
  pending_review: 'amber',
  approved: 'green',
  rejected: 'high',
};
const statusLabel: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  limit_reached: 'Limit reached',
  failed: 'Failed',
  auto_accepted: 'Accepted automatically',
  pending_review: 'Waiting for senior review',
  approved: 'Approved by senior',
  rejected: 'Rejected by senior',
};

export function CouncilPage({ data, notify }: Common) {
  const pid = data.project.id;
  const list = useQuery({
    queryKey: ['council', pid],
    queryFn: () => api(`/projects/${pid}/council`),
    refetchInterval: (q) =>
      q.state.data?.sessions?.some((s: any) => s.status === 'running') ? 1500 : false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [topic, setTopic] = useState('Review the whole architecture.');
  const sessionId = selected ?? list.data?.sessions?.[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['council', pid, sessionId],
    queryFn: () => api(`/projects/${pid}/council/${sessionId}`),
    enabled: !!sessionId,
    refetchInterval: (q) => (q.state.data?.session?.status === 'running' ? 1000 : false),
  });
  const [now, setNow] = useState(Date.now());
  const running = detail.data?.session?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (!running) void list.refetch();
  }, [running]);
  const config = list.data?.config;
  const flow = useMemo(() => buildFlow(detail.data, config), [detail.data, config]);
  const s = detail.data?.session;
  const elapsed = s
    ? ((s.finished_at ? new Date(s.finished_at).getTime() : now) -
        new Date(s.started_at).getTime()) /
      1000
    : 0;
  const senior = ['OWNER', 'ADMIN'].includes(data.project.role);
  const canStart = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'].includes(data.project.role);

  async function start() {
    try {
      const r = await post(`/projects/${pid}/council`, { topic });
      setSelected(r.id);
      await list.refetch();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function decide(id: string, decision: 'approved' | 'rejected') {
    try {
      await post(`/projects/${pid}/council/decisions/${id}`, { decision });
      await detail.refetch();
      await list.refetch();
      notify(decision === 'approved' ? 'Decision approved.' : 'Decision rejected.');
    } catch (e) {
      notify((e as Error).message);
    }
  }

  return (
    <div className="page-panel council">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT COUNCIL</span>
          <h1>Council</h1>
          <p>
            ChatGPT and Gemini review the architecture in separate locked sandboxes, consult, and
            decide within {config?.timeLimitSeconds ?? 400} s and{' '}
            {(config?.tokenLimit ?? 64000).toLocaleString()} tokens. Four of five decisions are
            accepted automatically; the rest wait for a senior review.
          </p>
        </div>
        {canStart && (
          <form
            className="council-start"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <input
              id="council-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={500}
            />
            <button className="btn primary" disabled={running}>
              <Play size={14} /> Start council
            </button>
          </form>
        )}
      </div>

      {!list.data?.sessions?.length ? (
        <Empty
          title="No council sessions yet"
          description="Start a session to let ChatGPT and Gemini review this architecture and decide together."
        />
      ) : (
        <>
          <div className="council-toolbar">
            <select
              id="council-session"
              value={sessionId ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {list.data.sessions.map((x: any) => (
                <option key={x.id} value={x.id}>
                  {relative(x.started_at)} · {statusLabel[x.status]} · {x.topic.slice(0, 60)}
                </option>
              ))}
            </select>
            {s && <Badge tone={statusTone[s.status]}>{statusLabel[s.status]}</Badge>}
            {s?.trace_url ? (
              <a className="btn small" href={s.trace_url} target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> Open in LangSmith
              </a>
            ) : config?.langsmith ? (
              <span className="help">LangSmith project: {config.langsmith.project}</span>
            ) : (
              <span className="help">LangSmith tracing is off</span>
            )}
          </div>
          {s && (
            <div className="council-meters">
              <Meter label="Time" value={elapsed} max={s.time_limit_seconds} unit="s" />
              <Meter label="LLM tokens" value={s.tokens_used} max={s.token_limit} unit="tokens" />
            </div>
          )}
          <div className="council-flow">
            <ReactFlowProvider>
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={nodeTypes}
                fitView
                nodesConnectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
          {s?.error && <p className="council-error">{s.error}</p>}

          <h2 className="council-h2">
            <Gavel size={15} /> Decisions
          </h2>
          {!detail.data?.decisions?.length && (
            <p className="help">
              {running ? 'The council is still deliberating.' : 'No decisions were produced.'}
            </p>
          )}
          {detail.data?.decisions?.map((d: any) => (
            <article className={`council-decision status-${d.status}`} key={d.id}>
              <div className="council-decision-head">
                <h3>{d.title}</h3>
                <Badge tone={d.risk.toLowerCase()}>{d.risk}</Badge>
                <Badge tone={statusTone[d.status]}>{statusLabel[d.status]}</Badge>
                <span className="help">score {Number(d.score).toFixed(2)}</span>
              </div>
              <p>{d.rationale}</p>
              <div className="council-votes">
                {d.votes.map((v: any) => (
                  <span key={v.seat} className={v.approve ? 'yes' : 'no'}>
                    {v.seat === 'openai' ? 'ChatGPT' : 'Gemini'}: {v.approve ? 'approve' : 'reject'}{' '}
                    · {Math.round(v.confidence * 100)}% — {v.comment}
                  </span>
                ))}
              </div>
              <p className="help">{d.triage_reason}</p>
              {d.status === 'pending_review' && senior && (
                <div className="council-actions">
                  <button
                    className="btn primary small"
                    onClick={() => void decide(d.id, 'approved')}
                  >
                    <Check size={13} /> Approve
                  </button>
                  <button className="btn small" onClick={() => void decide(d.id, 'rejected')}>
                    <X size={13} /> Reject
                  </button>
                </div>
              )}
              {d.status === 'pending_review' && !senior && (
                <p className="help">Only an owner or admin (senior developer) can decide this.</p>
              )}
              {d.reviewed_by_name && (
                <p className="help">
                  Reviewed by {d.reviewed_by_name} {relative(d.reviewed_at)}
                  {d.review_note ? `: ${d.review_note}` : ''}
                </p>
              )}
            </article>
          ))}

          <h2 className="council-h2">Timeline</h2>
          <ol className="council-timeline">
            {detail.data?.events?.map((e: any) => (
              <li key={e.id} className={`room-${e.room}`}>
                <span className="room">
                  {e.room === 'openai' ? 'ChatGPT' : e.room === 'google' ? 'Gemini' : e.room}
                </span>
                <b>{e.kind.replace(/_/g, ' ')}</b>
                {e.latency_ms > 0 && <span>{(e.latency_ms / 1000).toFixed(1)} s</span>}
                {e.input_tokens > 0 && (
                  <span>{(e.input_tokens + e.output_tokens).toLocaleString()} tokens</span>
                )}
                <span className="summary">
                  {e.content.summary ??
                    e.content.reply ??
                    e.content.query ??
                    (e.content.from
                      ? `${e.content.from} → ${e.content.to}: opinion delivered`
                      : null) ??
                    e.content.reason ??
                    e.content.error ??
                    ''}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
