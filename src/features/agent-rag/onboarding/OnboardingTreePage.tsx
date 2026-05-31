import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
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

export function OnboardingTreePage() {
  const { projectId } = useCurrentContext();
  const [view, setView] = useState<"tree" | "json" | "raw">("tree");
  const [scope, setScope] = useState<"all" | "raw" | "enriched">("all");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
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

  return (
    <div>
      <PageHeader
        title="App structure tree"
        description="Browse the SaaS structure extracted from the latest code scan as an explorable JSON tree."
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-[10px]">
              <ScopeBtn active={scope === "all"} onClick={() => setScope("all")}>All</ScopeBtn>
              <ScopeBtn active={scope === "raw"} onClick={() => setScope("raw")}>Raw</ScopeBtn>
              <ScopeBtn active={scope === "enriched"} onClick={() => setScope("enriched")} disabled={!stats.hasEnriched}>
                Enriched
              </ScopeBtn>
            </div>
            <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-[10px]">
              <ViewBtn active={view === "tree"} onClick={() => setView("tree")}>
                <FolderTree className="h-3 w-3" /> Tree
              </ViewBtn>
              <ViewBtn active={view === "json"} onClick={() => setView("json")}>
                <FileCode className="h-3 w-3" /> JSON
              </ViewBtn>
              <ViewBtn active={view === "raw"} onClick={() => setView("raw")}>
                <FileJson className="h-3 w-3" /> Raw
              </ViewBtn>
            </div>
            <Button size="sm" variant="outline" onClick={copyJson} disabled={!tree}>
              {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
              Copy
            </Button>
          </div>
        }
      />

      {/* Stats strip */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Pages scanned" value={stats.pages} icon={FileCode} />
        <StatTile label="Routes" value={stats.routes} icon={Network} />
        <StatTile label="UI elements" value={stats.elements} icon={Sparkles} />
        <StatTile
          label="Enriched pages"
          value={stats.enrichedPages}
          icon={Sparkles}
          hint={stats.hasEnriched ? "AI semantic map" : "Run enrichment first"}
          dim={!stats.hasEnriched}
        />
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !scan ? (
        <EmptyState
          icon={AlertCircle}
          title="No scan available"
          description="Run a code scan in Code → Repositories to capture the SaaS structure."
        />
      ) : !scan.app_structure || Object.keys(scan.app_structure).length === 0 ? (
        <EmptyState
          icon={AlertCircle}
          title="Scan has no app structure"
          description="The latest scan didn't capture pages or routes. Re-run a scan."
        />
      ) : (
        <>
          {/* Source hint */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-mono text-[10px]">
              {scan.repositories?.full_name ?? "scan"}
            </Badge>
            <span>Scanned {new Date(scan.created_at).toLocaleString()}</span>
          </div>

          {/* Search */}
          {view !== "raw" && (
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={view === "tree" ? "Search nodes (name, route, label)…" : "Search the JSON (key, value, path)…"}
                className="pl-8"
              />
            </div>
          )}

          <Card>
            <CardContent className="p-3">
              {view === "tree" ? (
                <div className="max-h-[70vh] overflow-auto rounded bg-secondary/30 p-4">
                  <TreeView data={tree} query={search} />
                </div>
              ) : view === "json" ? (
                <div className="max-h-[60vh] overflow-y-auto rounded bg-secondary/30 p-3">
                  <JsonNode
                    k="app_structure"
                    value={tree}
                    depth={0}
                    path=""
                    defaultOpen
                    query={search}
                  />
                </div>
              ) : (
                <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded bg-secondary/30 p-3 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(tree, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        </>
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
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
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
