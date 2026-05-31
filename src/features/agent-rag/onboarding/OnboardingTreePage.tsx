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
  const [view, setView] = useState<"tree" | "raw">("tree");
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
          {view === "tree" && (
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the tree (key, value, path)…"
                className="pl-8"
              />
            </div>
          )}

          <Card>
            <CardContent className="p-3">
              {view === "tree" ? (
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
