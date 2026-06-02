import { useMemo, useCallback, useState } from "react";
import ReactFlow, {
  Background, Controls, MiniMap, Handle, Position,
  type Node, type Edge, type NodeProps, type EdgeProps,
  MarkerType, BaseEdge, EdgeLabelRenderer, getBezierPath,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import {
  Server, Box, Database, Globe, Lock, Cloud, Cpu,
  Layers, KeyRound, Clock, ArrowRightLeft, AlertTriangle, Info,
  Network, Shield, HardDrive, Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ============================================================================
// Topology data model — must stay in sync with ops_topologies.topology JSON.
// ============================================================================

export type NodeKind =
  | "server" | "container" | "service" | "database" | "cache" | "queue"
  | "reverse_proxy" | "load_balancer" | "cdn" | "object_storage"
  | "external" | "dns" | "secret_store" | "scheduler" | "network";

export type EdgeKind =
  | "http" | "https" | "tcp" | "ssh" | "env" | "webhook"
  | "volume_mount" | "depends_on" | "network_link";

export interface TopologyNode {
  id: string;
  kind: NodeKind;
  label: string;
  group?: string;
  ports?: string[];
  env?: string[];
  image?: string;
  command?: string;
  healthcheck?: string;
  volumes?: string[];
  meta?: Record<string, unknown>;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  port?: string;
  protocol?: string;
  encrypted?: boolean;
  meta?: Record<string, unknown>;
}

export interface TopologyGroup {
  id: string;
  label: string;
  kind: "server" | "cluster" | "cloud" | "local";
  contains: string[];
}

export interface TopologyNote {
  node_id?: string;
  edge_id?: string;
  text: string;
  severity?: "info" | "warn" | "critical";
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  groups?: TopologyGroup[];
  notes?: TopologyNote[];
}

// ============================================================================
// Per-kind visual styles — colors, icons, default port.
// ============================================================================

const KIND_STYLES: Record<NodeKind, { icon: any; color: string; bg: string; ring: string }> = {
  server:         { icon: Server,    color: "text-slate-200",   bg: "bg-slate-800",    ring: "ring-slate-500/50" },
  container:      { icon: Box,       color: "text-blue-100",    bg: "bg-blue-900/70",  ring: "ring-blue-500/50" },
  service:        { icon: Workflow,  color: "text-violet-100",  bg: "bg-violet-900/70", ring: "ring-violet-500/50" },
  database:       { icon: Database,  color: "text-amber-100",   bg: "bg-amber-900/70", ring: "ring-amber-500/50" },
  cache:          { icon: Cpu,       color: "text-rose-100",    bg: "bg-rose-900/70",  ring: "ring-rose-500/50" },
  queue:          { icon: Layers,    color: "text-pink-100",    bg: "bg-pink-900/70",  ring: "ring-pink-500/50" },
  reverse_proxy:  { icon: ArrowRightLeft, color: "text-emerald-100", bg: "bg-emerald-900/70", ring: "ring-emerald-500/50" },
  load_balancer:  { icon: Network,   color: "text-emerald-100", bg: "bg-emerald-900/70", ring: "ring-emerald-500/50" },
  cdn:            { icon: Cloud,     color: "text-sky-100",     bg: "bg-sky-900/70",   ring: "ring-sky-500/50" },
  object_storage: { icon: HardDrive, color: "text-yellow-100",  bg: "bg-yellow-900/70", ring: "ring-yellow-500/50" },
  external:       { icon: Globe,     color: "text-zinc-100",    bg: "bg-zinc-800",     ring: "ring-zinc-500/50" },
  dns:            { icon: Globe,     color: "text-cyan-100",    bg: "bg-cyan-900/70",  ring: "ring-cyan-500/50" },
  secret_store:   { icon: KeyRound,  color: "text-fuchsia-100", bg: "bg-fuchsia-900/70", ring: "ring-fuchsia-500/50" },
  scheduler:      { icon: Clock,     color: "text-indigo-100",  bg: "bg-indigo-900/70", ring: "ring-indigo-500/50" },
  network:        { icon: Network,   color: "text-teal-100",    bg: "bg-teal-900/70",  ring: "ring-teal-500/50" },
};

const EDGE_STYLES: Record<EdgeKind, { color: string; strokeDasharray?: string; animated?: boolean }> = {
  http:          { color: "#3b82f6" },
  https:         { color: "#10b981", animated: true },
  tcp:           { color: "#8b5cf6" },
  ssh:           { color: "#f59e0b", strokeDasharray: "4 2" },
  env:           { color: "#a3a3a3", strokeDasharray: "2 2" },
  webhook:       { color: "#ec4899", animated: true },
  volume_mount:  { color: "#facc15", strokeDasharray: "6 3" },
  depends_on:    { color: "#6b7280", strokeDasharray: "1 3" },
  network_link:  { color: "#06b6d4" },
};

// ============================================================================
// Custom node component
// ============================================================================

interface NodeData extends TopologyNode {
  isSelected?: boolean;
  isHighlighted?: boolean;
}

function ArchNode({ data }: NodeProps<NodeData>) {
  const s = KIND_STYLES[data.kind] ?? KIND_STYLES.service;
  const Icon = s.icon;
  const dimmed = data.isHighlighted === false;
  return (
    <div
      className={cn(
        "relative rounded-lg border border-white/10 px-3 py-2 text-xs shadow-md transition-opacity",
        s.bg, s.color,
        data.isSelected && `ring-2 ${s.ring}`,
        dimmed && "opacity-30",
      )}
      style={{ minWidth: 160 }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-white/40 !bg-white/40" />
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0">
          <div className="truncate font-semibold leading-tight">{data.label}</div>
          <div className="text-[10px] uppercase tracking-wider opacity-70">{data.kind.replace(/_/g, " ")}</div>
        </div>
      </div>
      {data.ports && data.ports.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {data.ports.slice(0, 4).map((p) => (
            <span key={p} className="rounded bg-black/30 px-1 py-0.5 font-mono text-[9px]">:{p}</span>
          ))}
          {data.ports.length > 4 && <span className="text-[9px] opacity-60">+{data.ports.length - 4}</span>}
        </div>
      )}
      {data.image && (
        <div className="mt-1 truncate font-mono text-[9px] opacity-60">{data.image}</div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-white/40 !bg-white/40" />
    </div>
  );
}

// ============================================================================
// Group / cluster node — visually contains other nodes.
// React Flow handles parent/child via parentNode + extent: "parent".
// ============================================================================

interface GroupData {
  label: string;
  kind: string;
}

function GroupNode({ data }: NodeProps<GroupData>) {
  return (
    <div className="relative h-full w-full rounded-xl border border-dashed border-white/20 bg-white/[0.02] p-3">
      <div className="absolute left-3 top-2 flex items-center gap-1 rounded bg-background/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
        {data.kind === "server" ? <Server className="h-3 w-3" /> : <Cloud className="h-3 w-3" />}
        {data.label}
      </div>
    </div>
  );
}

// ============================================================================
// Custom edge with label + per-kind styling.
// ============================================================================

interface EdgeData {
  kind: EdgeKind;
  label?: string;
  port?: string;
  encrypted?: boolean;
  isHighlighted?: boolean;
}

function ArchEdge(props: EdgeProps<EdgeData>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const s = EDGE_STYLES[data?.kind ?? "tcp"];
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  const dimmed = data?.isHighlighted === false;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: s.color,
          strokeWidth: 1.5,
          strokeDasharray: s.strokeDasharray,
          opacity: dimmed ? 0.15 : 1,
        }}
      />
      {(data?.label || data?.port) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className={cn(
              "rounded bg-background/90 px-1.5 py-0.5 font-mono text-[9px] text-foreground shadow-sm backdrop-blur",
              dimmed && "opacity-30",
            )}
          >
            {data.label}
            {data.port && <span className="ml-1 opacity-70">:{data.port}</span>}
            {data.encrypted && <Lock className="ml-1 inline h-2.5 w-2.5" />}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ============================================================================
// Layout — dagre auto-layout. Returns positioned nodes ready for React Flow.
// ============================================================================

function layoutNodes(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
  groups: TopologyGroup[] | undefined,
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 120, edgesep: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  // Only lay out leaf nodes — groups are rendered as containers after.
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    g.setNode(n.id, { width: 200, height: 80 });
  }
  for (const e of edges) {
    if (nodeMap.has(e.source) && nodeMap.has(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }

  dagre.layout(g);

  // Compute group bounding boxes from contained nodes' positions.
  const out: Node[] = [];
  const groupBounds = new Map<string, { x: number; y: number; w: number; h: number }>();

  if (groups) {
    for (const grp of groups) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const childId of grp.contains) {
        const p = g.node(childId);
        if (!p) continue;
        minX = Math.min(minX, p.x - p.width / 2);
        minY = Math.min(minY, p.y - p.height / 2);
        maxX = Math.max(maxX, p.x + p.width / 2);
        maxY = Math.max(maxY, p.y + p.height / 2);
      }
      if (minX !== Infinity) {
        const padding = 36;
        const x = minX - padding;
        const y = minY - padding - 16; // extra top room for label
        const w = (maxX - minX) + padding * 2;
        const h = (maxY - minY) + padding * 2 + 16;
        groupBounds.set(grp.id, { x, y, w, h });
        out.push({
          id: `group_${grp.id}`,
          type: "group",
          position: { x, y },
          data: { label: grp.label, kind: grp.kind } as GroupData,
          style: { width: w, height: h, zIndex: 0 } as any,
          selectable: false,
          draggable: false,
        });
      }
    }
  }

  for (const n of nodes) {
    const p = g.node(n.id);
    if (!p) continue;
    // Find which group this node belongs to.
    const grp = groups?.find((g) => g.contains.includes(n.id));
    const gb = grp ? groupBounds.get(grp.id) : null;
    out.push({
      id: n.id,
      type: "arch",
      // If in a group, position is relative to the group's top-left.
      position: gb
        ? { x: p.x - p.width / 2 - gb.x, y: p.y - p.height / 2 - gb.y }
        : { x: p.x - p.width / 2, y: p.y - p.height / 2 },
      parentNode: grp ? `group_${grp.id}` : undefined,
      extent: grp ? "parent" : undefined,
      data: n as NodeData,
    });
  }
  return out;
}

function topologyToEdges(edges: TopologyEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "arch",
    data: {
      kind: e.kind,
      label: e.label,
      port: e.port,
      encrypted: e.encrypted,
    } as EdgeData,
    animated: EDGE_STYLES[e.kind]?.animated,
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_STYLES[e.kind]?.color ?? "#94a3b8" },
  }));
}

// ============================================================================
// Main view — orchestrates nodes / edges / inspector / legend.
// ============================================================================

interface ArchitectureViewProps {
  topology: Topology;
  summary?: string | null;
  className?: string;
}

const nodeTypes = { arch: ArchNode, group: GroupNode };
const edgeTypes = { arch: ArchEdge };

export function ArchitectureView({ topology, summary, className }: ArchitectureViewProps) {
  return (
    <ReactFlowProvider>
      <InnerView topology={topology} summary={summary} className={className} />
    </ReactFlowProvider>
  );
}

function InnerView({ topology, summary, className }: ArchitectureViewProps) {
  const baseNodes = useMemo(
    () => layoutNodes(topology.nodes, topology.edges, topology.groups),
    [topology.nodes, topology.edges, topology.groups],
  );
  const baseEdges = useMemo(() => topologyToEdges(topology.edges), [topology.edges]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Highlight set: when a node is selected, dim everything not connected to it.
  const highlightSet = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const e of topology.edges) {
      if (e.source === selectedId) ids.add(e.target);
      if (e.target === selectedId) ids.add(e.source);
    }
    return ids;
  }, [selectedId, topology.edges]);

  const nodes = useMemo(() => baseNodes.map((n) => {
    if (n.type === "group") return n;
    return {
      ...n,
      data: {
        ...n.data,
        isSelected: n.id === selectedId,
        isHighlighted: highlightSet ? highlightSet.has(n.id) : undefined,
      } as NodeData,
    };
  }), [baseNodes, selectedId, highlightSet]);

  const edges = useMemo(() => baseEdges.map((e) => ({
    ...e,
    data: {
      ...(e.data as EdgeData),
      isHighlighted: highlightSet
        ? (highlightSet.has(e.source) && highlightSet.has(e.target))
        : undefined,
    } as EdgeData,
  })), [baseEdges, highlightSet]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    if (node.type === "group") return;
    setSelectedId((prev) => prev === node.id ? null : node.id);
  }, []);

  const onPaneClick = useCallback(() => setSelectedId(null), []);

  const selectedNode = selectedId ? topology.nodes.find((n) => n.id === selectedId) : null;
  const selectedNotes = useMemo(
    () => selectedId ? (topology.notes ?? []).filter((n) => n.node_id === selectedId) : [],
    [selectedId, topology.notes],
  );

  return (
    <div className={cn("relative flex h-full w-full overflow-hidden bg-slate-950", className)}>
      <div className="min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={1.5}
        >
          <Background gap={20} size={1} color="rgba(255,255,255,0.05)" />
          <Controls
            showInteractive={false}
            className="!border-white/10 !bg-slate-900/80 [&>button]:!border-white/10 [&>button]:!bg-slate-900 [&>button]:!text-white"
          />
          <MiniMap
            pannable zoomable
            className="!border-white/10 !bg-slate-900"
            nodeStrokeColor="rgba(255,255,255,0.4)"
            nodeColor={(n) => {
              if (n.type === "group") return "transparent";
              const kind = (n.data as NodeData)?.kind;
              return kind ? KIND_STYLES[kind]?.color.replace("text-", "#") ?? "#444" : "#444";
            }}
          />
        </ReactFlow>

        <Legend />
      </div>

      {selectedNode && (
        <Inspector
          node={selectedNode}
          notes={selectedNotes}
          incoming={topology.edges.filter((e) => e.target === selectedNode.id)}
          outgoing={topology.edges.filter((e) => e.source === selectedNode.id)}
          allNodes={topology.nodes}
          onClose={() => setSelectedId(null)}
        />
      )}

      {summary && !selectedNode && (
        <SummaryCard summary={summary} notes={topology.notes ?? []} />
      )}
    </div>
  );
}

// ============================================================================
// Right-side inspector panel — details for the selected node.
// ============================================================================

function Inspector({
  node,
  notes,
  incoming,
  outgoing,
  allNodes,
  onClose,
}: {
  node: TopologyNode;
  notes: TopologyNote[];
  incoming: TopologyEdge[];
  outgoing: TopologyEdge[];
  allNodes: TopologyNode[];
  onClose: () => void;
}) {
  const s = KIND_STYLES[node.kind] ?? KIND_STYLES.service;
  const Icon = s.icon;
  const labelOf = (id: string) => allNodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-white/10 bg-slate-900/95 text-slate-100">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("h-4 w-4", s.color.replace("100", "300"))} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{node.label}</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">{node.kind.replace(/_/g, " ")}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">✕</button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {node.image && <Field label="Image" value={<code className="font-mono text-[11px]">{node.image}</code>} />}
        {node.command && <Field label="Command" value={<code className="font-mono text-[10px]">{node.command}</code>} />}
        {node.healthcheck && <Field label="Healthcheck" value={<code className="font-mono text-[10px]">{node.healthcheck}</code>} />}

        {node.ports && node.ports.length > 0 && (
          <Field label="Ports" value={
            <div className="flex flex-wrap gap-1">
              {node.ports.map((p) => <span key={p} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px]">{p}</span>)}
            </div>
          } />
        )}

        {node.env && node.env.length > 0 && (
          <Field label={`Env vars (${node.env.length})`} value={
            <div className="space-y-0.5">
              {node.env.map((e) => <div key={e} className="font-mono text-[10px] text-slate-400">{e}</div>)}
            </div>
          } />
        )}

        {node.volumes && node.volumes.length > 0 && (
          <Field label="Volumes" value={
            <div className="space-y-0.5">
              {node.volumes.map((v) => <div key={v} className="font-mono text-[10px] text-slate-400">{v}</div>)}
            </div>
          } />
        )}

        {incoming.length > 0 && (
          <Field label={`Incoming (${incoming.length})`} value={
            <div className="space-y-1">
              {incoming.map((e) => (
                <ConnRow key={e.id} edge={e} otherLabel={labelOf(e.source)} direction="in" />
              ))}
            </div>
          } />
        )}

        {outgoing.length > 0 && (
          <Field label={`Outgoing (${outgoing.length})`} value={
            <div className="space-y-1">
              {outgoing.map((e) => (
                <ConnRow key={e.id} edge={e} otherLabel={labelOf(e.target)} direction="out" />
              ))}
            </div>
          } />
        )}

        {notes.length > 0 && (
          <Field label="Notes" value={
            <div className="space-y-1">
              {notes.map((n, i) => <NoteRow key={i} note={n} />)}
            </div>
          } />
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function ConnRow({ edge, otherLabel, direction }: { edge: TopologyEdge; otherLabel: string; direction: "in" | "out" }) {
  const color = EDGE_STYLES[edge.kind]?.color ?? "#94a3b8";
  return (
    <div className="flex items-center gap-1.5 rounded bg-slate-800/50 px-2 py-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-[10px] uppercase text-slate-400">{edge.kind}</span>
      <span className="ml-auto truncate text-[11px]">
        {direction === "in" ? "← " : "→ "}{otherLabel}
      </span>
    </div>
  );
}

function NoteRow({ note }: { note: TopologyNote }) {
  const Icon = note.severity === "critical" || note.severity === "warn" ? AlertTriangle : Info;
  const color = note.severity === "critical" ? "text-rose-400"
    : note.severity === "warn" ? "text-amber-400"
    : "text-slate-400";
  return (
    <div className="flex items-start gap-1.5 rounded bg-slate-800/50 px-2 py-1.5">
      <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", color)} />
      <span className="text-[11px] text-slate-200">{note.text}</span>
    </div>
  );
}

// ============================================================================
// Top-left summary + global notes when no node is selected.
// ============================================================================

function SummaryCard({ summary, notes }: { summary: string; notes: TopologyNote[] }) {
  const globalNotes = notes.filter((n) => !n.node_id && !n.edge_id);
  return (
    <div className="pointer-events-auto absolute right-3 top-3 max-w-sm rounded-lg border border-white/10 bg-slate-900/90 p-3 text-xs text-slate-100 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
        <Shield className="h-3 w-3" /> Architecture overview
      </div>
      <p className="text-[11px] leading-relaxed text-slate-200">{summary}</p>
      {globalNotes.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
          {globalNotes.map((n, i) => <NoteRow key={i} note={n} />)}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Legend — pinned bottom-left, lists kind colors + edge styles.
// ============================================================================

function Legend() {
  const [open, setOpen] = useState(false);

  // Pick the kinds the user is most likely to see.
  const nodeKinds: NodeKind[] = ["container", "service", "database", "cache", "queue", "reverse_proxy", "external", "secret_store"];
  const edgeKinds: EdgeKind[] = ["http", "https", "tcp", "ssh", "env", "webhook", "depends_on"];

  return (
    <div className="absolute bottom-3 left-3 z-10">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg border border-white/10 bg-slate-900/90 px-2.5 py-1 text-[10px] font-medium text-slate-200 backdrop-blur hover:bg-slate-800"
      >
        {open ? "Hide legend" : "Show legend"}
      </button>
      {open && (
        <div className="mt-2 w-64 rounded-lg border border-white/10 bg-slate-900/95 p-3 text-[10px] text-slate-200 shadow-lg backdrop-blur">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Node kinds</div>
          <div className="grid grid-cols-2 gap-1.5">
            {nodeKinds.map((k) => {
              const s = KIND_STYLES[k];
              const Icon = s.icon;
              return (
                <div key={k} className="flex items-center gap-1.5">
                  <div className={cn("flex h-4 w-4 items-center justify-center rounded", s.bg)}>
                    <Icon className={cn("h-2.5 w-2.5", s.color)} />
                  </div>
                  <span className="text-[10px] capitalize">{k.replace(/_/g, " ")}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">Edge kinds</div>
          <div className="space-y-1">
            {edgeKinds.map((k) => {
              const s = EDGE_STYLES[k];
              return (
                <div key={k} className="flex items-center gap-2">
                  <svg width="28" height="6">
                    <line
                      x1="0" y1="3" x2="28" y2="3"
                      stroke={s.color}
                      strokeWidth="2"
                      strokeDasharray={s.strokeDasharray}
                    />
                  </svg>
                  <span className="text-[10px] capitalize">{k.replace(/_/g, " ")}</span>
                  {s.animated && <span className="text-[9px] text-slate-500">(animated)</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export styles so other Ops pages can reuse the same color language.
export { KIND_STYLES, EDGE_STYLES };
