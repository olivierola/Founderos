import { useMemo, useCallback, useState, useEffect } from "react";
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, Handle, Position,
  type Node, type Edge, type NodeProps, type EdgeProps,
  MarkerType, BaseEdge, EdgeLabelRenderer, getBezierPath,
  ReactFlowProvider, useNodesState, NodeResizer,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import {
  Server, Box, Database, Globe, Lock, Cloud, Cpu,
  Layers, KeyRound, Clock, ArrowRightLeft, AlertTriangle, Info,
  Network, Shield, HardDrive, Workflow,
  Wrench, MessageCircle, X, Send, Loader2, LayoutGrid,
  ChevronLeft, ChevronRight as ChevronRightIcon,
  Activity, Play as PlayIcon, ShieldAlert as ShieldAlertIcon,
  RefreshCw as RefreshCwIcon, Plus,
  // Extended kind icons
  Boxes, Cog, Container, GitBranch, GlobeLock, LineChart,
  Monitor, Radio, Rocket, Search as SearchIcon, ShieldQuestion,
  Smartphone, Sparkles as SparklesIcon, Terminal, UserCheck,
  Webhook, ChartScatter, FileText as FileIcon, Brain, Bot,
  Flame, Zap, BarChart3, Bell, ScrollText, Microscope,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NodeConfigDialog } from "./NodeConfigDialog";
import { EdgeConfigDialog } from "./EdgeConfigDialog";

// ============================================================================
// Topology data model — must stay in sync with ops_topologies.topology JSON.
// ============================================================================

export type NodeKind =
  // Compute
  | "server" | "container" | "service" | "scheduler"
  | "vm" | "function" | "edge_function" | "k8s_cluster" | "k8s_pod" | "k8s_deployment"
  // Data
  | "database" | "cache" | "queue" | "object_storage" | "data_warehouse" | "vector_db"
  // Networking
  | "reverse_proxy" | "load_balancer" | "cdn" | "dns" | "network" | "firewall" | "vpn" | "api_gateway"
  // Observability & ops
  | "monitoring" | "logging" | "tracing" | "metrics" | "alerting"
  // Auth & secrets
  | "auth" | "secret_store" | "identity_provider"
  // Edges
  | "external" | "third_party_api" | "browser" | "mobile_app" | "iot_device"
  // Pipelines
  | "ci_cd" | "build_pipeline" | "etl_pipeline"
  // AI/ML
  | "llm" | "embedding_model" | "ml_model";

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
// Per-kind visual styles.
//
// We use the design-system tokens (bg-card, border-border, text-foreground)
// as the base so the diagram inherits the SaaS palette and adapts to the
// light/dark theme switch. Each node is identified by:
//   - an icon
//   - a coloured accent strip + icon tint, expressed as a hue (0-360) so it
//     reads in both modes without hard-coding tailwind classes.
// ============================================================================

interface KindStyle {
  icon: any;
  /** HSL hue used to tint the accent strip and icon. */
  hue: number;
}

const KIND_STYLES: Record<NodeKind, KindStyle> = {
  // Compute
  server:           { icon: Server,         hue: 220 },
  container:        { icon: Container,      hue: 215 },
  service:          { icon: Workflow,       hue: 265 },
  scheduler:        { icon: Clock,          hue: 250 },
  vm:               { icon: Monitor,        hue: 230 },
  function:         { icon: Zap,            hue: 50  },
  edge_function:    { icon: Zap,            hue: 195 },
  k8s_cluster:      { icon: Boxes,          hue: 215 },
  k8s_pod:          { icon: Box,            hue: 220 },
  k8s_deployment:   { icon: Rocket,         hue: 210 },
  // Data
  database:         { icon: Database,       hue: 35  },
  cache:            { icon: Cpu,            hue: 0   },
  queue:            { icon: Layers,         hue: 320 },
  object_storage:   { icon: HardDrive,      hue: 50  },
  data_warehouse:   { icon: ChartScatter,   hue: 285 },
  vector_db:        { icon: Microscope,     hue: 275 },
  // Networking
  reverse_proxy:    { icon: ArrowRightLeft, hue: 150 },
  load_balancer:    { icon: Network,        hue: 160 },
  cdn:              { icon: Cloud,          hue: 200 },
  dns:              { icon: Globe,          hue: 190 },
  network:          { icon: Network,        hue: 175 },
  firewall:         { icon: Flame,          hue: 10  },
  vpn:              { icon: GlobeLock,      hue: 240 },
  api_gateway:      { icon: Webhook,        hue: 270 },
  // Observability
  monitoring:       { icon: Activity,       hue: 130 },
  logging:          { icon: ScrollText,     hue: 110 },
  tracing:          { icon: LineChart,      hue: 170 },
  metrics:          { icon: BarChart3,      hue: 140 },
  alerting:         { icon: Bell,           hue: 25  },
  // Auth & secrets
  auth:             { icon: UserCheck,      hue: 280 },
  secret_store:     { icon: KeyRound,       hue: 290 },
  identity_provider:{ icon: ShieldQuestion, hue: 295 },
  // Edges (clients)
  external:         { icon: Globe,          hue: 240 },
  third_party_api:  { icon: Cog,            hue: 235 },
  browser:          { icon: Monitor,        hue: 200 },
  mobile_app:       { icon: Smartphone,     hue: 205 },
  iot_device:       { icon: Radio,          hue: 25  },
  // Pipelines
  ci_cd:            { icon: GitBranch,      hue: 90  },
  build_pipeline:   { icon: Terminal,       hue: 85  },
  etl_pipeline:     { icon: SearchIcon,     hue: 95  },
  // AI/ML
  llm:              { icon: SparklesIcon,   hue: 290 },
  embedding_model:  { icon: Brain,          hue: 280 },
  ml_model:         { icon: Bot,            hue: 285 },
};

// Suppress "imported but unused" — these icons are referenced by KIND_STYLES
// via runtime lookup so TS doesn't see them as used.
void FileIcon;

/** Returns inline styles for a node's accent strip + icon tint, using HSL so
 *  it adapts to the current foreground (light vs dark theme). */
function accentFor(hue: number) {
  return {
    stripBg: `hsl(${hue} 75% 60%)`,
    iconColor: `hsl(${hue} 75% 60%)`,
    softBg: `hsl(${hue} 75% 60% / 0.10)`,
    softBorder: `hsl(${hue} 70% 55% / 0.45)`,
  };
}

// Edge colors. Slightly desaturated and a bit lighter than node hues so the
// lines read on both light and dark backgrounds.
const EDGE_STYLES: Record<EdgeKind, { color: string; strokeDasharray?: string; animated?: boolean }> = {
  http:          { color: "hsl(215 75% 60%)" },
  https:         { color: "hsl(150 65% 50%)", animated: true },
  tcp:           { color: "hsl(265 65% 65%)" },
  ssh:           { color: "hsl(35 85% 55%)", strokeDasharray: "4 2" },
  env:           { color: "hsl(220 8% 60%)", strokeDasharray: "2 2" },
  webhook:       { color: "hsl(320 70% 60%)", animated: true },
  volume_mount:  { color: "hsl(50 85% 55%)", strokeDasharray: "6 3" },
  depends_on:    { color: "hsl(220 8% 55%)", strokeDasharray: "1 3" },
  network_link:  { color: "hsl(190 75% 55%)" },
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
  const accent = accentFor(s.hue);
  const dimmed = data.isHighlighted === false;

  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border bg-card text-xs text-card-foreground shadow-sm transition-opacity",
        data.isSelected && "ring-2",
        dimmed && "opacity-30",
      )}
      style={{
        minWidth: 170,
        // selected ring colour follows the node's accent hue, not a hardcoded slate.
        ...(data.isSelected ? { boxShadow: `0 0 0 2px ${accent.stripBg}` } : {}),
      }}
    >
      {/* coloured accent strip on the left identifies the kind */}
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ background: accent.stripBg }} />

      <Handle
        type="target"
        position={Position.Left}
        isConnectable
        className="!h-3 !w-3 !border-2 !border-card !bg-primary opacity-0 transition-opacity group-hover:opacity-100"
        style={{ left: -6 }}
      />

      <div className="flex items-center gap-2 px-3 py-2 pl-4">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
          style={{ background: accent.softBg, color: accent.iconColor }}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold leading-tight text-foreground">{data.label}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {data.kind.replace(/_/g, " ")}
          </div>
        </div>
      </div>

      {(data.ports?.length || data.image) && (
        <div className="rounded-b-lg border-t border-border bg-muted/40 px-3 py-1.5 pl-4">
          {data.ports && data.ports.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.ports.slice(0, 4).map((p) => (
                <span
                  key={p}
                  className="rounded bg-background/80 px-1 py-0.5 font-mono text-[9px] text-muted-foreground"
                >
                  :{p}
                </span>
              ))}
              {data.ports.length > 4 && (
                <span className="text-[9px] text-muted-foreground">+{data.ports.length - 4}</span>
              )}
            </div>
          )}
          {data.image && (
            <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{data.image}</div>
          )}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable
        className="!h-3 !w-3 !border-2 !border-card !bg-primary opacity-0 transition-opacity group-hover:opacity-100"
        style={{ right: -6 }}
      />
    </div>
  );
}

// ============================================================================
// Group / cluster zone — a *purely visual* container drawn beneath the nodes.
//
// Important: contrary to a vanilla React Flow group, this is NOT a parent of
// the nodes it visually contains. Nodes stay top-level so the user can drag
// them anywhere (including outside the zone). The zone is just a movable +
// resizable hint rectangle that the user can also push around independently.
// ============================================================================

interface GroupData {
  label: string;
  kind: string;
}

function GroupNode({ data, selected }: NodeProps<GroupData>) {
  return (
    <div className="relative h-full w-full">
      {/* NodeResizer adds 8 invisible handles around the node; visible only when selected. */}
      <NodeResizer
        minWidth={120}
        minHeight={80}
        isVisible={selected}
        lineStyle={{ borderColor: "hsl(var(--primary-soft))", borderWidth: 1 }}
        handleStyle={{
          width: 8, height: 8, borderRadius: 2,
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--primary-soft))",
        }}
      />
      {/* Subtle zone tint — no thick rectangle, just a discrete hint that these
          things belong together. */}
      <div className="pointer-events-none absolute inset-0 rounded-xl border border-dashed border-border/60 bg-muted/15" />
      {/* Floating label pinned top-left. pointer-events: auto so the user can
          drag the zone by grabbing its label without fighting child nodes. */}
      <div className="pointer-events-auto absolute left-2 top-2 inline-flex items-center gap-1 rounded border border-border bg-card/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
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

// Fallback used whenever the AI emits an edge kind we don't know about. Keeps
// the diagram rendering instead of crashing inside React Flow's renderer.
const FALLBACK_EDGE_STYLE = { color: "#94a3b8" } as const;

function ArchEdge(props: EdgeProps<EdgeData>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const s = EDGE_STYLES[data?.kind ?? "tcp"] ?? FALLBACK_EDGE_STYLE;
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
      {/* Animated flow particles for edges that represent live traffic
          (http/https/webhook). A second dashed stroke layered on top, animated
          via stroke-dashoffset, gives the impression of data flowing. */}
      {s.animated && !dimmed && (
        <path
          d={edgePath}
          fill="none"
          stroke={s.color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray="2 14"
          style={{ filter: `drop-shadow(0 0 2px ${s.color})` }}
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-32"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </path>
      )}
      {(data?.label || data?.port) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className={cn(
              "rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[9px] text-foreground shadow-sm",
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

  // 1. Zone nodes (groups). They are NOT parents of the architecture nodes —
  //    they are independent, movable, resizable rectangles that visually hint
  //    at clustering. Drawn first with low zIndex so they sit behind the
  //    actual nodes.
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
        out.push({
          id: `group_${grp.id}`,
          type: "group",
          position: { x: minX - padding, y: minY - padding - 16 },
          data: { label: grp.label, kind: grp.kind } as GroupData,
          style: {
            width: (maxX - minX) + padding * 2,
            height: (maxY - minY) + padding * 2 + 16,
            zIndex: -1, // behind the actual nodes
          } as any,
          // Zones are independently draggable and selectable so the user can
          // move them and resize them via the NodeResizer handles. But they
          // are NOT parents of anything — no constraint on their contents.
          draggable: true,
          selectable: true,
        });
      }
    }
  }

  // 2. Architecture nodes — all top-level (no parentNode), so they can be
  //    dragged anywhere on the canvas without being clamped by a parent zone.
  for (const n of nodes) {
    const p = g.node(n.id);
    if (!p) continue;
    out.push({
      id: n.id,
      type: "arch",
      position: { x: p.x - p.width / 2, y: p.y - p.height / 2 },
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

interface ServerOption {
  id: string;
  name: string;
  environment: string;
}

/** Patch applied to the topology when the user edits / adds / removes a node
 *  or zone from the canvas. The parent persists the new topology via the
 *  ops_topologies table. */
export interface TopologyPatch {
  nodes?: TopologyNode[];
  edges?: TopologyEdge[];
  groups?: TopologyGroup[];
}

interface ArchitectureViewProps {
  topology: Topology;
  summary?: string | null;
  className?: string;
  /** Title shown in the floating header bar inside the canvas. */
  title?: string;
  /** Right-aligned actions in the floating header bar (e.g. Regenerate button). */
  headerActions?: React.ReactNode;
  /** When provided, the floating AI chat will send messages here. */
  onAiMessage?: (message: string) => Promise<string> | string;

  /** ---- Deploy/Apply floating bar (bottom-right) ---- */
  servers?: ServerOption[];
  serverId?: string | null;
  onServerChange?: (id: string) => void;
  onApply?: () => void | Promise<void>;
  applying?: boolean;
  canApply?: boolean;

  /** ---- Versioning / live data ---- */
  /** When set, enables the version history sidebar and "Save snapshot" button. */
  infraProjectId?: string | null;
  /** When provided, called on right-click → returns live metrics for the node. */
  onNodeProbe?: (nodeId: string) => Promise<NodeLiveData | null>;

  /** ---- Editing ---- */
  /** Called with the next full topology whenever the user edits, adds, or
   *  removes a node/zone from the canvas. Parent persists it. */
  onTopologyChange?: (next: Topology) => void | Promise<void>;
}

export interface NodeLiveData {
  fetched_at: string;
  /** Free-form key/value table the inspector renders as a list. */
  metrics: Array<{ label: string; value: string; status?: "ok" | "warn" | "error" }>;
  /** Optional raw command output (e.g. last journalctl lines). */
  raw?: string;
}

const nodeTypes = { arch: ArchNode, group: GroupNode };
const edgeTypes = { arch: ArchEdge };

export function ArchitectureView(props: ArchitectureViewProps) {
  return (
    <ReactFlowProvider>
      <InnerView {...props} />
    </ReactFlowProvider>
  );
}

function InnerView({
  topology, summary, className, title, headerActions, onAiMessage,
  servers, serverId, onServerChange, onApply, applying, canApply,
  infraProjectId: _infraProjectId, onNodeProbe, onTopologyChange,
}: ArchitectureViewProps) {
  // Initial layout from dagre. After this, the user can drag nodes around and
  // we keep their positions thanks to useNodesState.
  const initialNodes = useMemo(
    () => layoutNodes(topology.nodes, topology.edges, topology.groups),
    [topology.nodes, topology.edges, topology.groups],
  );
  const baseEdges = useMemo(() => topologyToEdges(topology.edges), [topology.edges]);

  // Drag-and-drop state. Reset whenever the underlying topology changes.
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  useEffect(() => { setNodes(initialNodes); }, [initialNodes, setNodes]);

  // Auto-grow zones to fit their member nodes whenever any of them moves.
  // The groups (zones) are NOT React Flow parents of the inner nodes — they
  // are pure visual rectangles. This effect adjusts their position + size so
  // they always enclose the right members with a small padding.
  useEffect(() => {
    if (!topology.groups || topology.groups.length === 0) return;
    setNodes((current) => {
      let dirty = false;
      const PADDING = 36;
      const TOP_PAD = PADDING + 16; // extra room above for the label pill

      const nodeById = new Map(current.map((n) => [n.id, n]));
      const next = current.map((n) => {
        if (n.type !== "group") return n;
        const grpId = n.id.replace(/^group_/, "");
        const grp = topology.groups!.find((g) => g.id === grpId);
        if (!grp) return n;

        // Measure member bounds.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const memberId of grp.contains) {
          const m = nodeById.get(memberId);
          if (!m || m.type === "group") continue;
          const w = (m.width ?? 200);
          const h = (m.height ?? 80);
          minX = Math.min(minX, m.position.x);
          minY = Math.min(minY, m.position.y);
          maxX = Math.max(maxX, m.position.x + w);
          maxY = Math.max(maxY, m.position.y + h);
        }
        if (minX === Infinity) return n;

        const targetX = minX - PADDING;
        const targetY = minY - TOP_PAD;
        const targetW = (maxX - minX) + PADDING * 2;
        const targetH = (maxY - minY) + TOP_PAD + PADDING;

        const curW = (n.style?.width as number | undefined) ?? 0;
        const curH = (n.style?.height as number | undefined) ?? 0;
        const epsilon = 1;
        if (
          Math.abs(n.position.x - targetX) < epsilon &&
          Math.abs(n.position.y - targetY) < epsilon &&
          Math.abs(curW - targetW) < epsilon &&
          Math.abs(curH - targetH) < epsilon
        ) return n;

        dirty = true;
        return {
          ...n,
          position: { x: targetX, y: targetY },
          style: { ...(n.style ?? {}), width: targetW, height: targetH, zIndex: -1 },
        };
      });

      return dirty ? next : current;
    });
  }, [nodes, topology.groups, setNodes]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Overview is closable. We default to OPEN (matches previous behaviour) and
  // remember the user's last choice in localStorage so toggling the page
  // doesn't keep re-opening it for them.
  const [overviewOpen, setOverviewOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("ops.archview.overviewOpen");
    return stored === null ? true : stored === "true";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("ops.archview.overviewOpen", String(overviewOpen));
  }, [overviewOpen]);

  // Action bar (Target server + Plan & apply) is also closable.
  const [actionBarOpen, setActionBarOpen] = useState<boolean>(true);

  // Zones are hidden by default (the schema lands directly on the canvas).
  // The user opts in via the Toolkit. Preference is remembered per browser.
  const [showZones, setShowZones] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("ops.archview.showZones") === "true";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("ops.archview.showZones", String(showZones));
  }, [showZones]);

  // Right-click context menu state.
  const [contextMenu, setContextMenu] = useState<
    | { x: number; y: number; nodeId: string }
    | null
  >(null);
  // Live-data panel — populated when the user picks "Show live data" in the
  // context menu (or when we wire auto-refresh in the future).
  const [liveData, setLiveData] = useState<
    | { nodeId: string; loading: boolean; data: NodeLiveData | null; error?: string }
    | null
  >(null);

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

  // Inject selection + highlight flags into node data without losing positions.
  // Zones are filtered out entirely when the user has them hidden — that's
  // also why the schema appears "directly on the canvas" by default.
  const renderedNodes = useMemo(() => nodes
    .filter((n) => n.type !== "group" || showZones)
    .map((n) => {
      if (n.type === "group") return n;
      return {
        ...n,
        data: {
          ...(n.data as NodeData),
          isSelected: n.id === selectedId,
          isHighlighted: highlightSet ? highlightSet.has(n.id) : undefined,
        } as NodeData,
      };
    }), [nodes, selectedId, highlightSet, showZones]);

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
    // If the canvas is editable, open the config dialog. Otherwise fall back
    // to the side inspector behaviour.
    if (onTopologyChange) {
      setEditingNodeId(node.id);
    } else {
      setSelectedId((prev) => prev === node.id ? null : node.id);
    }
  }, [onTopologyChange]);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
    setContextMenu(null);
  }, []);

  // Right-click on a node opens a small context menu anchored at the cursor.
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type === "group") return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  // Triggered from the context menu — fetches live data and opens the panel.
  const probeNode = useCallback(async (nodeId: string) => {
    setContextMenu(null);
    if (!onNodeProbe) {
      setLiveData({ nodeId, loading: false, data: null, error: "Live probe is not wired for this view." });
      return;
    }
    setLiveData({ nodeId, loading: true, data: null });
    try {
      const data = await onNodeProbe(nodeId);
      setLiveData({ nodeId, loading: false, data });
    } catch (e: any) {
      setLiveData({ nodeId, loading: false, data: null, error: e?.message ?? "Probe failed" });
    }
  }, [onNodeProbe]);

  const selectedNode = selectedId ? topology.nodes.find((n) => n.id === selectedId) : null;
  const selectedNotes = useMemo(
    () => selectedId ? (topology.notes ?? []).filter((n) => n.node_id === selectedId) : [],
    [selectedId, topology.notes],
  );

  // Re-layout = recompute initial positions and reset the drag state.
  const relayout = useCallback(() => {
    setNodes(layoutNodes(topology.nodes, topology.edges, topology.groups));
  }, [topology, setNodes]);

  // ---- Editing handlers ----
  // We open the config dialog when the user single-clicks a node. The right-
  // click context menu still lets them inspect or probe.
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const editingNode = editingNodeId ? topology.nodes.find((n) => n.id === editingNodeId) ?? null : null;

  function commitTopology(next: Topology) {
    onTopologyChange?.(next);
  }

  function addNodeOfKind(kind: NodeKind) {
    if (!onTopologyChange) return;
    // Generate a stable id from the kind + a count suffix.
    const base = kind.replace(/_/g, "-");
    let i = 1;
    while (topology.nodes.some((n) => n.id === `${base}-${i}`)) i++;
    const id = `${base}-${i}`;
    const newNode: TopologyNode = {
      id,
      kind,
      label: `${kind.replace(/_/g, " ")} ${i}`,
    };
    const next: Topology = { ...topology, nodes: [...topology.nodes, newNode] };
    commitTopology(next);
    // Open the dialog right away so the user can fill the details.
    setTimeout(() => setEditingNodeId(id), 100);
  }

  function addZoneAround() {
    if (!onTopologyChange) return;
    let i = 1;
    while ((topology.groups ?? []).some((g) => g.id === `zone-${i}`)) i++;
    const id = `zone-${i}`;
    const newGroup: TopologyGroup = {
      id,
      label: `Zone ${i}`,
      kind: "server",
      contains: [], // user adds members manually for now
    };
    const next: Topology = { ...topology, groups: [...(topology.groups ?? []), newGroup] };
    commitTopology(next);
    // Surface the new zone immediately even if zones are hidden.
    setShowZones(true);
  }

  function saveNode(patched: TopologyNode) {
    if (!onTopologyChange) return;
    const next: Topology = {
      ...topology,
      nodes: topology.nodes.map((n) => n.id === editingNodeId ? patched : n),
    };
    commitTopology(next);
  }

  // ---- Edge creation / deletion ----
  // ReactFlow's onConnect fires when the user drops a connection on a target
  // handle. We turn that into a new TopologyEdge with a sensible default kind
  // and persist via onTopologyChange.
  const onConnect = useCallback((params: { source: string | null; target: string | null }) => {
    if (!onTopologyChange) return;
    if (!params.source || !params.target || params.source === params.target) return;
    // Avoid duplicate edges between the same pair.
    const exists = topology.edges.some((e) => e.source === params.source && e.target === params.target);
    if (exists) return;
    const id = `${params.source}-to-${params.target}`;
    const newEdge: TopologyEdge = {
      id, source: params.source, target: params.target, kind: "tcp",
    };
    const next: Topology = { ...topology, edges: [...topology.edges, newEdge] };
    commitTopology(next);
  }, [onTopologyChange, topology]);

  // Edge editing state — clicking an edge opens the dialog. Alt+Click is a
  // power-user shortcut to delete without going through the dialog.
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const editingEdge = editingEdgeId
    ? topology.edges.find((e) => e.id === editingEdgeId) ?? null
    : null;

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    if (!onTopologyChange) return;
    if (event.altKey) {
      // Alt+Click → instant delete, no dialog.
      if (!window.confirm(`Delete edge ${edge.id}?`)) return;
      const next: Topology = {
        ...topology,
        edges: topology.edges.filter((e) => e.id !== edge.id),
      };
      commitTopology(next);
      return;
    }
    setEditingEdgeId(edge.id);
  }, [onTopologyChange, topology]);

  function saveEdge(patched: TopologyEdge) {
    if (!onTopologyChange) return;
    // The id may have changed if source/target were re-routed — but our patched
    // copy keeps the original id. We just replace by id.
    const next: Topology = {
      ...topology,
      edges: topology.edges.map((e) => e.id === editingEdgeId ? patched : e),
    };
    commitTopology(next);
  }

  function deleteEditingEdge() {
    if (!onTopologyChange || !editingEdgeId) return;
    const id = editingEdgeId;
    const next: Topology = {
      ...topology,
      edges: topology.edges.filter((e) => e.id !== id),
    };
    commitTopology(next);
    setEditingEdgeId(null);
  }

  function deleteEditingNode() {
    if (!onTopologyChange || !editingNodeId) return;
    const id = editingNodeId;
    const next: Topology = {
      ...topology,
      nodes: topology.nodes.filter((n) => n.id !== id),
      // Drop any edges that referenced it.
      edges: topology.edges.filter((e) => e.source !== id && e.target !== id),
      // Drop it from group memberships.
      groups: (topology.groups ?? []).map((g) => ({ ...g, contains: g.contains.filter((c) => c !== id) })),
    };
    commitTopology(next);
    setEditingNodeId(null);
  }

  return (
    <div className={cn("relative flex h-full w-full overflow-hidden bg-background", className)}>
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={renderedNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onNodeContextMenu={onNodeContextMenu}
          onPaneClick={onPaneClick}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          nodesDraggable
          nodesConnectable={!!onTopologyChange}
          edgesUpdatable
          connectionRadius={30}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={1.5}
        >
          {/* True dotted background, themed via the design system tokens. */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.5}
            color="hsl(var(--muted-foreground) / 0.35)"
          />
          <Controls
            showInteractive={false}
            position="bottom-right"
            className="!border-border !bg-card/90 backdrop-blur [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground"
          />
          <MiniMap
            pannable zoomable
            position="bottom-right"
            className="!border-border !bg-card"
            style={{ marginBottom: 100 }}
            maskColor="hsl(var(--background) / 0.6)"
            nodeStrokeColor="hsl(var(--border))"
            nodeColor={(n) => {
              if (n.type === "group") return "transparent";
              const kind = (n.data as NodeData)?.kind;
              const hue = (kind && KIND_STYLES[kind]?.hue) ?? 220;
              return `hsl(${hue} 60% 55%)`;
            }}
          />
        </ReactFlow>

        {/* Floating top-bar with title + actions; lives inside the canvas so the
            content above doesn't take a strip of header. */}
        {(title || headerActions) && (
          <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex items-start justify-between gap-2">
            {title && (
              <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur">
                <Network className="h-3 w-3 text-muted-foreground" /> {title}
              </div>
            )}
            <div className="pointer-events-auto flex items-center gap-2">
              {headerActions}
            </div>
          </div>
        )}

        {/* Floating toolkit panel — left side, collapsible. */}
        <Toolkit
          onRelayout={relayout}
          showZones={showZones}
          onToggleZones={() => setShowZones((v) => !v)}
          onAddNode={onTopologyChange ? addNodeOfKind : undefined}
          onAddZone={onTopologyChange ? addZoneAround : undefined}
        />

        {/* Floating AI chat — right side, collapsible. */}
        {onAiMessage && <AiChat onSend={onAiMessage} />}

        {/* Architecture overview floats in the top-right when nothing is
            selected. Closable via the X button (state persisted to localStorage). */}
        {summary && !selectedNode && overviewOpen && (
          <SummaryCard
            summary={summary}
            notes={topology.notes ?? []}
            hasHeader={!!title}
            onClose={() => setOverviewOpen(false)}
          />
        )}

        {/* When overview is closed, drop a tiny pill to reopen it. */}
        {summary && !selectedNode && !overviewOpen && (
          <button
            onClick={() => setOverviewOpen(true)}
            className={cn(
              "pointer-events-auto absolute right-3 z-10 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur hover:text-foreground",
              title ? "top-16" : "top-3",
            )}
            title="Show architecture overview"
          >
            <Shield className="h-3 w-3" /> Overview
          </button>
        )}

        {/* Bottom-right floating action bar — Target server + Plan & apply,
            closable. Pill-only when closed so the canvas stays unobstructed. */}
        {onApply && (
          actionBarOpen ? (
            <div className="pointer-events-auto absolute bottom-3 left-3 z-10 inline-flex items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
              <ShieldAlertIcon className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-muted-foreground">High-risk · approval required</span>
              <span className="mx-1 h-3 w-px bg-border" />
              <select
                value={serverId ?? ""}
                onChange={(e) => onServerChange?.(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">Target server…</option>
                {servers?.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.environment})</option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={() => onApply()}
                disabled={!serverId || applying || canApply === false}
                className="gap-1.5"
              >
                {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayIcon className="h-3 w-3" />}
                Plan & apply
              </Button>
              <button
                onClick={() => setActionBarOpen(false)}
                className="ml-1 text-muted-foreground hover:text-foreground"
                title="Collapse"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setActionBarOpen(true)}
              className="pointer-events-auto absolute bottom-3 left-3 z-10 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-[11px] font-medium text-foreground shadow-sm backdrop-blur hover:bg-muted"
              title="Show deploy controls"
            >
              <PlayIcon className="h-3 w-3" /> Deploy
            </button>
          )
        )}

        {/* Right-click context menu at cursor position. */}
        {contextMenu && (
          <NodeContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            nodeId={contextMenu.nodeId}
            node={topology.nodes.find((n) => n.id === contextMenu.nodeId) ?? null}
            onClose={() => setContextMenu(null)}
            onShowDetails={() => {
              setSelectedId(contextMenu.nodeId);
              setContextMenu(null);
            }}
            onShowLive={() => probeNode(contextMenu.nodeId)}
            liveAvailable={!!onNodeProbe}
          />
        )}

        {/* Floating live-data panel — appears bottom-center when the user picks
            "Show live data" in the context menu. */}
        {liveData && (
          <LivePanel
            nodeLabel={topology.nodes.find((n) => n.id === liveData.nodeId)?.label ?? liveData.nodeId}
            loading={liveData.loading}
            data={liveData.data}
            error={liveData.error}
            onRefresh={() => probeNode(liveData.nodeId)}
            onClose={() => setLiveData(null)}
          />
        )}
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

      <NodeConfigDialog
        open={editingNode !== null}
        onOpenChange={(o) => { if (!o) setEditingNodeId(null); }}
        node={editingNode}
        otherNodeIds={topology.nodes.map((n) => n.id)}
        onSave={saveNode}
        onDelete={editingNode ? deleteEditingNode : undefined}
        autoSave
      />

      <EdgeConfigDialog
        open={editingEdge !== null}
        onOpenChange={(o) => { if (!o) setEditingEdgeId(null); }}
        edge={editingEdge}
        sourceNode={editingEdge ? topology.nodes.find((n) => n.id === editingEdge.source) ?? null : null}
        targetNode={editingEdge ? topology.nodes.find((n) => n.id === editingEdge.target) ?? null : null}
        allNodes={topology.nodes}
        onSave={saveEdge}
        onDelete={editingEdge ? deleteEditingEdge : undefined}
        autoSave
      />
    </div>
  );
}

// ============================================================================
// Right-click context menu on a node.
// ============================================================================

function NodeContextMenu({
  x, y, nodeId: _nodeId, node, onClose, onShowDetails, onShowLive, liveAvailable,
}: {
  x: number; y: number;
  nodeId: string;
  node: TopologyNode | null;
  onClose: () => void;
  onShowDetails: () => void;
  onShowLive: () => void;
  liveAvailable: boolean;
}) {
  // Close on Escape or click outside.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    function onClickAway() { onClose(); }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClickAway);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClickAway);
    };
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-border bg-card shadow-lg"
      style={{ left: x, top: y }}
    >
      <div className="border-b border-border px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {node?.label ?? "Node"}
      </div>
      <button
        onClick={onShowDetails}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
      >
        <Info className="h-3.5 w-3.5 text-muted-foreground" /> Show details
      </button>
      <button
        onClick={onShowLive}
        disabled={!liveAvailable}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
      >
        <Activity className="h-3.5 w-3.5 text-emerald-500" />
        {liveAvailable ? "Show live data" : "Live data (not available)"}
      </button>
    </div>
  );
}

// ============================================================================
// Floating live-data panel (bottom-center).
// ============================================================================

function LivePanel({
  nodeLabel, loading, data, error, onRefresh, onClose,
}: {
  nodeLabel: string;
  loading: boolean;
  data: NodeLiveData | null;
  error?: string;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-20 w-[min(560px,90%)] -translate-x-1/2 rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          Live · {nodeLabel}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} className="text-muted-foreground hover:text-foreground" title="Refresh">
            <RefreshCwIcon className="h-3.5 w-3.5" />
          </button>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto p-3 text-xs">
        {loading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing…
          </div>
        )}
        {!loading && error && (
          <div className="rounded bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{error}</div>
        )}
        {!loading && !error && data && (
          <>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {data.metrics.map((m, i) => (
                <div key={i} className="flex items-center justify-between rounded border border-border bg-muted/30 px-2 py-1">
                  <span className="text-muted-foreground">{m.label}</span>
                  <span className={cn(
                    "font-mono text-[11px]",
                    m.status === "error" && "text-destructive",
                    m.status === "warn" && "text-amber-500",
                    m.status === "ok" && "text-emerald-500",
                  )}>{m.value}</span>
                </div>
              ))}
            </div>
            {data.raw && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted/30 p-2 font-mono text-[10px]">{data.raw}</pre>
            )}
            <div className="mt-2 text-[10px] text-muted-foreground">
              Fetched {new Date(data.fetched_at).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Floating Toolkit panel — left side, collapsible.
// ============================================================================

// Equipment catalog — what the user can add to the canvas. Grouped for the UI.
const EQUIPMENT_GROUPS: Array<{
  label: string;
  items: Array<{ kind: NodeKind; label: string }>;
}> = [
  {
    label: "Compute",
    items: [
      { kind: "server",          label: "Server / VPS" },
      { kind: "vm",              label: "VM" },
      { kind: "container",       label: "Container" },
      { kind: "service",         label: "Service" },
      { kind: "scheduler",       label: "Scheduler / Worker" },
      { kind: "function",        label: "Function" },
      { kind: "edge_function",   label: "Edge function" },
    ],
  },
  {
    label: "Kubernetes",
    items: [
      { kind: "k8s_cluster",     label: "Cluster" },
      { kind: "k8s_deployment",  label: "Deployment" },
      { kind: "k8s_pod",         label: "Pod" },
    ],
  },
  {
    label: "Data",
    items: [
      { kind: "database",        label: "Database" },
      { kind: "cache",           label: "Cache" },
      { kind: "queue",           label: "Queue / Broker" },
      { kind: "object_storage",  label: "Object storage" },
      { kind: "data_warehouse",  label: "Data warehouse" },
      { kind: "vector_db",       label: "Vector DB" },
    ],
  },
  {
    label: "Networking",
    items: [
      { kind: "reverse_proxy",   label: "Reverse proxy" },
      { kind: "load_balancer",   label: "Load balancer" },
      { kind: "api_gateway",     label: "API gateway" },
      { kind: "cdn",             label: "CDN" },
      { kind: "dns",             label: "DNS" },
      { kind: "network",         label: "Network" },
      { kind: "firewall",        label: "Firewall" },
      { kind: "vpn",             label: "VPN" },
    ],
  },
  {
    label: "Observability",
    items: [
      { kind: "monitoring",      label: "Monitoring" },
      { kind: "metrics",         label: "Metrics" },
      { kind: "logging",         label: "Logging" },
      { kind: "tracing",         label: "Tracing" },
      { kind: "alerting",        label: "Alerting" },
    ],
  },
  {
    label: "Auth & Secrets",
    items: [
      { kind: "auth",            label: "Auth service" },
      { kind: "identity_provider", label: "IdP / SSO" },
      { kind: "secret_store",    label: "Secret store" },
    ],
  },
  {
    label: "Clients & Edge",
    items: [
      { kind: "browser",         label: "Browser" },
      { kind: "mobile_app",      label: "Mobile app" },
      { kind: "iot_device",      label: "IoT device" },
      { kind: "external",        label: "External service" },
      { kind: "third_party_api", label: "3rd-party API" },
    ],
  },
  {
    label: "Pipelines",
    items: [
      { kind: "ci_cd",           label: "CI/CD" },
      { kind: "build_pipeline",  label: "Build pipeline" },
      { kind: "etl_pipeline",    label: "ETL pipeline" },
    ],
  },
  {
    label: "AI / ML",
    items: [
      { kind: "llm",             label: "LLM" },
      { kind: "embedding_model", label: "Embedding model" },
      { kind: "ml_model",        label: "ML model" },
      { kind: "vector_db",       label: "Vector store" },
    ],
  },
];

function Toolkit({
  onRelayout, showZones, onToggleZones, onAddNode, onAddZone,
}: {
  onRelayout: () => void;
  showZones: boolean;
  onToggleZones: () => void;
  onAddNode?: (kind: NodeKind) => void;
  onAddZone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [equipOpen, setEquipOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute left-3 top-16 z-10 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur hover:bg-muted"
        title="Open toolkit"
      >
        <Wrench className="h-3.5 w-3.5" /> Toolkit
      </button>
    );
  }

  return (
    <div className="absolute left-3 top-16 z-10 w-72 rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Wrench className="h-3.5 w-3.5" /> Toolkit
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
          title="Collapse"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[60vh] space-y-1 overflow-y-auto p-2 text-xs">
        {/* Layout */}
        <button
          onClick={onRelayout}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-muted"
        >
          <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
          Re-layout (auto-arrange)
        </button>

        {/* Zones toggle + add */}
        <div className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted">
          <span className="flex items-center gap-2 text-foreground">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            Show zones
          </span>
          <button
            onClick={onToggleZones}
            className={cn(
              "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
              showZones ? "bg-emerald-500" : "bg-muted-foreground/30",
            )}
            title="Toggle zone visibility"
          >
            <span
              className={cn(
                "inline-block h-3 w-3 transform rounded-full bg-white transition-transform",
                showZones ? "translate-x-3.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
        {onAddZone && (
          <button
            onClick={onAddZone}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            Add zone
          </button>
        )}

        {/* Equipment catalog */}
        {onAddNode && (
          <>
            <button
              onClick={() => setEquipOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-foreground hover:bg-muted"
            >
              <span className="flex items-center gap-2">
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                Add equipment
              </span>
              <ChevronRightIcon className={cn("h-3 w-3 transition-transform", equipOpen && "rotate-90")} />
            </button>
            {equipOpen && (
              <div className="space-y-2 rounded border border-border bg-background/40 p-2">
                {EQUIPMENT_GROUPS.map((grp) => (
                  <div key={grp.label}>
                    <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                      {grp.label}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {grp.items.map((eq) => {
                        const s = KIND_STYLES[eq.kind];
                        const Icon = s.icon;
                        const accent = accentFor(s.hue);
                        return (
                          <button
                            key={eq.kind}
                            onClick={() => onAddNode(eq.kind)}
                            className="flex items-center gap-1.5 rounded border border-border bg-card px-1.5 py-1 text-left text-[10px] hover:border-foreground/30"
                            title={`Add a ${eq.label} node`}
                          >
                            <div
                              className="flex h-4 w-4 items-center justify-center rounded"
                              style={{ background: accent.softBg, color: accent.iconColor }}
                            >
                              <Icon className="h-2.5 w-2.5" />
                            </div>
                            <span className="truncate">{eq.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Legend */}
        <button
          onClick={() => setLegendOpen(!legendOpen)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-muted"
        >
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
          {legendOpen ? "Hide legend" : "Show legend"}
        </button>
        {legendOpen && (
          <div className="rounded border border-border bg-background/40 p-2">
            <LegendContent />
          </div>
        )}

        <p className="px-2 pt-1 text-[10px] text-muted-foreground">
          Tip: drag nodes to rearrange. Click a node to configure it.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Floating AI chat — right side, collapsible.
// ============================================================================

interface ChatMsg { role: "user" | "assistant"; text: string; }

function AiChat({ onSend }: { onSend: (msg: string) => Promise<string> | string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sending, setSending] = useState(false);

  async function submit() {
    const text = input.trim();
    if (!text || sending) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setSending(true);
    try {
      const reply = await onSend(text);
      setMessages((m) => [...m, { role: "assistant", text: reply }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${e?.message ?? "unknown"}` }]);
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute right-3 top-16 z-10 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur hover:bg-muted"
        title="Ask the AI to modify this infra"
      >
        <MessageCircle className="h-3.5 w-3.5" /> Ask AI
      </button>
    );
  }

  return (
    <div className="absolute right-3 top-16 z-10 flex w-80 flex-col rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur" style={{ maxHeight: "calc(100% - 96px)" }}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <MessageCircle className="h-3.5 w-3.5" /> Ask AI
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
          title="Collapse"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {messages.length === 0 ? (
          <p className="rounded border border-dashed border-border bg-background/40 p-2 text-[11px] text-muted-foreground">
            Describe a change ("Add Redis cache", "Use Caddy instead of Nginx") and the AI will update the infra.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                "rounded-md px-2 py-1.5 text-[11px] leading-snug",
                m.role === "user"
                  ? "ml-6 bg-primary/10 text-foreground"
                  : "mr-6 bg-muted text-foreground",
              )}
            >
              {m.text}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Ask for a change…"
          className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={sending}
        />
        <Button size="sm" variant="ghost" onClick={submit} disabled={sending || !input.trim()}>
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
        </Button>
      </div>
    </div>
  );
}

// Re-exported chevron so the JSX above can use it without a name clash with
// the icon already imported as ChevronRightIcon at the top.
const _unusedChevron = ChevronRightIcon;
void _unusedChevron;

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
  const accent = accentFor(s.hue);
  const labelOf = (id: string) => allNodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-border bg-card text-foreground">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex h-6 w-6 items-center justify-center rounded"
            style={{ background: accent.softBg, color: accent.iconColor }}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{node.label}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{node.kind.replace(/_/g, " ")}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {node.image && <Field label="Image" value={<code className="font-mono text-[11px]">{node.image}</code>} />}
        {node.command && <Field label="Command" value={<code className="font-mono text-[10px]">{node.command}</code>} />}
        {node.healthcheck && <Field label="Healthcheck" value={<code className="font-mono text-[10px]">{node.healthcheck}</code>} />}

        {node.ports && node.ports.length > 0 && (
          <Field label="Ports" value={
            <div className="flex flex-wrap gap-1">
              {node.ports.map((p) => <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{p}</span>)}
            </div>
          } />
        )}

        {node.env && node.env.length > 0 && (
          <Field label={`Env vars (${node.env.length})`} value={
            <div className="space-y-0.5">
              {node.env.map((e) => <div key={e} className="font-mono text-[10px] text-muted-foreground">{e}</div>)}
            </div>
          } />
        )}

        {node.volumes && node.volumes.length > 0 && (
          <Field label="Volumes" value={
            <div className="space-y-0.5">
              {node.volumes.map((v) => <div key={v} className="font-mono text-[10px] text-muted-foreground">{v}</div>)}
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
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function ConnRow({ edge, otherLabel, direction }: { edge: TopologyEdge; otherLabel: string; direction: "in" | "out" }) {
  const color = EDGE_STYLES[edge.kind]?.color ?? "#94a3b8";
  return (
    <div className="flex items-center gap-1.5 rounded bg-muted px-2 py-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-[10px] uppercase text-muted-foreground">{edge.kind}</span>
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
    : "text-muted-foreground";
  return (
    <div className="flex items-start gap-1.5 rounded bg-muted px-2 py-1.5">
      <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", color)} />
      <span className="text-[11px] text-foreground">{note.text}</span>
    </div>
  );
}

// ============================================================================
// Top-left summary + global notes when no node is selected.
// ============================================================================

function SummaryCard({
  summary, notes, hasHeader, onClose,
}: {
  summary: string;
  notes: TopologyNote[];
  hasHeader?: boolean;
  onClose?: () => void;
}) {
  const globalNotes = notes.filter((n) => !n.node_id && !n.edge_id);
  // When the canvas has a floating header, push the summary down so they don't
  // collide with the right-side actions.
  const topOffset = hasHeader ? "top-16" : "top-3";
  return (
    <div className={cn(
      "pointer-events-auto absolute right-3 z-10 max-w-sm rounded-lg border border-border bg-card/95 p-3 text-xs text-foreground shadow-lg backdrop-blur",
      topOffset,
    )}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Shield className="h-3 w-3" /> Architecture overview
        </div>
        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Hide">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-foreground">{summary}</p>
      {globalNotes.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {globalNotes.map((n, i) => <NoteRow key={i} note={n} />)}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Legend content — rendered inside the Toolkit popover.
// ============================================================================

function LegendContent() {
  // Pick the kinds the user is most likely to see.
  const nodeKinds: NodeKind[] = ["container", "service", "database", "cache", "queue", "reverse_proxy", "external", "secret_store"];
  const edgeKinds: EdgeKind[] = ["http", "https", "tcp", "ssh", "env", "webhook", "depends_on"];

  return (
    <>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">Node kinds</div>
      <div className="grid grid-cols-2 gap-1.5">
        {nodeKinds.map((k) => {
          const s = KIND_STYLES[k];
          const Icon = s.icon;
          const accent = accentFor(s.hue);
          return (
            <div key={k} className="flex items-center gap-1.5">
              <div
                className="flex h-4 w-4 items-center justify-center rounded"
                style={{ background: accent.softBg, color: accent.iconColor }}
              >
                <Icon className="h-2.5 w-2.5" />
              </div>
              <span className="text-[10px] capitalize">{k.replace(/_/g, " ")}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Edge kinds</div>
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
              {s.animated && <span className="text-[9px] text-muted-foreground">(animated)</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

// Re-export styles so other Ops pages can reuse the same color language.
export { KIND_STYLES, EDGE_STYLES };
