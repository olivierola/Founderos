import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  Background, Controls, MiniMap, useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type Connection, type NodeTypes, Handle, Position,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  Plus, X, Search, ExternalLink, Globe, Loader2, ChevronRight,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import {
  ASSET_GROUPS, ASSET_BY_TYPE, fetchAssetOptions,
  type AssetTypeDef, type AssetOption,
} from "@/features/assets/assetTypes";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProjectAsset {
  id: string;
  asset_type: string;
  name: string;
  description?: string;
  url?: string;
  ref_id?: string;
  x: number;
  y: number;
}

export { ASSET_GROUPS, ASSET_BY_TYPE };

// ── Canvas node ─────────────────────────────────────────────────────────────

function AssetNode({ data }: { data: { asset: ProjectAsset; onDelete: (id: string) => void } }) {
  const def = ASSET_BY_TYPE[data.asset.asset_type];
  const Icon = def?.icon ?? Globe;
  const color = def ? colorFromTw(def.color) : "#6b7280";
  return (
    <div className="group relative rounded-xl border border-border bg-card p-3 shadow-md min-w-[140px] max-w-[200px]">
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} className="!bg-border !w-2 !h-2" />
      <button onClick={() => data.onDelete(data.asset.id)}
        className="absolute -right-2 -top-2 hidden rounded-full bg-destructive p-0.5 text-white group-hover:block">
        <X className="h-3 w-3" />
      </button>
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: color }}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{data.asset.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">{def?.label ?? data.asset.asset_type}</div>
        </div>
      </div>
      {data.asset.description && (
        <p className="mt-1.5 text-[10px] text-muted-foreground line-clamp-2">{data.asset.description}</p>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = { asset: AssetNode };

function colorFromTw(cls: string): string {
  const map: Record<string, string> = {
    "text-emerald-500": "#10b981", "text-teal-500": "#14b8a6", "text-amber-500": "#f59e0b",
    "text-blue-500": "#3b82f6", "text-sky-500": "#0ea5e9", "text-fuchsia-500": "#d946ef",
    "text-violet-500": "#8b5cf6", "text-zinc-400": "#a1a1aa", "text-orange-500": "#f97316",
    "text-red-500": "#ef4444", "text-indigo-500": "#6366f1", "text-pink-500": "#ec4899",
  };
  return map[cls] ?? "#6b7280";
}

// ── Main component ──────────────────────────────────────────────────────────

export function AssetsTab({ moduleProject }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const { projectId } = useCurrentContext();
  const assets: ProjectAsset[] = (moduleProject.metadata as any)?.assets ?? [];

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<AssetTypeDef | null>(null);
  const [selectedItem, setSelectedItem] = useState<AssetOption | null>(null);
  const [search, setSearch] = useState("");
  const [customForm, setCustomForm] = useState({ name: "", description: "", url: "" });

  const saveAssets = useCallback(async (next: ProjectAsset[]) => {
    await updateModuleProject(moduleProject.id, { metadata: { ...moduleProject.metadata, assets: next } });
    qc.invalidateQueries({ queryKey: ["module_project", moduleProject.id] });
  }, [moduleProject.id, moduleProject.metadata, qc]);

  // ── Canvas state ──
  const initialNodes: Node[] = useMemo(() => assets.map((a) => ({
    id: a.id, type: "asset", position: { x: a.x, y: a.y },
    data: { asset: a, onDelete: handleDelete },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [assets.map((a) => a.id).join(",")]);

  const initialEdges: Edge[] = useMemo(() =>
    ((moduleProject.metadata as any)?.asset_edges ?? []) as Edge[]
  , [moduleProject.metadata]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => {
      const next = addEdge({ ...params, animated: true, style: { stroke: "#6b7280" } }, eds);
      updateModuleProject(moduleProject.id, { metadata: { ...moduleProject.metadata, asset_edges: next } });
      return next;
    });
  }, [setEdges, moduleProject.id, moduleProject.metadata]);

  const onNodeDragStop = useCallback((_: any, node: Node) => {
    const updated = assets.map((a) => a.id === node.id ? { ...a, x: node.position.x, y: node.position.y } : a);
    updateModuleProject(moduleProject.id, { metadata: { ...moduleProject.metadata, assets: updated } });
  }, [assets, moduleProject.id, moduleProject.metadata]);

  function handleDelete(id: string) {
    const next = assets.filter((a) => a.id !== id);
    setNodes((ns) => ns.filter((n) => n.id !== id));
    saveAssets(next);
  }

  function addAsset(asset_type: string, name: string, opts?: { description?: string; url?: string; ref_id?: string }) {
    const id = crypto.randomUUID();
    const newAsset: ProjectAsset = {
      id, asset_type, name,
      description: opts?.description, url: opts?.url, ref_id: opts?.ref_id,
      x: 150 + Math.random() * 400, y: 100 + Math.random() * 300,
    };
    const next = [...assets, newAsset];
    setNodes((ns) => [...ns, {
      id, type: "asset", position: { x: newAsset.x, y: newAsset.y },
      data: { asset: newAsset, onDelete: handleDelete },
    }]);
    saveAssets(next);
  }

  function addExistingItem() {
    if (!selectedType || !selectedItem) return;
    addAsset(selectedType.type, selectedItem.label, { ref_id: selectedItem.ref_id, description: selectedItem.sub });
    resetSidebar();
  }

  function addCustomItem() {
    if (!selectedType || !customForm.name.trim()) return;
    addAsset(selectedType.type, customForm.name.trim(), {
      description: customForm.description.trim() || undefined,
      url: customForm.url.trim() || undefined,
    });
    resetSidebar();
  }

  function resetSidebar() {
    setSelectedItem(null);
    setCustomForm({ name: "", description: "", url: "" });
    setSearch("");
  }

  function closeSidebar() {
    setSidebarOpen(false);
    setSelectedGroup(null);
    setSelectedType(null);
    resetSidebar();
  }

  // ── Fetch existing items for the selected asset type ──
  const { data: existingItems, isLoading: loadingItems } = useQuery({
    queryKey: ["asset_options", selectedType?.type, projectId, search],
    enabled: !!selectedType && !!projectId,
    queryFn: () => fetchAssetOptions(selectedType!, projectId!, search),
  });

  return (
    <div className="relative flex h-full w-full">
      {/* ── Canvas ── */}
      <div className="min-w-0 flex-1">
        <div className="absolute left-4 top-4 z-10">
          <Button size="sm" onClick={() => setSidebarOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add asset
          </Button>
        </div>

        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect} onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3 }}
          className="bg-background"
        >
          <Background gap={20} size={1} color="hsl(var(--border))" />
          <Controls className="!bg-card !border-border !shadow-lg [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground" />
          <MiniMap className="!bg-card !border-border" nodeColor={(n) => {
            const def = ASSET_BY_TYPE[n.data?.asset?.asset_type];
            return def ? colorFromTw(def.color) : "#6b7280";
          }} />
        </ReactFlow>
      </div>

      {/* ── Add asset sidebar ── */}
      {sidebarOpen && (
        <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">
              {selectedType ? selectedType.label : selectedGroup ? selectedGroup : "Add asset"}
            </h3>
            <button onClick={closeSidebar} className="rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Step 1: choose group → type */}
          {!selectedType && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {!selectedGroup ? (
                // Group list
                ASSET_GROUPS.map((g) => (
                  <button key={g.group} onClick={() => setSelectedGroup(g.group)}
                    className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-left hover:bg-secondary/60">
                    <div>
                      <div className="text-sm font-medium">{g.group}</div>
                      <div className="text-[11px] text-muted-foreground">{g.types.map((t) => t.label).join(", ")}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))
              ) : (
                // Type list within group
                <>
                  <button onClick={() => setSelectedGroup(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
                    ← Back
                  </button>
                  {ASSET_GROUPS.find((g) => g.group === selectedGroup)?.types.map((t) => {
                    const Icon = t.icon;
                    return (
                      <button key={t.type} onClick={() => { setSelectedType(t); setSearch(""); }}
                        className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-secondary/60">
                        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white")} style={{ backgroundColor: colorFromTw(t.color) }}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="text-sm font-medium">{t.label}</div>
                          <div className="text-[10px] text-muted-foreground">{t.plural}</div>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* Step 2: pick existing or create custom */}
          {selectedType && (
            <div className="flex flex-1 flex-col min-h-0">
              <button onClick={() => { setSelectedType(null); resetSidebar(); }}
                className="flex items-center gap-1 px-4 pt-2 text-xs text-muted-foreground hover:text-foreground">
                ← Back to {selectedGroup}
              </button>

              {/* Search existing */}
              <div className="px-3 pt-2 pb-1">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder={`Search ${selectedType.plural.toLowerCase()}…`}
                    className="pl-8 h-8 text-xs" />
                </div>
              </div>

              {/* Existing items */}
              <div className="flex-1 overflow-y-auto px-3 pb-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-2">
                  Existing {selectedType.plural.toLowerCase()}
                </div>
                {loadingItems && <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
                {!loadingItems && (existingItems ?? []).length === 0 && (
                  <p className="py-3 text-xs text-muted-foreground">No {selectedType.plural.toLowerCase()} found.</p>
                )}
                {(existingItems ?? []).map((item) => {
                  const isSelected = selectedItem?.ref_id === item.ref_id;
                  const alreadyAdded = assets.some((a) => a.ref_id === item.ref_id && a.asset_type === selectedType.type);
                  return (
                    <button key={item.ref_id} disabled={alreadyAdded}
                      onClick={() => setSelectedItem(isSelected ? null : item)}
                      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        alreadyAdded ? "opacity-40 cursor-not-allowed" :
                        isSelected ? "bg-primary/10 text-foreground" : "hover:bg-secondary/60")}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{item.label}</div>
                        {item.sub && <div className="truncate text-[10px] text-muted-foreground">{item.sub}</div>}
                      </div>
                      {alreadyAdded && <span className="text-[9px] text-muted-foreground">Added</span>}
                    </button>
                  );
                })}

                {selectedItem && (
                  <Button size="sm" className="mt-2 w-full" onClick={addExistingItem}>
                    Add {selectedItem.label}
                  </Button>
                )}

                {/* Or create custom */}
                <div className="mt-4 border-t border-border pt-3">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Or add manually
                  </div>
                  <div className="space-y-2">
                    <Input value={customForm.name} onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                      placeholder={`${selectedType.label} name`} className="h-8 text-xs" />
                    {/* Type-specific fields */}
                    {needsUrl(selectedType.type) && (
                      <Input value={customForm.url} onChange={(e) => setCustomForm({ ...customForm, url: e.target.value })}
                        placeholder={urlPlaceholder(selectedType.type)} className="h-8 text-xs" />
                    )}
                    <textarea value={customForm.description} onChange={(e) => setCustomForm({ ...customForm, description: e.target.value })}
                      rows={2} placeholder="Description (optional)"
                      className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring" />
                    <Button size="sm" className="w-full" onClick={addCustomItem} disabled={!customForm.name.trim()}>
                      Add to canvas
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// ── Helpers per asset type ───────────────────────────────────────────────────

function needsUrl(type: string): boolean {
  return ["crm_contact", "employee", "candidate", "agent", "rag_collection", "task", "ticket"].indexOf(type) === -1;
}

function urlPlaceholder(type: string): string {
  switch (type) {
    case "document": return "Document URL or path";
    case "invoice": case "bill": return "Invoice URL";
    case "project": return "Project URL";
    case "inventory_item": case "supplier": return "Reference URL";
    default: return "URL (optional)";
  }
}
