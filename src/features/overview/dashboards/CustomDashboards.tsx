import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Plus, Loader2, MoreVertical, Pencil, Trash2, ChevronRight, Copy } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { PromptDialog } from "@/components/PromptDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface DashRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export function CustomDashboardsPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId, loading } = useCurrentContext();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DashRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DashRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["custom_dashboards", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("custom_dashboards")
        .select("id, name, description, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as DashRow[];
    },
  });

  // widget counts
  const { data: counts } = useQuery({
    queryKey: ["dashboard-widget-counts", (data ?? []).map((d) => d.id).sort()],
    enabled: !!data && data.length > 0,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(
        (data ?? []).map(async (d) => {
          const { count } = await supabase
            .from("dashboard_widgets")
            .select("id", { count: "exact", head: true })
            .eq("dashboard_id", d.id);
          out[d.id] = count ?? 0;
        }),
      );
      return out;
    },
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["custom_dashboards", projectId] });
  }

  async function duplicateDashboard(d: DashRow) {
    if (!workspaceId || !projectId) return;
    const { data: created } = await supabase
      .from("custom_dashboards")
      .insert({ workspace_id: workspaceId, project_id: projectId, name: `${d.name} (copy)`, description: d.description })
      .select()
      .single();
    if (!created) return;
    const { data: srcWidgets } = await supabase
      .from("dashboard_widgets")
      .select("type, title, config, position")
      .eq("dashboard_id", d.id);
    if (srcWidgets?.length) {
      await supabase.from("dashboard_widgets").insert(
        srcWidgets.map((w) => ({
          dashboard_id: created.id,
          workspace_id: workspaceId,
          type: w.type,
          title: w.title,
          config: w.config,
          position: w.position,
        })),
      );
    }
    refresh();
  }

  if (loading) return <PageHeader title="Custom Dashboards" />;

  return (
    <div>
      <PageHeader
        title="Custom Dashboards"
        description="Build your own dashboards — KPIs, charts, tables and notes from any data source."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New dashboard
          </Button>
        }
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No custom dashboards yet"
          description="Create a dashboard and start adding widgets — like Power BI, but inside your cockpit."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New dashboard
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((d) => (
            <Card
              key={d.id}
              className="group cursor-pointer transition-colors hover:border-primary/40"
              onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/overview/dashboard-builder/${d.id}`)}
            >
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex h-11 w-11 items-center justify-center rounded-md bg-secondary">
                    <LayoutGrid className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setRenameTarget(d)}>
                          <Pencil className="h-4 w-4" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => duplicateDashboard(d)}>
                          <Copy className="h-4 w-4" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onClick={() => setDeleteTarget(d)}>
                          <Trash2 className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <div className="mt-4">
                  <div className="truncate font-semibold">{d.name}</div>
                  {d.description && <div className="truncate text-xs text-muted-foreground">{d.description}</div>}
                </div>
                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{counts?.[d.id] ?? 0} widgets</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New dashboard"
        label="Name"
        placeholder="Growth overview"
        confirmText="Create"
        onSubmit={async (name) => {
          if (!workspaceId || !projectId) return;
          const { data: created } = await supabase
            .from("custom_dashboards")
            .insert({ workspace_id: workspaceId, project_id: projectId, name })
            .select()
            .single();
          refresh();
          if (created) navigate(`/app/${workspaceSlug}/${projectSlug}/overview/dashboard-builder/${created.id}`);
        }}
      />

      <PromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Rename dashboard"
        label="New name"
        initialValue={renameTarget?.name ?? ""}
        confirmText="Rename"
        onSubmit={async (name) => {
          if (!renameTarget) return;
          await supabase.from("custom_dashboards").update({ name }).eq("id", renameTarget.id);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete dashboard"
        description={`Delete "${deleteTarget?.name}" and all its widgets?`}
        confirmText="Delete"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await supabase.from("custom_dashboards").delete().eq("id", deleteTarget.id);
          refresh();
        }}
      />
    </div>
  );
}
