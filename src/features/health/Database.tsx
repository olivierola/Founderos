import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Table2,
  Users,
  Plus,
  Loader2,
  Trash2,
  Settings2,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import { callEdge } from "@/lib/edge";
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

export function DatabasePage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId, loading } = useCurrentContext();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"tables" | "users">("tables");
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [deleteRow, setDeleteRow] = useState<{ pkCol: string; pkVal: string } | null>(null);

  const detect = useQuery({
    queryKey: ["db-detect", projectId],
    enabled: !!projectId,
    queryFn: async () =>
      callEdge<{ configured: boolean; project_url: string | null }>("db-admin", {
        workspace_id: workspaceId,
        project_id: projectId,
        op: "detect",
      }),
  });

  const configured = detect.data?.configured;

  const tablesQuery = useQuery({
    queryKey: ["db-tables", projectId],
    enabled: !!projectId && !!configured,
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
    if (!activeTable && tablesQuery.data && tablesQuery.data.length > 0) {
      setActiveTable(tablesQuery.data[0]!.name);
    }
  }, [tablesQuery.data, activeTable]);

  const rowsQuery = useQuery({
    queryKey: ["db-rows", projectId, activeTable],
    enabled: !!projectId && !!configured && !!activeTable && tab === "tables",
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

  const usersQuery = useQuery({
    queryKey: ["db-users", projectId],
    enabled: !!projectId && !!configured && tab === "users",
    queryFn: async () => {
      const res = await callEdge<{ users: any[] }>("db-admin", {
        workspace_id: workspaceId,
        project_id: projectId,
        op: "list_users",
      });
      return res.users;
    },
  });

  const currentTableDef = useMemo(
    () => tablesQuery.data?.find((t) => t.name === activeTable) ?? null,
    [tablesQuery.data, activeTable],
  );

  const columns = rowsQuery.data && rowsQuery.data.length > 0 ? Object.keys(rowsQuery.data[0]!) : [];
  const pkCol = currentTableDef?.columns.find((c) => c.is_pk)?.name ?? "id";

  if (loading) {
    return (
      <div>
        <PageHeader title="Database" />
        <EmptyState icon={Loader2} title="Loading…" />
      </div>
    );
  }

  if (detect.isLoading) {
    return (
      <div>
        <PageHeader title="Database" description="Browse and edit your connected database without SQL." />
        <EmptyState icon={Loader2} title="Checking connection…" />
      </div>
    );
  }

  if (!configured) {
    return (
      <div>
        <PageHeader title="Database" description="Browse and edit your connected database without SQL." />
        <EmptyState
          icon={Database}
          title="Connect your database"
          description="Add your Supabase project URL + service role key in the Supabase connector to browse tables, add rows and manage users — no SQL required."
          action={
            <Button
              onClick={() =>
                navigate(`/app/${workspaceSlug}/${projectSlug}/integrations/catalog?connect=supabase`)
              }
            >
              <Settings2 className="h-4 w-4" /> Configure Supabase
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Database"
        description={`Connected to ${detect.data?.project_url ?? "your Supabase project"}.`}
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["db-tables", projectId] });
                queryClient.invalidateQueries({ queryKey: ["db-rows", projectId] });
                queryClient.invalidateQueries({ queryKey: ["db-users", projectId] });
              }}
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            {tab === "tables" && activeTable && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" /> Add row
              </Button>
            )}
            {tab === "users" && (
              <Button size="sm" onClick={() => setAddUserOpen(true)}>
                <Plus className="h-4 w-4" /> Add user
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex gap-2">
        <Button size="sm" variant={tab === "tables" ? "default" : "outline"} onClick={() => setTab("tables")}>
          <Table2 className="h-4 w-4" /> Tables
        </Button>
        <Button size="sm" variant={tab === "users" ? "default" : "outline"} onClick={() => setTab("users")}>
          <Users className="h-4 w-4" /> Auth users
        </Button>
      </div>

      {tab === "tables" ? (
        <div className="flex gap-4">
          {/* Table list */}
          <aside className="w-52 shrink-0">
            <Card>
              <CardContent className="max-h-[60vh] overflow-y-auto p-2">
                {tablesQuery.isLoading ? (
                  <div className="p-2 text-sm text-muted-foreground">Loading…</div>
                ) : (
                  (tablesQuery.data ?? []).map((t) => (
                    <button
                      key={t.name}
                      onClick={() => setActiveTable(t.name)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                        activeTable === t.name
                          ? "bg-sidebar-accent text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/50",
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

          {/* Rows */}
          <div className="min-w-0 flex-1">
            <Card>
              <CardContent className="p-0">
                {rowsQuery.isLoading ? (
                  <div className="p-6 text-sm text-muted-foreground">Loading rows…</div>
                ) : !rowsQuery.data || rowsQuery.data.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground">No rows in this table.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="border-b border-border text-left uppercase tracking-wider text-muted-foreground">
                        <tr>
                          {columns.map((c) => (
                            <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                              {c}
                            </th>
                          ))}
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {rowsQuery.data.map((row, i) => (
                          <tr key={i}>
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
                                onClick={() =>
                                  setDeleteRow({ pkCol, pkVal: String(row[pkCol] ?? "") })
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            {usersQuery.isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading users…</div>
            ) : !usersQuery.data || usersQuery.data.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No auth users.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Last sign-in</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {usersQuery.data.map((u: any) => (
                    <tr key={u.id}>
                      <td className="px-4 py-3 font-medium">{u.email}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "never"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={u.banned_until ? "destructive" : "success"}>
                          {u.banned_until ? "banned" : "active"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

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
            queryClient.invalidateQueries({ queryKey: ["db-rows", projectId, activeTable] });
          }}
        />
      )}

      <AddUserDialog
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        onSubmit={async (email, password) => {
          await callEdge("db-admin", {
            workspace_id: workspaceId,
            project_id: projectId,
            op: "create_user",
            email,
            password,
          });
          queryClient.invalidateQueries({ queryKey: ["db-users", projectId] });
        }}
      />

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
          queryClient.invalidateQueries({ queryKey: ["db-rows", projectId, activeTable] });
        }}
      />
    </div>
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

  // Skip identity/pk columns that are auto-generated
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
          <DialogDescription>Fill the fields below. Leave optional fields empty to use defaults.</DialogDescription>
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
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handle} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Insert row
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setPassword("");
      setError(null);
    }
  }, [open]);

  async function handle() {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(email, password);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create auth user</DialogTitle>
          <DialogDescription>Adds a confirmed user to your connected Supabase project.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            type="password"
            placeholder="password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handle} disabled={submitting || !email || password.length < 6}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Create user
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
