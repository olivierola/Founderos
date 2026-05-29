import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Table2,
  Play,
  Loader2,
  Plus,
  Trash2,
  Filter,
  Settings2,
  RefreshCw,
  Save,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { ExportMenu } from "@/components/ExportMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { callEdge } from "@/lib/edge";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  is_pk?: boolean;
}
interface TableDef {
  name: string;
  columns: Column[];
}
interface DetectResult {
  configured: boolean;
  provider: string | null;
  crud_ready: boolean;
  project_url: string | null;
}

export function DatabaseConsolePage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId, loading } = useCurrentContext();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"browse" | "query">("browse");
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteRow, setDeleteRow] = useState<{ pkCol: string; pkVal: string } | null>(null);

  const detect = useQuery({
    queryKey: ["dbc-detect", projectId],
    enabled: !!projectId,
    queryFn: async () =>
      callEdge<DetectResult>("db-admin", { workspace_id: workspaceId, project_id: projectId, op: "detect" }),
  });

  const provider = detect.data?.provider;
  const crudReady = detect.data?.crud_ready;

  const tablesQuery = useQuery({
    queryKey: ["dbc-tables", projectId],
    enabled: !!projectId && !!crudReady,
    queryFn: async () => {
      const res = await callEdge<{ tables: TableDef[] }>("db-admin", {
        workspace_id: workspaceId,
        project_id: projectId,
        op: "list_tables",
      });
      return res.tables;
    },
  });

  useEffect(() => {
    if (!activeTable && tablesQuery.data?.length) setActiveTable(tablesQuery.data[0]!.name);
  }, [tablesQuery.data, activeTable]);

  const rowsQuery = useQuery({
    queryKey: ["dbc-rows", projectId, activeTable],
    enabled: !!projectId && !!crudReady && !!activeTable && tab === "browse",
    queryFn: async () => {
      const res = await callEdge<{ rows: Record<string, unknown>[] }>("db-admin", {
        workspace_id: workspaceId,
        project_id: projectId,
        op: "list_rows",
        table: activeTable,
        limit: 50,
      });
      return res.rows;
    },
  });

  const currentTableDef = useMemo(
    () => tablesQuery.data?.find((t) => t.name === activeTable) ?? null,
    [tablesQuery.data, activeTable],
  );
  const pkCol = currentTableDef?.columns.find((c) => c.is_pk)?.name ?? "id";
  const browseCols = rowsQuery.data && rowsQuery.data.length > 0 ? Object.keys(rowsQuery.data[0]!) : [];

  if (loading || detect.isLoading) {
    return (
      <div>
        <PageHeader title="Database Console" description="Browse and query your connected database — no SQL." />
        <EmptyState icon={Loader2} title="Checking database connection…" />
      </div>
    );
  }

  // Not configured / unsupported provider → adaptive guidance
  if (!detect.data?.configured || !crudReady) {
    const label = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : null;
    return (
      <div>
        <PageHeader title="Database Console" description="Browse and query your connected database — no SQL." />
        {provider && !crudReady ? (
          <EmptyState
            icon={Database}
            title={`${label} detected — CRUD not available yet`}
            description={`Your project uses ${label}. Visual browsing currently supports Supabase. ${label} read/write support is on the way.`}
          />
        ) : (
          <EmptyState
            icon={Database}
            title="Connect a database"
            description="Add your Supabase project URL + service role key to browse tables, run visual queries and edit data — no SQL required."
            action={
              <Button
                onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/integrations/catalog?connect=supabase`)}
              >
                <Settings2 className="h-4 w-4" /> Configure database
              </Button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Database Console"
        description={`Connected via ${provider} · ${detect.data.project_url}`}
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["dbc-tables", projectId] });
                queryClient.invalidateQueries({ queryKey: ["dbc-rows", projectId] });
              }}
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            {tab === "browse" && activeTable && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" /> Add row
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex gap-2">
        <Button size="sm" variant={tab === "browse" ? "default" : "outline"} onClick={() => setTab("browse")}>
          <Table2 className="h-4 w-4" /> Browse
        </Button>
        <Button size="sm" variant={tab === "query" ? "default" : "outline"} onClick={() => setTab("query")}>
          <Filter className="h-4 w-4" /> Query builder
        </Button>
      </div>

      <div className="flex gap-4">
        <aside className="w-52 shrink-0">
          <Card>
            <CardContent className="max-h-[65vh] overflow-y-auto p-2">
              {tablesQuery.isLoading ? (
                <div className="p-2 text-sm text-muted-foreground">Loading…</div>
              ) : (
                (tablesQuery.data ?? []).map((t) => (
                  <button
                    key={t.name}
                    onClick={() => setActiveTable(t.name)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
                      activeTable === t.name ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/50",
                    )}
                  >
                    <Table2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate font-mono text-xs">{t.name}</span>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </aside>

        <div className="min-w-0 flex-1">
          {tab === "browse" ? (
            <BrowseTable
              rows={rowsQuery.data}
              loading={rowsQuery.isLoading}
              columns={browseCols}
              pkCol={pkCol}
              onDeleteRow={(pkVal) => setDeleteRow({ pkCol, pkVal })}
            />
          ) : (
            <QueryBuilder
              table={currentTableDef}
              workspaceId={workspaceId!}
              projectId={projectId!}
            />
          )}
        </div>
      </div>

      {currentTableDef && (
        <AddRowDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          table={currentTableDef}
          onSubmit={async (values) => {
            await callEdge("db-admin", {
              workspace_id: workspaceId,
              project_id: projectId,
              op: "insert_row",
              table: currentTableDef.name,
              values,
            });
            queryClient.invalidateQueries({ queryKey: ["dbc-rows", projectId, activeTable] });
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteRow}
        onOpenChange={(o) => !o && setDeleteRow(null)}
        title="Delete row"
        description={`Delete the row where ${deleteRow?.pkCol} = ${deleteRow?.pkVal}? This cannot be undone.`}
        confirmText="Delete row"
        onConfirm={async () => {
          if (!deleteRow || !activeTable) return;
          await callEdge("db-admin", {
            workspace_id: workspaceId,
            project_id: projectId,
            op: "delete_row",
            table: activeTable,
            pk_col: deleteRow.pkCol,
            pk_val: deleteRow.pkVal,
          });
          queryClient.invalidateQueries({ queryKey: ["dbc-rows", projectId, activeTable] });
        }}
      />
    </div>
  );
}

function BrowseTable({
  rows,
  loading,
  columns,
  pkCol,
  onDeleteRow,
}: {
  rows: Record<string, unknown>[] | undefined;
  loading: boolean;
  columns: string[];
  pkCol: string;
  onDeleteRow: (pkVal: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading rows…</div>
        ) : !rows || rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No rows in this table.</div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs text-muted-foreground">{rows.length} rows</span>
              <ExportMenu rows={rows} filename="table-rows" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-border text-left uppercase tracking-wider text-muted-foreground">
                  <tr>
                    {columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>
                    ))}
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row, i) => (
                    <tr key={i} className="hover:bg-secondary/30">
                      {columns.map((c) => (
                        <td key={c} className="max-w-[240px] truncate px-3 py-2 font-mono">
                          {typeof row[c] === "object" ? JSON.stringify(row[c]) : String(row[c] ?? "")}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => onDeleteRow(String(row[pkCol] ?? ""))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface FilterRow {
  column: string;
  op: string;
  value: string;
}
interface SortRow {
  column: string;
  dir: "asc" | "desc";
}
interface AggRow {
  fn: string;
  column: string;
}
interface QuerySpec {
  columns: string[];
  filters: FilterRow[];
  sorts: SortRow[];
  groupBy: string[];
  aggregates: AggRow[];
  limit: string;
}

const FILTER_OPS_2 = ["=", "!=", ">", ">=", "<", "<=", "contains", "starts_with", "is_null"] as const;
const AGG_FNS = ["count", "sum", "avg", "min", "max"] as const;

function QueryBuilder({
  table,
  workspaceId,
  projectId,
}: {
  table: TableDef | null;
  workspaceId: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [sorts, setSorts] = useState<SortRow[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [aggregates, setAggregates] = useState<AggRow[]>([]);
  const [limit, setLimit] = useState("50");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [sqlPreview, setSqlPreview] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const cols = table?.columns ?? [];
  const aggMode = aggregates.length > 0;

  // Reset builder when table changes
  useEffect(() => {
    setSelectedCols([]); setFilters([]); setSorts([]); setGroupBy([]); setAggregates([]);
    setRows(null); setSqlPreview(null); setPage(0);
  }, [table?.name]);

  const savedQueries = useQuery({
    queryKey: ["saved-queries", projectId, table?.name],
    enabled: !!projectId && !!table,
    queryFn: async () => {
      const { data } = await supabase
        .from("saved_queries")
        .select("id, name, spec")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      return (data ?? []).filter((q: any) => q.spec?.table === table?.name);
    },
  });

  async function run(pageOverride?: number) {
    if (!table) return;
    const p = pageOverride ?? page;
    setRunning(true);
    setError(null);
    try {
      const res = await callEdge<{ rows: Record<string, unknown>[]; query: string }>("db-admin", {
        workspace_id: workspaceId,
        project_id: projectId,
        op: "query",
        table: table.name,
        columns: selectedCols,
        filters: filters.filter((f) => f.column && f.op),
        sorts: sorts.filter((s) => s.column),
        group_by: aggMode ? groupBy : [],
        aggregates: aggregates.filter((a) => a.fn),
        limit: Number(limit) || 50,
        offset: p * (Number(limit) || 50),
      });
      setRows(res.rows ?? []);
      setSqlPreview(res.query ?? null);
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function loadSpec(spec: QuerySpec) {
    setSelectedCols(spec.columns ?? []);
    setFilters(spec.filters ?? []);
    setSorts(spec.sorts ?? []);
    setGroupBy(spec.groupBy ?? []);
    setAggregates(spec.aggregates ?? []);
    setLimit(spec.limit ?? "50");
  }

  async function saveCurrent(name: string) {
    if (!table) return;
    await supabase.from("saved_queries").insert({
      workspace_id: workspaceId,
      project_id: projectId,
      name,
      spec: { table: table.name, columns: selectedCols, filters, sorts, groupBy, aggregates, limit },
    });
    queryClient.invalidateQueries({ queryKey: ["saved-queries", projectId, table.name] });
  }

  if (!table) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Select a table on the left.</CardContent>
      </Card>
    );
  }

  const resultCols = rows && rows.length > 0 ? Object.keys(rows[0]!) : [];
  const lim = Number(limit) || 50;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Query <span className="font-mono text-primary">{table.name}</span>
            </div>
            {savedQueries.data && savedQueries.data.length > 0 && (
              <select
                onChange={(e) => {
                  const q = savedQueries.data!.find((x: any) => x.id === e.target.value);
                  if (q) loadSpec(q.spec as QuerySpec);
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                defaultValue=""
              >
                <option value="">Load saved query…</option>
                {savedQueries.data.map((q: any) => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Aggregations */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Aggregations</span>
              <Button size="sm" variant="ghost" onClick={() => setAggregates([...aggregates, { fn: "count", column: "" }])}>
                <Plus className="h-3.5 w-3.5" /> Add aggregate
              </Button>
            </div>
            <div className="space-y-2">
              {aggregates.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={a.fn}
                    onChange={(e) => setAggregates(aggregates.map((x, j) => (j === i ? { ...x, fn: e.target.value } : x)))}
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {AGG_FNS.map((fn) => <option key={fn} value={fn}>{fn}</option>)}
                  </select>
                  <select
                    value={a.column}
                    onChange={(e) => setAggregates(aggregates.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
                    className="h-9 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
                  >
                    <option value="">{a.fn === "count" ? "(rows)" : "select column"}</option>
                    {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                  <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setAggregates(aggregates.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {aggMode && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Group by</div>
                  <div className="flex flex-wrap gap-1.5">
                    {cols.map((c) => {
                      const on = groupBy.includes(c.name);
                      return (
                        <button
                          key={c.name}
                          onClick={() => setGroupBy((p) => (on ? p.filter((x) => x !== c.name) : [...p, c.name]))}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors",
                            on ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                          )}
                        >
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Columns (only in non-agg mode) */}
          {!aggMode && (
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">Columns (none = all)</div>
              <div className="flex flex-wrap gap-1.5">
                {cols.map((c) => {
                  const on = selectedCols.includes(c.name);
                  return (
                    <button
                      key={c.name}
                      onClick={() => setSelectedCols((p) => (on ? p.filter((x) => x !== c.name) : [...p, c.name]))}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors",
                        on ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Filters */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Filters (where)</span>
              <Button size="sm" variant="ghost" onClick={() => setFilters([...filters, { column: cols[0]?.name ?? "", op: "=", value: "" }])}>
                <Plus className="h-3.5 w-3.5" /> Add filter
              </Button>
            </div>
            <div className="space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={f.column}
                    onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
                    className="h-9 rounded-md border border-input bg-background px-2 font-mono text-xs"
                  >
                    {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                  <select
                    value={f.op}
                    onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {FILTER_OPS_2.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {f.op !== "is_null" && (
                    <Input
                      value={f.value}
                      onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      placeholder="value"
                      className="h-9 flex-1"
                    />
                  )}
                  <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {filters.length === 0 && <p className="text-xs text-muted-foreground">No filters — returns all rows.</p>}
            </div>
          </div>

          {/* Multi-sort */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Sort</span>
              <Button size="sm" variant="ghost" onClick={() => setSorts([...sorts, { column: cols[0]?.name ?? "", dir: "desc" }])}>
                <Plus className="h-3.5 w-3.5" /> Add sort
              </Button>
            </div>
            <div className="space-y-2">
              {sorts.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={s.column}
                    onChange={(e) => setSorts(sorts.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
                    className="h-9 rounded-md border border-input bg-background px-2 font-mono text-xs"
                  >
                    {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                  <select
                    value={s.dir}
                    onChange={(e) => setSorts(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="desc">desc</option>
                    <option value="asc">asc</option>
                  </select>
                  <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setSorts(sorts.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {sorts.length === 0 && <p className="text-xs text-muted-foreground">No sort.</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Page size</div>
              <Input value={limit} onChange={(e) => setLimit(e.target.value)} type="number" className="h-9 w-24" />
            </div>
            <Button onClick={() => run(0)} disabled={running}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run query
            </Button>
            <Button variant="outline" onClick={() => setSaveOpen(true)}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}

          {sqlPreview && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Generated query (PostgREST)</div>
              <pre className="overflow-x-auto rounded-md border border-border bg-background/40 p-3 text-xs text-muted-foreground">
                GET /{sqlPreview}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {rows && (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs text-muted-foreground">
                {rows.length} rows {page > 0 ? `· page ${page + 1}` : ""}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" disabled={page === 0 || running} onClick={() => run(page - 1)}>
                  Prev
                </Button>
                <Button size="sm" variant="ghost" disabled={rows.length < lim || running} onClick={() => run(page + 1)}>
                  Next
                </Button>
                <ExportMenu rows={rows} filename={`query-${table.name}`} />
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No rows match.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b border-border text-left uppercase tracking-wider text-muted-foreground">
                    <tr>
                      {resultCols.map((c) => (
                        <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((r, i) => (
                      <tr key={i} className="hover:bg-secondary/30">
                        {resultCols.map((c) => (
                          <td key={c} className="max-w-[240px] truncate px-3 py-2 font-mono">
                            {typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <SaveQueryDialog open={saveOpen} onOpenChange={setSaveOpen} onSave={saveCurrent} />
    </div>
  );
}

function SaveQueryDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save query</DialogTitle>
          <DialogDescription>Reuse this query later from the dropdown.</DialogDescription>
        </DialogHeader>
        <Input placeholder="Query name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(name);
                setName("");
                onOpenChange(false);
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || !name.trim()}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddRowDialog({
  open,
  onOpenChange,
  table,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  table: TableDef;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues({});
      setError(null);
    }
  }, [open]);

  const editable = table.columns.filter((c) => !(c.is_pk && /uuid|int/.test(c.type)));

  async function handle() {
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === "") continue;
        const col = table.columns.find((c) => c.name === k);
        if (col && /int|numeric|float|double/.test(col.type)) payload[k] = Number(v);
        else if (col && col.type === "boolean") payload[k] = v === "true";
        else payload[k] = v;
      }
      await onSubmit(payload);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add row to {table.name}</DialogTitle>
          <DialogDescription>Fill the fields. Leave optional fields empty to use defaults.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {editable.map((col) => (
            <div key={col.name} className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{col.name}</span>
                <span className="text-[10px]">{col.type}</span>
                {!col.nullable && <span className="text-destructive">required</span>}
              </label>
              <Input
                value={values[col.name] ?? ""}
                placeholder={col.type === "boolean" ? "true / false" : col.type}
                onChange={(e) => setValues({ ...values, [col.name]: e.target.value })}
              />
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handle} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Insert row
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
