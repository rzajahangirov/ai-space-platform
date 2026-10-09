import { memo, useEffect, useState, useCallback, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  useReactFlow,
  BackgroundVariant,
  type Node,
  type NodeProps,
  type OnNodesChange,
} from '@xyflow/react';
import { LockKeyhole, Plus, Scan, MousePointer2, Hand } from 'lucide-react';
import type { Component, Graph, Mutation, Presence, View } from '../../shared/domain';
import { ComponentIcon } from './UI';
type Data = { component: Component; issues: number; selectedBy: string[] };
const SystemNode = memo(function SystemNode({ data, selected }: NodeProps<Node<Data>>) {
  const n = data.component;
  return (
    <div
      className={`system-node ${selected ? 'selected' : ''} category-${n.category.toLowerCase()}`}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="node-top">
        <span className="node-icon">
          <ComponentIcon category={n.category} size={19} />
        </span>
        <span className="node-category">{n.category.toLowerCase()}</span>
        {data.issues > 0 && <span className="node-warning">{data.issues}</span>}
      </div>
      <strong>{n.name}</strong>
      <div className="node-tech">
        {n.technology}
        <span className="node-dot" />
      </div>
      {data.selectedBy.length > 0 && (
        <div className="node-presence">{data.selectedBy.join(', ')} selecting</div>
      )}
    </div>
  );
});
const nodeTypes = { system: SystemNode };
function CanvasInner({
  graph,
  view,
  selected,
  onSelect,
  onMutation,
  onAdd,
  editable,
  issues,
  presence,
  onPresence,
}: {
  graph: Graph;
  view: View | undefined;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMutation: (changes: Mutation[], summary: string) => Promise<void>;
  onAdd: (position?: { x: number; y: number }, technology?: string) => void;
  editable: boolean;
  issues: Record<string, number>;
  presence: Presence[];
  onPresence: (selected: string | null, cursor?: { x: number; y: number }) => void;
}) {
  const flow = useReactFlow();
  const [nodes, setNodes] = useState<Node<Data>[]>([]);
  const [pan, setPan] = useState(false);
  const lastCursor = useRef(0);
  const visible = graph.components.filter(
    (n) => !view?.categories.length || view.categories.includes(n.category),
  );
  const ids = new Set(visible.map((n) => n.id));
  useEffect(() => {
    setNodes((current) =>
      visible.map((n) => ({
        id: n.id,
        type: 'system',
        position: current.find((existing) => existing.id === n.id && existing.dragging)
          ?.position ?? { x: n.x, y: n.y },
        dragging: current.find((existing) => existing.id === n.id)?.dragging,
        selected: n.id === selected,
        data: {
          component: n,
          issues: issues[n.id] ?? 0,
          selectedBy: presence.filter((p) => p.selected === n.id).map((p) => p.name),
        },
      })),
    );
  }, [
    graph,
    view,
    selected,
    JSON.stringify(issues),
    JSON.stringify(presence.map((p) => ({ name: p.name, selected: p.selected }))),
  ]);
  const onNodesChange: OnNodesChange<Node<Data>> = useCallback(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const edges = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.protocol,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#69747e' },
      style: { stroke: '#64717c', strokeWidth: 1.4 },
      labelStyle: { fill: '#aab1bb', fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: '#181c21', fillOpacity: 1 },
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 4,
    }));
  return (
    <div
      className="canvas-wrap"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (editable)
          onAdd(
            flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
            e.dataTransfer.getData('application/agentspace'),
          );
      }}
    >
      <div className="canvas-caption">
        <span className="eyebrow">{view?.name ?? 'System overview'}</span>
        <span>
          {visible.length} components <i /> {edges.length} connections
        </span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => {
          onSelect(node.id);
          onPresence(node.id);
        }}
        onPaneClick={() => {
          onSelect(null);
          onPresence(null);
        }}
        onNodeDragStop={(_, node) => {
          const original = graph.components.find((n) => n.id === node.id);
          if (original && (original.x !== node.position.x || original.y !== node.position.y))
            void onMutation(
              [
                {
                  type: 'component.upsert',
                  component: {
                    ...original,
                    x: Math.round(node.position.x),
                    y: Math.round(node.position.y),
                  },
                },
              ],
              `Moved ${original.name}`,
            );
        }}
        onConnect={(connection) => {
          if (connection.source && connection.target)
            void onMutation(
              [
                {
                  type: 'edge.upsert',
                  edge: {
                    id: crypto.randomUUID(),
                    source: connection.source,
                    target: connection.target,
                    protocol: 'HTTPS',
                    metadata: {},
                  },
                },
              ],
              'Connected components',
            );
        }}
        onPaneMouseMove={(e) => {
          if (Date.now() - lastCursor.current > 100) {
            lastCursor.current = Date.now();
            onPresence(selected, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }
        }}
        onEdgeClick={(_, edge) => onSelect(`edge:${edge.id}`)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 0.9 }}
        minZoom={0.15}
        maxZoom={1.8}
        nodesDraggable={editable && !pan}
        nodesConnectable={editable}
        panOnDrag={pan ? [0, 1, 2] : [1, 2]}
        selectionOnDrag={!pan}
        deleteKeyCode={null}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#343b44" />
        <Controls showInteractive={false} />
        <MiniMap nodeColor="#626d77" maskColor="#12151ada" pannable zoomable />
      </ReactFlow>
      <div className="canvas-tools">
        <button
          className={!pan ? 'active' : ''}
          onClick={() => setPan(false)}
          title="Select components"
          aria-label="Select components"
        >
          <MousePointer2 size={17} />
        </button>
        <button
          className={pan ? 'active' : ''}
          onClick={() => setPan(true)}
          title="Pan canvas"
          aria-label="Pan canvas"
        >
          <Hand size={17} />
        </button>
        <span />
        <button
          onClick={() => flow.fitView({ padding: 0.2, duration: 300 })}
          title="Fit to screen"
          aria-label="Fit to screen"
        >
          <Scan size={17} />
        </button>
        {editable && (
          <>
            <span />
            <button
              onClick={() =>
                onAdd(
                  flow.screenToFlowPosition({
                    x: window.innerWidth / 2,
                    y: window.innerHeight / 2,
                  }),
                )
              }
              title="Add component"
              aria-label="Add component"
            >
              <Plus size={18} />
            </button>
          </>
        )}
      </div>
      <div className="canvas-hint">
        {editable ? 'Drag to arrange · Connect using node handles' : 'Read-only architecture'}
        <LockKeyhole size={11} /> Version checked
      </div>
    </div>
  );
}
export default function Canvas(props: Parameters<typeof CanvasInner>[0]) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
