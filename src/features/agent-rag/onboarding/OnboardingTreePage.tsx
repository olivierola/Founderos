import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  type Node as FlowNode, type Edge as FlowEdge, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  ChevronRight,
  ChevronDown,
  Loader2,
  Network,
  Copy,
  Check,
  Sparkles,
  AlertCircle,
  Search,
  FolderTree,
  FileCode,
  FileJson,
  FileText,
  Folder,
  Globe,
  MousePointerClick,
  Link2,
  FormInput,
  Radar,
  Maximize2,
  X,
  GitBranch,
  CalendarClock,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";

interface ScanRow {
  id: string;
  created_at: string;
  app_structure: Record<string, unknown> | null;
  repositories: { full_name: string } | null;
}

/* ============================================================ */
/*  Visual Tree view — file explorer-like, with connector lines  */
/* ============================================================ */

interface TreeNode {
  id: string;
  label: string;
  kind: "root" | "section" | "page" | "route" | "element" | "intent" | "summary";
  meta?: string;
  children?: TreeNode[];
}

/** Convert the app_structure object into a renderable tree of nodes. */
function buildTreeFromScan(data: unknown): TreeNode {
  const struct = (data ?? {}) as {
    pages?: Array<{ name?: string; path?: string; elements?: Array<{ type?: string; label?: string; action?: string }> }>;
    routes?: string[];
    element_count?: number;
    enriched?: {
      pages?: Array<{
        name?: string;
        route?: string;
        description?: string;
        intents?: string[];
        primary_actions?: Array<{ label?: string; selector_hint?: string; target_route?: string; intent?: string }>;
        related_routes?: string[];
      }>;
      navigation?: { entry_routes?: string[]; common_journeys?: Array<{ name?: string; route_sequence?: string[]; description?: string }> };
      summary?: string;
    };
  };

  const root: TreeNode = { id: "root", label: "app_structure", kind: "root", children: [] };

  // --- Pages (raw scan)
  if (struct.pages && struct.pages.length > 0) {
    const pagesSection: TreeNode = {
      id: "raw-pages",
      label: "Pages",
      kind: "section",
      meta: `${struct.pages.length} scanned`,
      children: struct.pages.map((p, i) => ({
        id: "raw-page-" + i,
        label: p.name ?? "(unnamed)",
        kind: "page",
        meta: p.path,
        children: (p.elements ?? []).map((el, ei) => ({
          id: "raw-page-" + i + "-el-" + ei,
          label: el.label || "(unlabeled)",
          kind: "element",
          meta: el.action ?? el.type,
        })),
      })),
    };
    root.children!.push(pagesSection);
  }

  // --- Routes
  if (struct.routes && struct.routes.length > 0) {
    root.children!.push({
      id: "routes",
      label: "Routes",
      kind: "section",
      meta: `${struct.routes.length} routes`,
      children: struct.routes.map((r, i) => ({
        id: "route-" + i,
        label: r,
        kind: "route",
      })),
    });
  }

  // --- Enriched (semantic map)
  if (struct.enriched) {
    const enrichedSection: TreeNode = {
      id: "enriched",
      label: "Enriched (AI semantic map)",
      kind: "section",
      meta: struct.enriched.summary ? "with summary" : undefined,
      children: [],
    };
    if (struct.enriched.summary) {
      enrichedSection.children!.push({ id: "summary", label: "Summary", kind: "summary", meta: struct.enriched.summary });
    }
    if (struct.enriched.pages && struct.enriched.pages.length > 0) {
      enrichedSection.children!.push({
        id: "enriched-pages",
        label: "Pages",
        kind: "section",
        meta: `${struct.enriched.pages.length} enriched`,
        children: struct.enriched.pages.map((p, i) => {
          const pageChildren: TreeNode[] = [];
          if (p.intents && p.intents.length > 0) {
            pageChildren.push({
              id: "epage-" + i + "-intents",
              label: "User intents",
              kind: "section",
              children: p.intents.map((intent, ii) => ({ id: "epage-" + i + "-int-" + ii, label: intent, kind: "intent" })),
            });
          }
          if (p.primary_actions && p.primary_actions.length > 0) {
            pageChildren.push({
              id: "epage-" + i + "-actions",
              label: "Primary actions",
              kind: "section",
              children: p.primary_actions.map((a, ai) => ({
                id: "epage-" + i + "-act-" + ai,
                label: a.label ?? "(action)",
                kind: "element",
                meta: a.target_route ?? a.intent,
              })),
            });
          }
          if (p.related_routes && p.related_routes.length > 0) {
            pageChildren.push({
              id: "epage-" + i + "-related",
              label: "Related routes",
              kind: "section",
              children: p.related_routes.map((r, ri) => ({ id: "epage-" + i + "-rel-" + ri, label: r, kind: "route" })),
            });
          }
          return {
            id: "enriched-page-" + i,
            label: p.name ?? "(unnamed)",
            kind: "page",
            meta: p.route ?? p.description?.slice(0, 80),
            children: pageChildren,
          };
        }),
      });
    }
    if (struct.enriched.navigation?.common_journeys) {
      enrichedSection.children!.push({
        id: "journeys",
        label: "Common journeys",
        kind: "section",
        meta: `${struct.enriched.navigation.common_journeys.length} journeys`,
        children: struct.enriched.navigation.common_journeys.map((j, i) => ({
          id: "journey-" + i,
          label: j.name ?? "(unnamed)",
          kind: "intent",
          meta: (j.route_sequence ?? []).join(" → "),
        })),
      });
    }
    if (enrichedSection.children!.length > 0) root.children!.push(enrichedSection);
  }

  return root;
}

function nodeIcon(kind: TreeNode["kind"]) {
  switch (kind) {
    case "root":
    case "section":
      return Folder;
    case "page":
      return FileText;
    case "route":
      return Globe;
    case "element":
      return MousePointerClick;
    case "intent":
      return Link2;
    case "summary":
      return Sparkles;
    default:
      return FormInput;
  }
}

function nodeColor(kind: TreeNode["kind"]) {
  switch (kind) {
    case "root":
      return "hsl(var(--primary-soft))";
    case "section":
      return "hsl(var(--accent-2))";
    case "page":
      return "#7dd3fc";
    case "route":
      return "#86efac";
    case "element":
      return "#fcd34d";
    case "intent":
      return "#a78bfa";
    case "summary":
      return "#f472b6";
    default:
      return "#9ca3af";
  }
}

function nodeMatches(node: TreeNode, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase();
  if (node.label.toLowerCase().includes(t)) return true;
  if (node.meta && node.meta.toLowerCase().includes(t)) return true;
  return (node.children ?? []).some((c) => nodeMatches(c, t));
}

function TreeNodeRow({
  node,
  depth,
  isLast,
  parentPrefix,
  query,
}: {
  node: TreeNode;
  depth: number;
  isLast: boolean;
  parentPrefix: boolean[];
  query: string;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = (node.children ?? []).length > 0;
  const Icon = nodeIcon(node.kind);
  const color = nodeColor(node.kind);

  if (!nodeMatches(node, query)) return null;

  return (
    <div className="font-mono text-xs">
      <div className="relative flex items-center gap-1 py-1 hover:bg-secondary/30">
        {/* Vertical guide lines from ancestors */}
        {parentPrefix.map((show, i) => (
          <span
            key={i}
            className="inline-block w-5 shrink-0 self-stretch"
            style={{
              borderLeft: show ? "1px solid hsl(var(--border))" : "none",
              marginLeft: 2,
            }}
          />
        ))}

        {/* L-connector to this node */}
        {depth > 0 && (
          <span className="relative inline-block w-5 shrink-0 self-stretch">
            <span
              className="absolute left-0 top-0 inline-block h-1/2 w-full"
              style={{ borderLeft: "1px solid hsl(var(--border))" }}
            />
            <span
              className="absolute left-0 inline-block w-full"
              style={{ top: "50%", borderTop: "1px solid hsl(var(--border))" }}
            />
            {/* Hide the rest of the vertical line when this is the last sibling */}
            {!isLast && (
              <span
                className="absolute left-0 top-1/2 inline-block h-1/2 w-full"
                style={{ borderLeft: "1px solid hsl(var(--border))" }}
              />
            )}
          </span>
        )}

        {/* Caret */}
        {hasChildren ? (
          <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground hover:text-foreground">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Icon */}
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />

        {/* Label + meta */}
        <span className="font-medium" style={{ color }}>
          {node.label}
        </span>
        {node.meta && (
          <span className="ml-2 truncate text-[10px] text-muted-foreground">
            {node.meta.length > 80 ? node.meta.slice(0, 80) + "…" : node.meta}
          </span>
        )}
        {hasChildren && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {node.children!.length}
          </span>
        )}
      </div>

      {hasChildren && open && (
        <div>
          {node.children!.map((c, i) => (
            <TreeNodeRow
              key={c.id}
              node={c}
              depth={depth + 1}
              isLast={i === node.children!.length - 1}
              parentPrefix={[...parentPrefix, !isLast]}
              query={query}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeView({ data, query }: { data: unknown; query: string }) {
  const tree = useMemo(() => buildTreeFromScan(data), [data]);
  return <TreeNodeRow node={tree} depth={0} isLast parentPrefix={[]} query={query} />;
}

/** Recursive JSON tree node. */
function JsonNode({
  k,
  value,
  depth,
  path,
  defaultOpen,
  query,
}: {
  k: string;
  value: unknown;
  depth: number;
  path: string;
  defaultOpen?: boolean;
  query: string;
}) {
  const isObject = value !== null && typeof value === "object";
  const isArray = Array.isArray(value);
  const [open, setOpen] = useState(defaultOpen ?? depth < 2);

  // Hide branches that don't match the search at all.
  if (query.trim().length > 0) {
    const haystack = (path + " " + JSON.stringify(value ?? "")).toLowerCase();
    if (!haystack.includes(query.toLowerCase())) return null;
  }

  const entries = isObject
    ? isArray
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];

  const valuePreview = !isObject
    ? renderPrimitive(value)
    : isArray
      ? `[${(value as unknown[]).length}]`
      : `{${entries.length}}`;

  const colorize = isArray
    ? "text-[#7dd3fc]"
    : isObject
      ? "text-[#fda4af]"
      : typeof value === "string"
        ? "text-[#86efac]"
        : typeof value === "number"
          ? "text-[#fcd34d]"
          : "text-muted-foreground";

  return (
    <div className="font-mono text-xs leading-relaxed">
      <div
        className={cn(
          "flex cursor-pointer items-start gap-1 rounded px-1 hover:bg-secondary/50",
          isObject && "cursor-pointer",
        )}
        style={{ paddingLeft: depth * 12 }}
        onClick={() => isObject && setOpen((v) => !v)}
      >
        {isObject ? (
          open ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-muted-foreground">{k}</span>
        <span className="text-muted-foreground">:</span>
        <span className={colorize}>{valuePreview}</span>
        {isArray && entries.length > 0 && (
          <Badge variant="outline" className="ml-1 text-[9px]">
            {entries.length} items
          </Badge>
        )}
      </div>

      {isObject && open && (
        <div>
          {entries.map(([childKey, childValue]) => (
            <JsonNode
              key={path + "/" + childKey}
              k={childKey}
              value={childValue}
              depth={depth + 1}
              path={path + "/" + childKey}
              defaultOpen={defaultOpen}
              query={query}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function renderPrimitive(v: unknown): string {
  if (typeof v === "string") return `"${v.length > 60 ? v.slice(0, 60) + "…" : v}"`;
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/* ====== Page ====== */

/* ============================================================ */
/*  App map — inverted tree on an infinite dotted canvas          */
/* ============================================================ */

const NODE_KIND_STYLE: Record<TreeNode["kind"], { ring: string; dot: string; Icon: React.ComponentType<{ className?: string }> }> = {
  root: { ring: "border-primary/60 bg-primary/10", dot: "bg-primary", Icon: Globe },
  section: { ring: "border-border bg-card", dot: "bg-muted-foreground", Icon: Folder },
  page: { ring: "border-sky-500/50 bg-sky-500/5", dot: "bg-sky-400", Icon: FileCode },
  route: { ring: "border-violet-500/50 bg-violet-500/5", dot: "bg-violet-400", Icon: Link2 },
  element: { ring: "border-emerald-500/50 bg-emerald-500/5", dot: "bg-emerald-400", Icon: MousePointerClick },
  intent: { ring: "border-amber-500/50 bg-amber-500/5", dot: "bg-amber-400", Icon: Sparkles },
  summary: { ring: "border-border bg-card", dot: "bg-muted-foreground", Icon: FileText },
};

interface AppNodeData { label: string; meta?: string; kind: TreeNode["kind"]; hasChildren: boolean; expanded: boolean; count: number }

function AppMapNode({ data }: NodeProps<AppNodeData>) {
  const s = NODE_KIND_STYLE[data.kind] ?? NODE_KIND_STYLE.element;
  return (
    <div className={cn("w-[176px] rounded-lg border px-2.5 py-1.5 shadow-sm", s.ring, data.hasChildren && "cursor-pointer")}>
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className="flex items-center gap-1.5">
        <s.Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12px] font-medium">{data.label}</span>
        {data.hasChildren && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-secondary/70 px-1 text-[10px] tabular-nums text-muted-foreground">
            {data.count}
            {data.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        )}
      </div>
      {data.meta && <div className="mt-0.5 truncate pl-5 font-mono text-[10px] text-muted-foreground">{data.meta}</div>}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  );
}

const APP_MAP_NODE_TYPES = { appNode: AppMapNode };

// Tidy top-down layout over the *expanded* subtree: leaves get sequential x,
// parents centre over their children. Collapsed nodes hide their descendants.
function layoutTree(root: TreeNode, expanded: Set<string>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const X_GAP = 190, Y_GAP = 96, MAX_NODES = 800;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let leaf = 0;
  let count = 0;

  function walk(node: TreeNode, depth: number, parentId: string | null): number | null {
    if (count >= MAX_NODES) return null;
    const id = node.id;
    count++;
    const allKids = node.children ?? [];
    const isOpen = expanded.has(id);
    const kids = isOpen ? allKids : [];
    let x: number;
    if (kids.length === 0) {
      x = leaf * X_GAP; leaf++;
    } else {
      const xs = kids.map((c) => walk(c, depth + 1, id)).filter((v): v is number => v != null);
      x = xs.length ? (xs[0]! + xs[xs.length - 1]!) / 2 : (leaf++ * X_GAP);
    }
    nodes.push({
      id,
      type: "appNode",
      position: { x, y: depth * Y_GAP },
      data: { label: node.label, meta: node.meta, kind: node.kind, hasChildren: allKids.length > 0, expanded: isOpen, count: allKids.length },
      draggable: true,
    });
    if (parentId) edges.push({ id: `e-${parentId}-${id}`, source: parentId, target: id, type: "smoothstep" });
    return x;
  }
  walk(root, 0, null);
  return { nodes, edges };
}

function AppMapCanvas({ data }: { data: unknown }) {
  const root = useMemo(() => buildTreeFromScan(data), [data]);
  // Start collapsed: only the root is expanded (the tree is not fully deployed).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["root"]));
  const { nodes, edges } = useMemo(() => layoutTree(root, expanded), [root, expanded]);

  const onNodeClick = useCallback((_: unknown, node: FlowNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={APP_MAP_NODE_TYPES}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.1}
      maxZoom={2.5}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      className="!bg-background"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="!bg-background" />
      <Controls className="!border-border !bg-card" showInteractive={false} />
    </ReactFlow>
  );
}

interface RepoOpt { id: string; full_name: string; private: boolean; default_branch: string | null }

export function OnboardingTreePage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"tree" | "json" | "raw">("tree");
  const [scope, setScope] = useState<"all" | "raw" | "enriched">("all");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [repoName, setRepoName] = useState<string>("");
  const toast = useToast();

  const { data: scan, isLoading } = useQuery({
    queryKey: ["onb_tree_scan", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, created_at, app_structure, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as unknown as ScanRow | null;
    },
  });

  // Tracked repos the map can be built from.
  const { data: repos } = useQuery({
    queryKey: ["onb_tree_repos", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("repositories")
        .select("id, full_name, private, default_branch")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as RepoOpt[];
    },
  });

  // Scan the chosen repo → build the raw app structure → enrich into the map.
  async function scan_() {
    if (!workspaceId || !projectId) return;
    const list = repos ?? [];
    const repo = list.find((r) => r.full_name === repoName) ?? list[0];
    if (!repo) {
      toast.error("Aucun dépôt connecté — connectez-en un dans le module Dépôts.");
      return;
    }
    setScanning(true);
    try {
      await callEdge("repo-scan", {
        workspace_id: workspaceId, project_id: projectId,
        github_repo: {
          full_name: repo.full_name, name: repo.full_name.split("/").pop(),
          private: repo.private, default_branch: repo.default_branch ?? "main",
        },
      });
      // Enrich into the semantic map the agent uses (best-effort).
      try { await callEdge("enrich-app-structure", { workspace_id: workspaceId, project_id: projectId }); }
      catch { /* enrichment is optional; the raw scan is still usable */ }
      await queryClient.invalidateQueries({ queryKey: ["onb_tree_scan", projectId] });
      toast.success("Carte de l'app générée");
    } catch (e) {
      toast.error("Scan impossible : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setScanning(false);
    }
  }

  const tree = useMemo(() => {
    const struct = (scan?.app_structure ?? {}) as {
      pages?: unknown[];
      routes?: string[];
      element_count?: number;
      enriched?: Record<string, unknown>;
      enriched_at?: string;
    };
    if (scope === "raw") {
      return { pages: struct.pages, routes: struct.routes, element_count: struct.element_count };
    }
    if (scope === "enriched") {
      return struct.enriched ?? {};
    }
    return struct;
  }, [scan, scope]);

  const stats = useMemo(() => {
    const struct = (scan?.app_structure ?? {}) as {
      pages?: unknown[];
      routes?: string[];
      element_count?: number;
      enriched?: { pages?: unknown[] };
    };
    return {
      pages: (struct.pages ?? []).length,
      routes: (struct.routes ?? []).length,
      elements: struct.element_count ?? 0,
      enrichedPages: (struct.enriched?.pages ?? []).length,
      hasEnriched: !!struct.enriched,
    };
  }, [scan]);

  async function copyJson() {
    if (!tree) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(tree, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      toast.success("JSON copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  const hasStructure = !!scan?.app_structure && Object.keys(scan.app_structure).length > 0;

  return (
    <div>
      <PageHeader
        title="Carte de l'app"
        description="Scannez le dépôt pour construire la carte de votre app — l'agent d'onboarding s'en sert pour guider les utilisateurs."
        actions={
          <div className="flex items-center gap-2">
            {(repos ?? []).length > 1 && (
              <Select value={repoName || (repos?.[0]?.full_name ?? "")} onValueChange={setRepoName}>
                <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder="Dépôt" /></SelectTrigger>
                <SelectContent>
                  {(repos ?? []).map((r) => <SelectItem key={r.id} value={r.full_name}>{r.full_name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Button size="sm" onClick={scan_} disabled={scanning || !(repos ?? []).length}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
              {hasStructure ? "Re-scanner" : "Scanner le repo"}
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Chargement…" />
      ) : !(repos ?? []).length ? (
        <EmptyState
          icon={GitBranch}
          title="Aucun dépôt connecté"
          description="Connectez un dépôt dans le module Dépôts, puis revenez ici pour générer la carte."
        />
      ) : !hasStructure ? (
        <EmptyState
          icon={Radar}
          title="Pas encore de carte"
          description="Cliquez « Scanner le repo » — l'app sera analysée et sa structure (pages, routes, éléments) cartographiée."
        />
      ) : (
        /* Map card — click to open the tree full-screen. */
        <button type="button" onClick={() => setFullscreen(true)} className="group block w-full text-left">
          <Card className="transition-colors hover:border-primary/40">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                    <Network className="h-5 w-5 text-primary" />
                  </span>
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      Carte de l'app
                      {stats.hasEnriched
                        ? <Badge variant="success" className="text-[10px]">enrichie</Badge>
                        : <Badge variant="outline" className="text-[10px] text-amber-400">brute</Badge>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3 w-3" />{scan?.repositories?.full_name ?? "scan"}</span>
                      <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{scan ? new Date(scan.created_at).toLocaleString() : ""}</span>
                    </div>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-foreground">
                  <Maximize2 className="h-3.5 w-3.5" /> Plein écran
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile label="Pages" value={stats.pages} icon={FileCode} />
                <StatTile label="Routes" value={stats.routes} icon={Network} />
                <StatTile label="Éléments UI" value={stats.elements} icon={MousePointerClick} />
                <StatTile
                  label="Pages enrichies"
                  value={stats.enrichedPages}
                  icon={Sparkles}
                  hint={stats.hasEnriched ? "Carte sémantique IA" : "Enrichissement requis"}
                  dim={!stats.hasEnriched}
                />
              </div>
            </CardContent>
          </Card>
        </button>
      )}

      {/* Fullscreen app map — pure dotted canvas, nothing else. */}
      {fullscreen && hasStructure && (
        <div className="fixed inset-0 z-[100] bg-background">
          <AppMapCanvas data={tree} />
          <button
            type="button"
            onClick={() => setFullscreen(false)}
            className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" /> Fermer
          </button>
        </div>
      )}
    </div>
  );
}

/* ====== Helpers ====== */

function StatTile({
  label,
  value,
  icon: Icon,
  hint,
  dim,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  hint?: string;
  dim?: boolean;
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card/60 p-4", dim && "opacity-60")}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="font-stat-number mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function ScopeBtn({ active, onClick, children, disabled }: { active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded px-2 py-1 transition-colors",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
        disabled && "opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function ViewBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
