import { useState, useEffect, useRef, useCallback, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  FileText,
  GitBranch,
  GitPullRequest,
  History,
  Layers,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Moon,
  Users,
  X,
  Upload,
  Download,
  Undo2,
  Redo2,
  Copy,
  Workflow,
  Radar,
  MessagesSquare,
  BookOpen,
  Gavel,
} from 'lucide-react';
import { api, post, patch, ApiError, liveUrl } from './api';
import {
  catalog,
  categories,
  graphSchema,
  health,
  type Component,
  type Mutation,
  type Notification,
  type Presence,
  type Project,
  type Snapshot,
} from '../shared/domain';
import Canvas from './components/Canvas';
import Inspector from './components/Inspector';
import { Logo, Modal, Badge, ComponentIcon, Empty, initials } from './components/UI';
import {
  AgentPanel,
  FindingsPanel,
  ProposalsPanel,
  HealthPanel,
  ActivityPanel,
  TasksPanel,
  VersionsPanel,
  KnowledgePanel,
} from './components/Panels';
import { DiscoveryImport, InboxPanel, ObservePanel } from './components/Observe';
import { ArtifactsPage, ConversationsPage, RoomDrawer } from './components/Conversations';
import { AcceptInvite, InviteModal } from './components/Invite';
import { CouncilPage } from './components/Council';

type User = { id: string; name: string; email: string };
const navigation = [
  ['Inbox', Bell],
  ['Conversations', MessagesSquare],
  ['Architecture', Workflow],
  ['Observe', Radar],
  ['Agents', Bot],
  ['Council', Gavel],
  ['Review tasks', Check],
  ['Artifacts', BookOpen],
  ['Knowledge', FileText],
  ['Findings', ShieldCheck],
  ['Proposals', GitPullRequest],
  ['Activity', Activity],
  ['History', History],
] as const;
export default function App() {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(localStorage.getItem('agentspace-project') ?? ''),
    [page, setPage] = useState('Architecture'),
    [viewId, setViewId] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [room, setRoom] = useState(false),
    [modal, setModal] = useState<string | null>(null),
    [toast, setToast] = useState(''),
    [presence, setPresence] = useState<Presence[]>([]),
    [connection, setConnection] = useState('connecting'),
    [search, setSearch] = useState(''),
    [theme, setTheme] = useState(localStorage.getItem('agentspace-theme') ?? 'dark'),
    [addPosition, setAddPosition] = useState({ x: 300, y: 250 }),
    [initialTechnology, setInitialTechnology] = useState(''),
    [undoStack, setUndoStack] = useState<Snapshot['graph'][]>([]),
    [redoStack, setRedoStack] = useState<Snapshot['graph'][]>([]),
    [conversationId, setConversationId] = useState<string | null>(null),
    [artifactId, setArtifactId] = useState<string | null>(null),
    [inviteConversation, setInviteConversation] = useState<{ id: string; title: string } | null>(
      null,
    );
  const ws = useRef<WebSocket | null>(null);
  // A conversation to open once a newly created project becomes active.
  const pendingConversation = useRef<string | null>(null);
  const localRevision = useRef<number | null>(null);
  const observedRevision = useRef<number | null>(null);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: User }>('/me'),
    retry: false,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: Project[] }>('/projects'),
    enabled: !!me.data,
  });
  const activeId = projects.data?.projects.some((p) => p.id === projectId)
    ? projectId
    : projects.data?.projects[0]?.id;
  const snapshot = useQuery({
    queryKey: ['snapshot', activeId],
    queryFn: () => api<Snapshot>(`/projects/${activeId}/snapshot`),
    enabled: !!activeId && !!me.data,
    refetchInterval: 15000,
  });
  const data = snapshot.data;
  const inbox = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notification[]; unread: number }>('/notifications'),
    enabled: !!me.data,
    refetchInterval: 30000,
  });
  useEffect(() => {
    if (!data) return;
    if (
      observedRevision.current !== data.project.revision &&
      localRevision.current !== data.project.revision
    ) {
      // A remote edit invalidates snapshot-based local undo: never erase a teammate's work.
      setUndoStack([]);
      setRedoStack([]);
    }
    observedRevision.current = data.project.revision;
  }, [data?.project.revision]);
  const notify = useCallback((message: string) => setToast(message), []);
  // Agents emit bursts of events; coalesce them into one refetch round.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshNow = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['snapshot', activeId] });
    void client.invalidateQueries({ queryKey: ['notifications'] });
    void client.invalidateQueries({ queryKey: ['observations', activeId] });
    void client.invalidateQueries({ queryKey: ['conversations', activeId] });
    void client.invalidateQueries({ queryKey: ['conversation', activeId] });
    void client.invalidateQueries({ queryKey: ['artifacts', activeId] });
    void client.invalidateQueries({ queryKey: ['artifact', activeId] });
  }, [activeId, client]);
  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refreshNow();
    }, 250);
  }, [refreshNow]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agentspace-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch('');
        setModal((m) => (m === 'command' ? null : 'command'));
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    setViewId('');
    setSelected(null);
    setConversationId(pendingConversation.current);
    if (pendingConversation.current) setPage('Conversations');
    pendingConversation.current = null;
    setArtifactId(null);
    setUndoStack([]);
    setRedoStack([]);
    localRevision.current = null;
    observedRevision.current = null;
    if (activeId) localStorage.setItem('agentspace-project', activeId);
  }, [activeId]);
  useEffect(() => {
    if (!activeId || !me.data) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function retry() {
      setConnection('reconnecting');
      setPresence([]);
      if (!stopped) timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
    }
    async function connect() {
      if (stopped) return;
      setConnection('connecting');
      let url: string;
      try {
        url = await liveUrl(activeId!);
      } catch {
        retry();
        return;
      }
      if (stopped) return;
      const socket = new WebSocket(url);
      ws.current = socket;
      socket.onopen = () => {
        attempts = 0;
        setConnection('live');
        refresh();
      };
      socket.onmessage = (event) => {
        try {
          const value = JSON.parse(event.data);
          if (value.type === 'invalidate') refresh();
          if (value.type === 'presence') setPresence(value.members);
        } catch {
          /* Ignore unsupported server event. */
        }
      };
      socket.onclose = retry;
      socket.onerror = () => socket.close();
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, [activeId, !!me.data, refresh]);
  const [inviteToken, setInviteToken] = useState(() =>
    location.pathname.startsWith('/invite/') ? location.pathname.split('/')[2] : null,
  );
  const sendPresence = (node: string | null, cursor?: { x: number; y: number }) => {
    if (ws.current?.readyState === WebSocket.OPEN)
      ws.current.send(JSON.stringify({ selected: node, cursor }));
  };
  async function mutate(changes: Mutation[], summary: string, recordHistory = true) {
    if (!data) return;
    try {
      localRevision.current = data.project.revision + 1;
      await post(`/projects/${data.project.id}/graph`, {
        revision: data.project.revision,
        changes,
        summary,
      });
      if (recordHistory) {
        setUndoStack((stack) => [...stack.slice(-19), data.graph]);
        setRedoStack([]);
      }
      await snapshot.refetch();
    } catch (e) {
      localRevision.current = null;
      refresh();
      notify((e as Error).message);
      throw e;
    }
  }
  // Canvas fire-and-forget mutations surface errors as notifications without unhandled rejections.
  const canvasMutation = async (changes: Mutation[], summary: string) => {
    try {
      await mutate(changes, summary);
    } catch {
      /* Notification already shown. */
    }
  };
  async function review(componentId?: string, prompt?: string) {
    if (!data) return;
    try {
      const result = await post<{ conversationId: string }>(
        `/projects/${data.project.id}/reviews`,
        {
          prompt:
            prompt ??
            (componentId
              ? 'Review this component and its immediate dependencies. Cite evidence and consult relevant peers.'
              : 'Review this architecture for security, reliability, and performance. Collaborate with relevant specialist agents.'),
          componentId,
        },
      );
      setConversationId(result.conversationId);
      setRoom(true);
      refresh();
      notify('Review started in its own conversation. Agents are working on it.');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const onAdd = (position?: { x: number; y: number }, technology?: string) => {
    const start = position ?? { x: 50, y: 0 };
    const available = { ...start };
    // Keep new cards reachable after graph sorting, restores, and another client's refetch.
    for (
      let attempts = 0;
      attempts < 100 &&
      data?.graph.components.some(
        (component) =>
          Math.abs(component.x - available.x) < 240 && Math.abs(component.y - available.y) < 145,
      );
      attempts++
    ) {
      available.x += 260;
      if (available.x > start.x + 780) {
        available.x = start.x;
        available.y += 170;
      }
    }
    setAddPosition(available);
    setInitialTechnology(technology ?? '');
    setModal('component');
  };
  if (me.isPending)
    return (
      <div className="loading-screen">
        <Logo />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!me.data)
    return (
      <AuthScreen
        onSignedIn={() => {
          void client.invalidateQueries({ queryKey: ['me'] });
        }}
        invite={!!inviteToken}
      />
    );
  if (inviteToken)
    return (
      <AcceptInvite
        token={inviteToken}
        email={me.data.user.email}
        onJoined={async (joinedProject, conversation) => {
          history.replaceState({}, '', '/');
          pendingConversation.current = conversation;
          await client.invalidateQueries({ queryKey: ['projects'] });
          setProjectId(joinedProject);
          setInviteToken(null);
          if (joinedProject === activeId) {
            // Already looking at this project: the switch effect will not run.
            if (conversation) {
              setConversationId(conversation);
              setPage('Conversations');
            }
            pendingConversation.current = null;
          }
          setToast('Welcome! You joined the project.');
        }}
        onDismiss={() => {
          history.replaceState({}, '', '/');
          setInviteToken(null);
        }}
      />
    );
  if (projects.isPending)
    return (
      <div className="loading-screen">
        <Logo />
        <p>Loading projects…</p>
      </div>
    );
  if (!activeId)
    return (
      <div className="auth-page">
        <div className="onboarding-card">
          <Logo />
          <span className="eyebrow">YOUR NEXT SYSTEM STARTS HERE</span>
          <h1>
            Make room for
            <br />
            better engineering.
          </h1>
          <p>
            Create a shared space for your architecture, your team, and your engineering agents.
          </p>
          <ProjectForm
            onCreated={async (id, conversation) => {
              pendingConversation.current = conversation ?? null;
              setProjectId(id);
              await projects.refetch();
            }}
          />
          <button
            className="text-btn"
            onClick={async () => {
              await post('/auth/logout', {});
              client.clear();
              location.reload();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="loading-screen">
        <Logo />
        <p>{snapshot.error?.message ?? 'Loading the system graph…'}</p>
        {snapshot.isError && (
          <button className="btn" onClick={() => snapshot.refetch()}>
            Try again
          </button>
        )}
      </div>
    );
  const editable = ['OWNER', 'ADMIN', 'EDITOR'].includes(data.project.role),
    manage = ['OWNER', 'ADMIN'].includes(data.project.role),
    view = data.views.find((v) => v.id === viewId) ?? data.views[0],
    healthResult = health(data.findings),
    pending = data.proposals.filter((p) => p.status === 'PENDING').length;
  const issues: Record<string, number> = {};
  for (const finding of data.findings)
    if (finding.status === 'OPEN' && finding.component_id)
      issues[finding.component_id] = (issues[finding.component_id] ?? 0) + 1;
  const common = { data, refresh, notify };
  const selectComponent = (id: string) => {
    setSelected(id);
    setPage('Architecture');
    setViewId(data.views.find((v) => v.name === 'System overview')?.id ?? '');
  };
  const commands = [
    { label: 'Add component', action: () => onAdd(), icon: Plus },
    { label: 'Run architecture review', action: () => void review(), icon: Sparkles },
    { label: 'Invite member', action: () => setModal('invite'), icon: Users },
    { label: 'Create project', action: () => setModal('project'), icon: Plus },
    { label: 'Create view', action: () => setModal('view'), icon: Layers },
    { label: 'Import existing system', action: () => setModal('import'), icon: Upload },
    { label: 'Detect architecture drift', action: () => setPage('Observe'), icon: Radar },
    { label: 'Open inbox', action: () => setPage('Inbox'), icon: Bell },
    {
      label: 'New conversation',
      action: () => {
        setConversationId(null);
        setPage('Conversations');
      },
      icon: MessagesSquare,
    },
    { label: 'Open artifacts', action: () => setPage('Artifacts'), icon: BookOpen },
    { label: 'Open agent library', action: () => setPage('Agents'), icon: Bot },
    { label: 'Open findings', action: () => setPage('Findings'), icon: ShieldCheck },
    { label: 'Open proposals', action: () => setPage('Proposals'), icon: GitPullRequest },
    ...data.graph.components.map((c) => ({
      label: `Component · ${c.name}`,
      action: () => selectComponent(c.id),
      icon: Box,
    })),
    ...data.agents.map((a) => ({
      label: `Agent · ${a.name}`,
      action: () => setPage('Agents'),
      icon: Bot,
    })),
    ...data.findings.map((f) => ({
      label: `Finding · ${f.title}`,
      action: () => setPage('Findings'),
      icon: ShieldCheck,
    })),
    ...data.proposals.map((p) => ({
      label: `Proposal · ${p.title}`,
      action: () => setPage('Proposals'),
      icon: GitPullRequest,
    })),
    ...data.messages
      .filter((m) => search.length > 2 && m.content.toLowerCase().includes(search.toLowerCase()))
      .map((m) => ({
        label: `Conversation · ${m.content.slice(0, 90)}`,
        action: () => setRoom(true),
        icon: MessageSquare,
      })),
  ].filter((c) => c.label.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="AgentSpace home">
          <Logo />
          <strong>AgentSpace</strong>
          <span>β</span>
        </a>
        <button className="workspace-switch" onClick={() => setModal('projects')}>
          <span className="workspace-avatar">{initials(data.project.workspace_name)}</span>
          <span>
            <strong>{data.project.workspace_name}</strong>
            <small>Engineering workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button
          className="search-trigger"
          onClick={() => {
            setSearch('');
            setModal('command');
          }}
        >
          <Search size={15} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">PROJECT</div>
        <button className="project-button" onClick={() => setModal('projects')}>
          <span className="project-icon">{data.project.name[0]?.toUpperCase()}</span>
          {data.project.name}
          <ChevronDown size={14} />
        </button>
        <nav>
          {navigation.map(([label, Icon]) => (
            <button
              key={label}
              className={page === label ? 'active' : ''}
              onClick={() => setPage(label)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {label === 'Findings' && healthResult.active > 0 && <b>{healthResult.active}</b>}
              {label === 'Proposals' && pending > 0 && <b className="accent-count">{pending}</b>}
              {label === 'Inbox' && !!inbox.data?.unread && (
                <b className="accent-count">{inbox.data.unread}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-team">
          <div className="nav-label">
            ENGINEERING AGENTS <span>{data.agents.filter((a) => a.enabled).length}</span>
          </div>
          {data.agents
            .filter((a) => a.enabled)
            .slice(0, 4)
            .map((a) => (
              <button key={a.id} onClick={() => setPage('Agents')}>
                <span className={`small-agent role-${a.role}`}>
                  <Bot size={14} />
                </span>
                <span>{a.name}</span>
                <i className={a.status !== 'idle' ? 'pulse-dot' : 'idle-dot'} />
              </button>
            ))}
          <button className="view-all" onClick={() => setPage('Agents')}>
            View all agents <ArrowUpRight size={12} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setModal('members')}>
            <Users size={16} />
            Members & access
          </button>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}Switch to{' '}
            {theme === 'dark' ? 'light' : 'dark'}
          </button>
          <div className="user-profile">
            <span className="avatar">{initials(me.data.user.name)}</span>
            <div>
              <strong>{me.data.user.name}</strong>
              <small>{data.project.role.toLowerCase()}</small>
            </div>
            <button
              className="icon-btn"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await post('/auth/logout', {});
                client.clear();
                location.reload();
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Projects</span>
            <ChevronRight size={13} />
            <strong>{data.project.name}</strong>
            <span className="divider" />
            <span className="environment">
              <i />
              {data.project.environment}
            </span>
          </div>
          <div className="topbar-actions">
            <span className={`connection-status ${connection === 'live' ? 'connected' : ''}`}>
              <i />
              {connection === 'live' ? 'Live' : 'Reconnecting'}
            </span>
            <div className="presence-avatars" title={presence.map((p) => p.name).join(', ')}>
              {presence.slice(0, 3).map((p) => (
                <span className="avatar" key={p.id}>
                  {initials(p.name)}
                </span>
              ))}
            </div>
            <button
              className="icon-btn inbox-bell"
              aria-label={`Inbox, ${inbox.data?.unread ?? 0} unread`}
              title="Inbox"
              onClick={() => setPage('Inbox')}
            >
              <Bell size={16} />
              {!!inbox.data?.unread && <b>{inbox.data.unread > 9 ? '9+' : inbox.data.unread}</b>}
            </button>
            <button className="btn small" onClick={() => setModal('members')}>
              <Users size={14} /> Share
            </button>
            {manage && (
              <button className="btn primary small" onClick={() => setModal('invite')}>
                <Plus size={14} /> Invite
              </button>
            )}
          </div>
        </header>
        <div className="workspace-title">
          <div>
            <span className="eyebrow">
              {page === 'Architecture' ? 'DESIGN SPACE' : 'PROJECT WORKSPACE'}
            </span>
            <h1>
              {page === 'Architecture' ? 'Production architecture' : page}
              <Badge>
                {page === 'Architecture'
                  ? `v${data.project.revision}`
                  : 'ShopSphere' === data.project.name
                    ? 'Reference project'
                    : 'Shared space'}
              </Badge>
            </h1>
          </div>
          <div className="title-actions">
            <button className="health-pill" onClick={() => setPage('Health')}>
              <Activity size={15} />
              <span>Architecture health</span>
              <b>{healthResult.score}</b>
            </button>
            <button className="btn" onClick={() => setRoom(!room)}>
              <MessageSquare size={15} /> Engineering room
            </button>
            {data.project.role !== 'VIEWER' && (
              <button
                className="btn primary"
                disabled={data.runs.some((r) => ['queued', 'running'].includes(r.status))}
                onClick={() => review()}
              >
                <Sparkles size={15} />
                {data.runs.some((r) => ['queued', 'running'].includes(r.status))
                  ? 'Review in progress'
                  : 'Run review'}
              </button>
            )}
          </div>
        </div>
        <div className="workspace-body">
          {page === 'Conversations' ? (
            <ConversationsPage
              data={data}
              notify={notify}
              conversationId={conversationId}
              onSelectConversation={setConversationId}
              onSelectComponent={selectComponent}
              onOpenArtifact={(id) => {
                setArtifactId(id);
                setPage('Artifacts');
              }}
              onInvite={
                manage
                  ? (conversation) => {
                      setInviteConversation(conversation);
                      setModal('invite');
                    }
                  : undefined
              }
            />
          ) : page === 'Architecture' ? (
            <>
              <aside className="views-sidebar">
                <div className="panel-label">
                  ARCHITECTURE VIEWS
                  {editable && (
                    <button
                      className="icon-btn"
                      aria-label="Create view"
                      onClick={() => setModal('view')}
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                <div className="views-list">
                  {data.views.map((v) => (
                    <button
                      key={v.id}
                      className={view?.id === v.id ? 'active' : ''}
                      onClick={() => setViewId(v.id)}
                    >
                      <Layers size={14} />
                      <span>{v.name}</span>
                      {view?.id === v.id && <span className="view-dot" />}
                    </button>
                  ))}
                </div>
                <div className="palette-header">
                  <span className="panel-label">COMPONENTS</span>
                  <span>{data.graph.components.length}</span>
                </div>
                <p className="palette-help">Drag a component onto the canvas</p>
                <div className="component-palette">
                  {(
                    [
                      'FRONTEND',
                      'BACKEND',
                      'DATABASE',
                      'INFRASTRUCTURE',
                      'MESSAGING',
                      'STORAGE',
                      'AUTH',
                      'AI',
                      'OBSERVABILITY',
                      'EXTERNAL',
                    ] as const
                  ).map((category) => (
                    <details
                      key={category}
                      open={['FRONTEND', 'BACKEND', 'DATABASE'].includes(category)}
                    >
                      <summary>
                        <ComponentIcon category={category} size={13} />
                        {category.toLowerCase()}
                        <ChevronRight size={12} />
                      </summary>
                      {catalog[category].slice(0, category === 'DATABASE' ? 4 : 3).map((t) => (
                        <button
                          key={t}
                          draggable={editable}
                          onDragStart={(e) => e.dataTransfer.setData('application/agentspace', t)}
                          onClick={() => editable && onAdd(undefined, t)}
                        >
                          <ComponentIcon category={category} size={13} />
                          {t}
                          <span>⠿</span>
                        </button>
                      ))}
                    </details>
                  ))}
                </div>
                <div className="view-footer">
                  <button className="text-btn" onClick={() => setModal('import')}>
                    <Upload size={13} /> Import architecture
                  </button>
                  <button
                    className="text-btn"
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(data.graph, null, 2)], {
                          type: 'application/json',
                        }),
                        url = URL.createObjectURL(blob),
                        a = document.createElement('a');
                      a.href = url;
                      a.download = `${data.project.name}-architecture.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download size={13} /> Export graph
                  </button>
                </div>
              </aside>
              <div className="canvas-column">
                <div className="canvas-toolbar">
                  <div>
                    <GitBranch size={14} />
                    <span>Canonical system graph</span>
                    <Badge>Design mode</Badge>
                  </div>
                  <div>
                    {editable && (
                      <>
                        <button
                          className="icon-btn"
                          aria-label="Undo architecture change"
                          title="Undo by restoring previous version"
                          disabled={!undoStack.length}
                          onClick={async () => {
                            const previous = undoStack.at(-1);
                            if (previous)
                              try {
                                await mutate(
                                  [{ type: 'graph.restore', graph: previous }],
                                  'Undo local architecture change',
                                  false,
                                );
                                setUndoStack((stack) => stack.slice(0, -1));
                                setRedoStack((stack) => [...stack, data.graph]);
                              } catch {}
                          }}
                        >
                          <Undo2 size={15} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label="Redo architecture change"
                          disabled={!redoStack.length}
                          onClick={async () => {
                            const next = redoStack.at(-1);
                            if (next)
                              try {
                                await mutate(
                                  [{ type: 'graph.restore', graph: next }],
                                  'Redo local architecture change',
                                  false,
                                );
                                setRedoStack((stack) => stack.slice(0, -1));
                                setUndoStack((stack) => [...stack, data.graph]);
                              } catch {}
                          }}
                        >
                          <Redo2 size={15} />
                        </button>
                        <span className="divider" />
                        <button className="text-btn" onClick={() => onAdd()}>
                          <Plus size={14} /> Component
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <Canvas
                  graph={data.graph}
                  view={view}
                  selected={selected}
                  onSelect={setSelected}
                  onMutation={canvasMutation}
                  onAdd={onAdd}
                  editable={editable}
                  issues={issues}
                  presence={presence.filter((p) => p.userId !== me.data.user.id)}
                  onPresence={sendPresence}
                />
                <div className="canvas-status">
                  <span>
                    <span className="green-dot" />
                    All changes saved <span className="status-separator">·</span> v
                    {data.project.revision}
                  </span>
                  <button onClick={() => setRoom(true)}>
                    <Bot size={14} />
                    {data.agents.filter((a) => a.status !== 'idle').length
                      ? `${data.agents.filter((a) => a.status !== 'idle').length} agents working`
                      : 'Your engineering team is ready'}
                    <ChevronRight size={12} />
                  </button>
                </div>
              </div>
              {selected && (
                <Inspector
                  key={selected}
                  selected={selected}
                  data={data}
                  editable={editable}
                  onClose={() => setSelected(null)}
                  onMutation={mutate}
                  onComment={async (id, content) => {
                    const result = await post<{ agentNotice: string | null }>(
                      `/projects/${activeId}/comments`,
                      { componentId: id, content },
                    );
                    if (result.agentNotice) notify(result.agentNotice);
                    refresh();
                  }}
                  onResolve={async (id, resolved) => {
                    await patch(`/projects/${activeId}/comments/${id}`, { resolved });
                    refresh();
                  }}
                  onReview={review}
                />
              )}
            </>
          ) : (
            <div className="page-scroll">
              {page === 'Agents' && <AgentPanel {...common} />}{' '}
              {page === 'Findings' && <FindingsPanel {...common} onSelect={selectComponent} />}{' '}
              {page === 'Proposals' && <ProposalsPanel {...common} />}{' '}
              {page === 'Health' && <HealthPanel data={data} />}{' '}
              {page === 'Activity' && <ActivityPanel data={data} />}{' '}
              {page === 'Review tasks' && <TasksPanel data={data} />}{' '}
              {page === 'History' && <VersionsPanel data={data} onMutation={canvasMutation} />}{' '}
              {page === 'Knowledge' && <KnowledgePanel {...common} />}{' '}
              {page === 'Council' && <CouncilPage {...common} />}{' '}
              {page === 'Artifacts' && (
                <ArtifactsPage
                  data={data}
                  notify={notify}
                  openId={artifactId}
                  onOpen={setArtifactId}
                />
              )}{' '}
              {page === 'Observe' && (
                <ObservePanel
                  data={data}
                  notify={notify}
                  onSelect={selectComponent}
                  onMutation={canvasMutation}
                  onReview={(prompt) => review(undefined, prompt)}
                />
              )}{' '}
              {page === 'Inbox' && (
                <InboxPanel
                  notifications={inbox.data?.notifications ?? []}
                  onReadAll={async () => {
                    await post('/notifications/read', {});
                    void inbox.refetch();
                  }}
                  onOpen={async (n) => {
                    if (!n.read_at)
                      void post('/notifications/read', { ids: [n.id] }).then(() => inbox.refetch());
                    if (n.project_id !== activeId) setProjectId(n.project_id);
                    if (n.component_id && n.project_id === activeId)
                      selectComponent(n.component_id);
                    else setPage(n.page ?? 'Architecture');
                  }}
                />
              )}
            </div>
          )}
          {room && page !== 'Conversations' && (
            <RoomDrawer
              data={data}
              notify={notify}
              conversationId={conversationId}
              onSelectConversation={setConversationId}
              onClose={() => setRoom(false)}
              onSelectComponent={selectComponent}
              onOpenArtifact={(id) => {
                setArtifactId(id);
                setPage('Artifacts');
              }}
              selectedComponent={selected && !selected.startsWith('edge:') ? selected : null}
            />
          )}
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            className="icon-btn"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {modal === 'component' && (
        <ComponentModal
          initialTechnology={initialTechnology}
          onClose={() => setModal(null)}
          onCreate={async (name, category, technology) => {
            await mutate(
              [
                {
                  type: 'component.upsert',
                  component: {
                    id: crypto.randomUUID(),
                    name,
                    category,
                    technology,
                    description: '',
                    x: addPosition.x,
                    y: addPosition.y,
                    config: { environment: data.project.environment },
                  },
                },
              ],
              `Added ${name}`,
            );
            setModal(null);
          }}
        />
      )}
      {modal === 'invite' && (
        <InviteModal
          projectId={data.project.id}
          conversation={inviteConversation}
          onClose={() => {
            setModal(null);
            setInviteConversation(null);
          }}
        />
      )}
      {modal === 'view' && (
        <ViewModal
          onClose={() => setModal(null)}
          onCreate={async (name, categories) => {
            const result = await post(`/projects/${activeId}/views`, { name, categories });
            refresh();
            setViewId(result.id);
            setModal(null);
          }}
        />
      )}
      {modal === 'project' && (
        <Modal title="Create a project" onClose={() => setModal(null)}>
          <ProjectForm
            onCreated={async (id, conversation) => {
              pendingConversation.current = conversation ?? null;
              await projects.refetch();
              setProjectId(id);
              setModal(null);
            }}
          />
        </Modal>
      )}
      {modal === 'projects' && (
        <Modal title="Your projects" onClose={() => setModal(null)}>
          <div className="project-list">
            {projects.data?.projects.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setProjectId(p.id);
                  setModal(null);
                }}
              >
                <span className="project-icon">{p.name[0]}</span>
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.workspace_name}</small>
                </span>
                <Badge>{p.role.toLowerCase()}</Badge>
              </button>
            ))}
          </div>
          <button className="btn full" onClick={() => setModal('project')}>
            <Plus size={15} /> Create project
          </button>
        </Modal>
      )}
      {modal === 'members' && (
        <Modal title="Project members & access" onClose={() => setModal(null)}>
          <p className="help">
            Only project members can read this architecture. Sharing the URL does not grant access.
          </p>
          {data.members.map((member) => (
            <div className="member-row" key={member.id}>
              <span className="avatar">{initials(member.name)}</span>
              <div>
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </div>
              {manage && member.role !== 'OWNER' ? (
                <select
                  aria-label={`Role for ${member.name}`}
                  value={member.role}
                  onChange={async (e) => {
                    try {
                      await patch(`/projects/${activeId}/members/${member.id}`, {
                        role: e.target.value,
                      });
                      refresh();
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  {['ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              ) : (
                <Badge>{member.role.toLowerCase()}</Badge>
              )}
            </div>
          ))}
          {manage && (
            <button className="btn primary full" onClick={() => setModal('invite')}>
              <Plus size={15} /> Invite collaborator
            </button>
          )}
        </Modal>
      )}
      {modal === 'import' && (
        <ImportModal
          onClose={() => setModal(null)}
          editable={editable}
          onImport={async (graph) => {
            await mutate([{ type: 'graph.restore', graph }], 'Imported reviewed architecture');
            setModal(null);
          }}
          discovery={
            <DiscoveryImport
              projectId={data.project.id}
              graph={data.graph}
              environment={data.project.environment}
              editable={editable}
              onMerge={async (changes, summary) => {
                await mutate(changes, summary);
                setModal(null);
                notify('Discovered components merged. Agents will review the change.');
              }}
            />
          }
        />
      )}
      {modal === 'command' && (
        <Modal title="Command palette" onClose={() => setModal(null)}>
          <div className="command-input">
            <Search size={18} />
            <input
              autoFocus
              placeholder="Search components, findings, agents, actions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>ESC</kbd>
          </div>
          <div className="command-results">
            {commands.slice(0, 30).map((command, i) => (
              <button
                key={i}
                onClick={() => {
                  setModal(null);
                  command.action();
                }}
              >
                <command.icon size={16} />
                {command.label}
                <ArrowRight size={14} />
              </button>
            ))}
            {!commands.length && <p className="help">No matching actions or project entities.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
function AuthScreen({ onSignedIn, invite }: { onSignedIn: () => void; invite: boolean }) {
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api('/auth/config') });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/auth/${register ? 'register' : 'login'}`, {
        email,
        password,
        ...(register ? { name } : {}),
      });
      onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <div className="brand">
          <Logo />
          <strong>AgentSpace</strong>
        </div>
        <div>
          <span className="eyebrow">HUMANS + AI. ONE SHARED SYSTEM.</span>
          <h1>
            Great systems
            <br />
            are built
            <br />
            <em>together.</em>
          </h1>
          <p>
            Your architecture, your engineering team,
            <br />
            and your AI agents. In the same space.
          </p>
          <div className="auth-diagram">
            <span>
              <Layers size={18} />
              Architecture
            </span>
            <i />
            <span>
              <Users size={18} />
              Your team
            </span>
            <i />
            <span>
              <Bot size={18} />
              AI engineers
            </span>
          </div>
        </div>
        <small>A shared operating space for software engineering.</small>
      </div>
      <div className="auth-card">
        <span className="eyebrow">WELCOME TO YOUR WORKSPACE</span>
        <h2>{register ? 'Create your account' : 'Good to have you here.'}</h2>
        <p>
          {invite
            ? 'Sign in or create an account to accept your project invitation.'
            : register
              ? 'Start building a shared understanding of your system.'
              : 'Sign in to continue engineering together.'}
        </p>
        <form className="form-stack" onSubmit={submit}>
          {register && (
            <label>
              Your name
              <input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
            </label>
          )}
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              placeholder="At least 12 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              maxLength={200}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary full" disabled={busy}>
            {busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}
            <ArrowRight size={16} />
          </button>
        </form>
        {config.data?.oidc && (
          <a className="btn full" href="/api/auth/oidc/start">
            Continue with organization SSO
          </a>
        )}
        <p className="auth-toggle">
          {register ? 'Already have an account?' : 'New to AgentSpace?'}{' '}
          <button
            className="text-btn"
            onClick={() => {
              setRegister(!register);
              setError('');
            }}
          >
            {register ? 'Sign in' : 'Create account'}
          </button>
        </p>
        <div className="local-demo-note">
          <Box size={17} />
          <div>
            <strong>Exploring locally?</strong>
            <p>
              Seed ShopSphere with <code>npm run db:seed</code>, then use the demo credentials in
              the README.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
function ProjectForm({
  onCreated,
}: {
  onCreated: (id: string, conversationId?: string) => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [workspaceName, setWorkspaceName] = useState(''),
    [brief, setBrief] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const result = await post('/projects', { name, workspaceName });
          let conversation: string | undefined;
          if (brief.trim()) {
            // The architect starts designing immediately; the team reviews the proposal.
            const created = await post<{ id: string }>(`/projects/${result.id}/conversations`, {
              title: `Design: ${name}`,
              content: `@SystemArchitect Design the initial architecture for this system and propose it as one change. Ask the security and database specialists only if something critical needs their input.\n\n${brief.trim()}`,
            });
            conversation = created.id;
          }
          await onCreated(result.id, conversation);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Workspace name
        <input
          required
          placeholder="Acme Engineering"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
        />
      </label>
      <label>
        Project name
        <input
          required
          placeholder="Your next great system"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        What are you building? <small>(optional)</small>
        <textarea
          rows={4}
          placeholder="e.g. A food delivery app: customers, restaurants, couriers, live tracking, Stripe payments…"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
      </label>
      <p className="help">
        Eight engineering agents join the project. If you describe the system, the System Architect
        drafts an initial architecture for you to review.
      </p>
      {error && <p className="form-error">{error}</p>}
      <button className="btn primary" disabled={busy}>
        Create engineering space <ArrowRight size={15} />
      </button>
    </form>
  );
}
function ComponentModal({
  initialTechnology,
  onClose,
  onCreate,
}: {
  initialTechnology: string;
  onClose: () => void;
  onCreate: (name: string, category: Component['category'], technology: string) => Promise<void>;
}) {
  const initialCategory = (Object.entries(catalog).find(([, v]) =>
    v.includes(initialTechnology),
  )?.[0] ?? 'BACKEND') as Component['category'];
  const [category, setCategory] = useState(initialCategory),
    [technology, setTechnology] = useState(initialTechnology || catalog[initialCategory][0]),
    [name, setName] = useState(''),
    [error, setError] = useState('');
  return (
    <Modal title="Add a system component" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onCreate(name || technology, category, technology);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          Category
          <select
            value={category}
            onChange={(e) => {
              const category = e.target.value as Component['category'];
              setCategory(category);
              setTechnology(catalog[category][0]);
            }}
          >
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Technology
          {category === 'CUSTOM' ? (
            <input required value={technology} onChange={(e) => setTechnology(e.target.value)} />
          ) : (
            <select value={technology} onChange={(e) => setTechnology(e.target.value)}>
              {catalog[category].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          )}
        </label>
        <label>
          Component name
          <input
            placeholder={technology}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary">
          Add to architecture <Plus size={15} />
        </button>
      </form>
    </Modal>
  );
}
function ViewModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, categories: string[]) => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState('');
  return (
    <Modal title="Create an architecture view" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onCreate(name, selected);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          View name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="help">
          Choose categories to project from the canonical graph. No selection shows every component.
        </p>
        <div className="category-checks">
          {categories.map((c) => (
            <label className="checkbox-label" key={c}>
              <input
                type="checkbox"
                checked={selected.includes(c)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, c] : selected.filter((s) => s !== c))
                }
              />
              {c.toLowerCase()}
            </label>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary">Create view</button>
      </form>
    </Modal>
  );
}
function ImportModal({
  onClose,
  onImport,
  editable,
  discovery,
}: {
  onClose: () => void;
  onImport: (graph: Snapshot['graph']) => Promise<void>;
  editable: boolean;
  discovery: ReactNode;
}) {
  const [value, setValue] = useState(''),
    [mode, setMode] = useState<'discover' | 'json'>('discover'),
    [preview, setPreview] = useState<Snapshot['graph'] | null>(null),
    [error, setError] = useState('');
  return (
    <Modal title="Import existing system" onClose={onClose}>
      <div className="segmented" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'discover'}
          className={mode === 'discover' ? 'active' : ''}
          onClick={() => setMode('discover')}
        >
          Discover from files
        </button>
        <button
          role="tab"
          aria-selected={mode === 'json'}
          className={mode === 'json' ? 'active' : ''}
          onClick={() => setMode('json')}
        >
          AgentSpace JSON
        </button>
      </div>
      {mode === 'discover' ? (
        discovery
      ) : (
        <>
          <p className="help">
            Import an AgentSpace graph export. Review the component and connection counts before
            replacing the current architecture.
          </p>
          <textarea
            className="code-input full"
            rows={12}
            placeholder={'{"components": [], "edges": []}'}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setPreview(null);
            }}
          />
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Choose architecture JSON"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                if (file.size > 400000) {
                  setError('The import must be smaller than 400 KB.');
                  return;
                }
                setValue(await file.text());
                setPreview(null);
              }
            }}
          />
          {error && <p className="form-error">{error}</p>}
          {preview ? (
            <div className="notice">
              <span>
                {preview.components.length} components · {preview.edges.length} connections. This
                will replace the current graph and save a new version.
              </span>
            </div>
          ) : null}
          <button
            className="btn primary full"
            disabled={!editable}
            onClick={async () => {
              try {
                if (preview) await onImport(preview);
                else setPreview(graphSchema.parse(JSON.parse(value)));
                setError('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {preview ? 'Confirm replacement' : 'Validate & preview'}
          </button>
        </>
      )}
    </Modal>
  );
}
