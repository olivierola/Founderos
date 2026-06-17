import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, Handle, Position, Panel,
  applyNodeChanges, applyEdgeChanges, addEdge, ReactFlowProvider, NodeResizer,
  type Node, type Edge, type NodeProps, type Connection,
  type NodeChange, type EdgeChange, type OnConnect,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  Loader2, Plus, Search, Square, StickyNote, Trash2, X, Save, Check,
  Shapes, ChevronDown, ArrowLeftRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  ASSET_BY_TYPE, ASSET_GROUPS, RELATIONS, fetchAssetOptions,
  type AssetTypeDef, type AssetOption,
} from "./assetTypes";

// ── DB row shapes ──
interface DbNode { id: string; canvas_id: string; kind: "asset" | "zone" | "note"; asset_type: string | null; ref_id: string | null; label: string | null; data: Record<string, unknown>; pos_x: number; pos_y: number; width: number | null; height: number | null; color: string | null; z_index: number }
interface DbEdge { id: string; canvas_id: string; source_node_id: string; target_node_id: string; label: string | null; relation: string | null; animated: boolean; color: string | null }

// ───────────────────────────────────────────────────────── custom node types
function AssetNode({ data, selected }: NodeProps) {
  const def: AssetTypeDef | undefined = data.def;
  const Icon = def?.icon ?? Shapes;
  return (
    <div className={cn("min-w-[150px] max-w-[220px] rounded-lg border bg-card px-3 py-2 shadow-sm", selected ? "border-primary ring-1 ring-primary" : "border-border")}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted", def?.color)}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{data.label || "Untitled"}</div>
          <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{def?.label ?? "asset"}</div>
        </div>
      </div>
      {data.sub && <div className="mt-1 truncate text-[11px] text-muted-foreground">{data.sub}</div>}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-primary" />
    </div>
  );
}

function NoteNode({ data, selected }: NodeProps) {
  return (
    <div className={cn("min-h-[60px] w-[180px] rounded-md border px-3 py-2 text-sm shadow-sm", selected ? "border-primary" : "border-amber-300/60")} style={{ background: data.color || "#fef9c3" }}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2" />
      <div className="whitespace-pre-wrap break-words text-zinc-800">{data.label || "Note"}</div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2" />
    </div>
  );
}

function ZoneNode({ id, data, selected }: NodeProps) {
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={120}
        onResizeEnd={(_e, p) => data.onResizeEnd?.(id, p.width, p.height)}
        lineClassName="!border-primary"
        handleClassName="!h-2 !w-2 !rounded-sm !border-primary !bg-card"
      />
      <div className={cn("h-full w-full rounded-xl border-2 border-dashed", selected ? "border-primary" : "border-border")} style={{ background: (data.color || "#6366f1") + "10" }}>
        <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{data.label || "Zone"}</div>
      </div>
    </>
  );
}

const NODE_TYPES = { asset: AssetNode, note: NoteNode, zone: ZoneNode };

// ───────────────────────────────────────────────────────────────── page
export function AssetMapPage() {
  return (
    <ReactFlowProvider>
      <AssetMapInner />
    </ReactFlowProvider>
  );
}

function AssetMapInner() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [libOpen, setLibOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load (or create) the project's default canvas + its nodes/edges.
  useEffect(() => {
    if (!projectId || !workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let { data: canvas } = await supabase.from("asset_canvases").select("id").eq("project_id", projectId).order("created_at").limit(1).maybeSingle();
      if (!canvas) {
        const { data: created } = await supabase.from("asset_canvases").insert({ workspace_id: workspaceId, project_id: projectId, name: "Asset map", created_by: user?.id ?? null }).select("id").single();
        canvas = created;
      }
      if (!canvas || cancelled) return;
      const [{ data: dbNodes }, { data: dbEdges }] = await Promise.all([
        supabase.from("asset_nodes").select("*").eq("canvas_id", canvas.id),
        supabase.from("asset_edges").select("*").eq("canvas_id", canvas.id),
      ]);
      if (cancelled) return;
      setCanvasId(canvas.id);
      setNodes((dbNodes ?? []).map(dbToFlowNode));
      setEdges((dbEdges ?? []).map(dbToFlowEdge));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [projectId, workspaceId, user?.id]);

  // ── persistence helpers ──
  const persistNodePosition = useCallback(async (id: string, x: number, y: number, width?: number, height?: number) => {
    const patch: Record<string, unknown> = { pos_x: x, pos_y: y };
    if (width != null) patch.width = width;
    if (height != null) patch.height = height;
    await supabase.from("asset_nodes").update(patch).eq("id", id);
    setSavedAt(Date.now());
  }, []);

  // Apply React Flow changes to local state. We do NOT persist here: position is
  // saved on drag-stop and size on resize-end (below). Auto-measured `dimensions`
  // changes on mount must never be written back, or stored layout drifts on reload.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // Persist the final position once the user releases a node (covers multi-select drag).
  const onNodeDragStop = useCallback((_e: unknown, _node: Node, dragged: Node[]) => {
    const moved = dragged && dragged.length ? dragged : (_node ? [_node] : []);
    for (const n of moved) persistNodePosition(n.id, n.position.x, n.position.y);
  }, [persistNodePosition]);

  // Persist a zone/note size when a resize ends.
  const onResizeEnd = useCallback((id: string, width: number, height: number) => {
    const n = nodes.find((x) => x.id === id);
    if (n) persistNodePosition(id, n.position.x, n.position.y, width, height);
  }, [nodes, persistNodePosition]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
    for (const ch of changes) {
      if (ch.type === "remove") supabase.from("asset_edges").delete().eq("id", ch.id).then(() => setSavedAt(Date.now()));
    }
  }, []);

  const onConnect: OnConnect = useCallback(async (conn: Connection) => {
    if (!canvasId || !workspaceId || !projectId || !conn.source || !conn.target) return;
    const { data } = await supabase.from("asset_edges").insert({
      workspace_id: workspaceId, project_id: projectId, canvas_id: canvasId,
      source_node_id: conn.source, target_node_id: conn.target, relation: "relates_to",
    }).select("*").single();
    if (data) setEdges((eds) => addEdge(dbToFlowEdge(data as DbEdge), eds));
    setSavedAt(Date.now());
  }, [canvasId, workspaceId, projectId]);

  // ── add nodes ──
  const addAssetNode = useCallback(async (def: AssetTypeDef, opt: AssetOption) => {
    if (!canvasId || !workspaceId || !projectId) return;
    const pos = { x: 120 + Math.random() * 360, y: 80 + Math.random() * 280 };
    const { data } = await supabase.from("asset_nodes").insert({
      workspace_id: workspaceId, project_id: projectId, canvas_id: canvasId, kind: "asset",
      asset_type: def.type, ref_id: opt.ref_id, label: opt.label,
      data: { sub: opt.sub ?? null }, pos_x: pos.x, pos_y: pos.y,
    }).select("*").single();
    if (data) setNodes((nds) => [...nds, dbToFlowNode(data as DbNode)]);
    setSavedAt(Date.now());
  }, [canvasId, workspaceId, projectId]);

  const addFreeNode = useCallback(async (kind: "zone" | "note") => {
    if (!canvasId || !workspaceId || !projectId) return;
    const isZone = kind === "zone";
    const { data } = await supabase.from("asset_nodes").insert({
      workspace_id: workspaceId, project_id: projectId, canvas_id: canvasId, kind,
      label: isZone ? "New zone" : "New note",
      pos_x: 200, pos_y: 160, width: isZone ? 320 : 180, height: isZone ? 220 : 80,
      color: isZone ? "#6366f1" : "#fef9c3", z_index: isZone ? -1 : 0,
    }).select("*").single();
    if (data) setNodes((nds) => [...nds, dbToFlowNode(data as DbNode)]);
    setSavedAt(Date.now());
  }, [canvasId, workspaceId, projectId]);

  const selected = useMemo(() => nodes.find((n) => n.selected) ?? null, [nodes]);
  const selectedEdge = useMemo(() => edges.find((e) => e.selected) ?? null, [edges]);

  // Patch an edge in the DB + local state. `data` carries relation/custom-label
  // flags so the rendered label can be either the relation or a free label.
  const patchEdge = useCallback(async (id: string, patch: Partial<DbEdge> & { customLabel?: boolean }) => {
    const { customLabel, ...dbPatch } = patch;
    await supabase.from("asset_edges").update(dbPatch).eq("id", id);
    setEdges((eds) => eds.map((e) => {
      if (e.id !== id) return e;
      const data = { ...e.data } as { relation?: string; customLabel?: boolean };
      if (dbPatch.relation !== undefined) data.relation = dbPatch.relation ?? undefined;
      if (customLabel !== undefined) data.customLabel = customLabel;
      const label = dbPatch.label !== undefined
        ? (dbPatch.label ?? undefined)
        : (data.customLabel ? e.label : (data.relation ?? e.label));
      const style = { ...(e.style ?? {}) };
      if (dbPatch.color !== undefined) style.stroke = dbPatch.color ?? undefined;
      return {
        ...e, label, data, style,
        animated: dbPatch.animated !== undefined ? dbPatch.animated : e.animated,
      };
    }));
    setSavedAt(Date.now());
  }, []);

  // Swap an edge's direction (source ⇄ target).
  const reverseEdge = useCallback(async (e: Edge) => {
    await supabase.from("asset_edges").update({ source_node_id: e.target, target_node_id: e.source }).eq("id", e.id);
    setEdges((eds) => eds.map((x) => (x.id === e.id ? { ...x, source: e.target, target: e.source } : x)));
    setSavedAt(Date.now());
  }, []);

  const deleteEdge = useCallback(async (id: string) => {
    await supabase.from("asset_edges").delete().eq("id", id);
    setEdges((eds) => eds.filter((e) => e.id !== id));
    setSavedAt(Date.now());
  }, []);

  async function deleteSelected() {
    const sel = nodes.filter((n) => n.selected).map((n) => n.id);
    const selE = edges.filter((e) => e.selected).map((e) => e.id);
    if (sel.length) await supabase.from("asset_nodes").delete().in("id", sel);
    if (selE.length) await supabase.from("asset_edges").delete().in("id", selE);
    setNodes((nds) => nds.filter((n) => !n.selected));
    setEdges((eds) => eds.filter((e) => !e.selected));
    setSavedAt(Date.now());
  }

  async function renameNode(id: string, label: string, color?: string) {
    const patch: Record<string, unknown> = { label };
    if (color !== undefined) patch.color = color;
    await supabase.from("asset_nodes").update(patch).eq("id", id);
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, label, ...(color !== undefined ? { color } : {}) }, ...(color !== undefined ? { style: { ...n.style } } : {}) } : n)));
    setSavedAt(Date.now());
  }

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // Inject the resize callback into zone nodes' data (without storing it in DB).
  const displayNodes = useMemo(
    () => nodes.map((n) => (n.type === "zone" ? { ...n, data: { ...n.data, onResizeEnd } } : n)),
    [nodes, onResizeEnd],
  );

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="!bg-background" />
        <Controls className="!bg-card !border-border" />
        <MiniMap className="!bg-card" zoomable pannable nodeColor={() => "hsl(var(--primary))"} />

        {/* Toolbar */}
        <Panel position="top-left" className="flex items-center gap-2 rounded-lg border border-border bg-card/95 p-1.5 shadow-sm backdrop-blur">
          <Button size="sm" onClick={() => setLibOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add asset</Button>
          <Button size="sm" variant="outline" onClick={() => addFreeNode("zone")}><Square className="mr-1 h-3.5 w-3.5" /> Zone</Button>
          <Button size="sm" variant="outline" onClick={() => addFreeNode("note")}><StickyNote className="mr-1 h-3.5 w-3.5" /> Note</Button>
          <div className="ml-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            {savedAt && Date.now() - savedAt < 2500 ? <><Check className="h-3 w-3 text-emerald-500" /> Saved</> : <><Save className="h-3 w-3" /> Auto-saved</>}
          </div>
        </Panel>

        {nodes.length === 0 && (
          <Panel position="top-center" className="pointer-events-none mt-24">
            <div className="rounded-xl border border-dashed border-border bg-card/80 px-6 py-5 text-center text-sm text-muted-foreground">
              <Shapes className="mx-auto mb-2 h-6 w-6 text-muted-foreground/70" />
              Add assets — contacts, invoices, projects, agents, goods… — and connect them.
            </div>
          </Panel>
        )}
      </ReactFlow>

      {/* Inspector for the selected node */}
      {selected && <Inspector node={selected} onRename={renameNode} onDelete={deleteSelected} />}

      {/* Edge relation editor */}
      {selectedEdge && !selected && (
        <EdgeInspector edge={selectedEdge} onPatch={patchEdge} onReverse={reverseEdge} onDelete={deleteEdge} />
      )}

      {/* Asset library drawer */}
      {libOpen && <AssetLibrary projectId={projectId} onClose={() => setLibOpen(false)} onPick={addAssetNode} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── inspector
function Inspector({ node, onRename, onDelete }: { node: Node; onRename: (id: string, label: string, color?: string) => void; onDelete: () => void }) {
  const [label, setLabel] = useState(String(node.data.label ?? ""));
  useEffect(() => setLabel(String(node.data.label ?? "")), [node.id, node.data.label]);
  const editable = node.type !== "asset"; // free nodes (zone/note) get a label editor
  const def: AssetTypeDef | undefined = node.data.def;

  return (
    <div className="absolute right-3 top-3 z-10 w-64 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase text-muted-foreground">{node.type === "asset" ? (def?.label ?? "Asset") : node.type}</span>
        <button onClick={onDelete} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      {editable ? (
        <>
          <textarea value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => onRename(node.id, label)} rows={node.type === "note" ? 3 : 1}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">Color
            <input type="color" defaultValue={(node.style?.background as string) || (node.type === "zone" ? "#6366f1" : "#fef9c3")} onChange={(e) => onRename(node.id, label, e.target.value)} className="h-6 w-8 rounded border border-border" />
          </div>
        </>
      ) : (
        <div className="text-sm"><div className="font-medium">{String(node.data.label)}</div>{node.data.sub && <div className="text-xs text-muted-foreground">{String(node.data.sub)}</div>}</div>
      )}
      {node.type === "asset" && <p className="mt-2 text-[11px] text-muted-foreground">Drag from the right edge to connect. Set the relation type on the edge.</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────── edge inspector
const EDGE_COLORS = ["", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];

function EdgeInspector({ edge, onPatch, onReverse, onDelete }: {
  edge: Edge;
  onPatch: (id: string, patch: Partial<DbEdge> & { customLabel?: boolean }) => void;
  onReverse: (e: Edge) => void;
  onDelete: (id: string) => void;
}) {
  const data = (edge.data ?? {}) as { relation?: string; customLabel?: boolean };
  const isCustom = !!data.customLabel;
  const [label, setLabel] = useState(typeof edge.label === "string" ? edge.label : "");
  useEffect(() => setLabel(typeof edge.label === "string" ? edge.label : ""), [edge.id, edge.label]);
  const curColor = (edge.style?.stroke as string) ?? "";

  return (
    <div className="absolute right-3 top-3 z-10 w-64 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase text-muted-foreground">Link</span>
        <button onClick={() => onDelete(edge.id)} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>

      {/* Relation type — drives the label unless a custom label is set. */}
      <label className="mb-1 block text-[11px] text-muted-foreground">Relation</label>
      <select
        value={data.relation ?? "relates_to"}
        onChange={(e) => onPatch(edge.id, { relation: e.target.value, ...(isCustom ? {} : { label: e.target.value }) })}
        className="mb-2 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        {RELATIONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
      </select>

      {/* Custom label */}
      <label className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        <input type="checkbox" checked={isCustom} onChange={(e) => onPatch(edge.id, { customLabel: e.target.checked, label: e.target.checked ? (label || data.relation || "") : (data.relation ?? null) })} className="accent-primary" />
        Custom label
      </label>
      {isCustom && (
        <input
          value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => onPatch(edge.id, { label, customLabel: true })}
          placeholder="e.g. signed on 12 May" className="mb-2 h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      )}

      {/* Color */}
      <label className="mb-1 block text-[11px] text-muted-foreground">Color</label>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {EDGE_COLORS.map((c) => (
          <button key={c || "default"} onClick={() => onPatch(edge.id, { color: c || null })}
            className={cn("h-5 w-5 rounded-full border", curColor === c ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : "border-border")}
            style={{ background: c || "hsl(var(--muted-foreground))" }} title={c || "default"} />
        ))}
      </div>

      {/* Animated + direction */}
      <label className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <input type="checkbox" checked={!!edge.animated} onChange={(e) => onPatch(edge.id, { animated: e.target.checked })} className="accent-primary" />
        Animated flow
      </label>
      <Button size="sm" variant="outline" className="h-7 w-full" onClick={() => onReverse(edge)}>
        <ArrowLeftRight className="mr-1 h-3.5 w-3.5" /> Reverse direction
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── library
function AssetLibrary({ projectId, onClose, onPick }: { projectId: string | null; onClose: () => void; onPick: (def: AssetTypeDef, opt: AssetOption) => void }) {
  const [active, setActive] = useState<AssetTypeDef | null>(null);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<AssetOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => Object.fromEntries(ASSET_GROUPS.map((g) => [g.group, true])));

  useEffect(() => {
    if (!active || !projectId) { setOptions([]); return; }
    let cancelled = false;
    setLoading(true);
    fetchAssetOptions(active, projectId, search).then((o) => { if (!cancelled) setOptions(o); }).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [active, projectId, search]);

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 font-medium"><Shapes className="h-4 w-4" /> Asset library</span>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>

      {!active ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {ASSET_GROUPS.map((g) => (
            <div key={g.group} className="mb-1">
              <button onClick={() => setOpenGroups((p) => ({ ...p, [g.group]: !p[g.group] }))} className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
                <ChevronDown className={cn("h-3 w-3 transition-transform", !openGroups[g.group] && "-rotate-90")} /> {g.group}
              </button>
              {openGroups[g.group] && g.types.map((t) => {
                const Icon = t.icon;
                return (
                  <button key={t.type} onClick={() => { setActive(t); setSearch(""); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                    <span className={cn("flex h-6 w-6 items-center justify-center rounded bg-muted", t.color)}><Icon className="h-3.5 w-3.5" /></span>
                    {t.plural}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="border-b border-border p-3">
            <button onClick={() => setActive(null)} className="mb-2 text-xs text-muted-foreground hover:text-foreground">← All types</button>
            <div className="flex items-center gap-2"><Search className="h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${active.plural.toLowerCase()}…`} className="h-8" autoFocus /></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
              : options.length === 0 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">No {active.plural.toLowerCase()} found.</p>
              : options.map((o) => (
                <button key={o.ref_id} onClick={() => onPick(active, o)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50">
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0"><span className="block truncate">{o.label}</span>{o.sub && <span className="block truncate text-[11px] text-muted-foreground">{o.sub}</span>}</span>
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────── mappers
function dbToFlowNode(n: DbNode): Node {
  const def = n.asset_type ? ASSET_BY_TYPE[n.asset_type] : undefined;
  const base: Node = {
    id: n.id,
    type: n.kind,
    position: { x: n.pos_x, y: n.pos_y },
    data: { label: n.label, sub: (n.data as { sub?: string })?.sub, def, color: n.color },
  };
  if (n.kind === "zone") {
    base.style = { width: n.width ?? 320, height: n.height ?? 220, background: (n.color || "#6366f1") + "10" };
    base.zIndex = -1;
  }
  if (n.kind === "note") base.style = { background: n.color || "#fef9c3" };
  return base;
}

function dbToFlowEdge(e: DbEdge): Edge {
  const custom = !!(e.label && e.relation && e.label !== e.relation);
  return {
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    label: e.label ?? e.relation ?? undefined,
    animated: e.animated,
    style: { stroke: e.color || undefined, strokeWidth: 1.5 },
    interactionWidth: 20, // wider invisible hit area so thin edges are easy to select
    labelStyle: { fontSize: 11, fill: "hsl(var(--foreground))" },
    labelBgStyle: { fill: "hsl(var(--card))" },
    data: { relation: e.relation, customLabel: custom },
  };
}

export { RELATIONS };
