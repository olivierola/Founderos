import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderGit2,
  Plus,
  Loader2,
  ArrowLeft,
  Boxes,
  MoreVertical,
  Pencil,
  Trash2,
  GitBranch,
  ScanLine,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { useProjects, createProject, renameProject, deleteProject } from "@/hooks/useWorkspace";

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  health_score: number;
  created_at: string;
}

export function ProjectsPage() {
  const { workspaceSlug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRow | null>(null);

  const { data: ws, isLoading: wsLoading } = useQuery({
    queryKey: ["workspace-by-slug", workspaceSlug],
    enabled: !!workspaceSlug,
    queryFn: async () => {
      const { data } = await supabase
        .from("workspaces")
        .select("id, name, slug, plan")
        .eq("slug", workspaceSlug!)
        .maybeSingle();
      return data;
    },
  });

  const { data: projects, isLoading: projLoading } = useProjects(ws?.id ?? null);

  const projectIds = useMemo(() => (projects ?? []).map((p: ProjectRow) => p.id), [projects]);
  const { data: counts } = useQuery({
    queryKey: ["project-counts", [...projectIds].sort()],
    enabled: projectIds.length > 0,
    queryFn: async () => {
      const out: Record<string, { repos: number; scans: number }> = {};
      await Promise.all(
        projectIds.map(async (id) => {
          const [{ count: repos }, { count: scans }] = await Promise.all([
            supabase.from("repositories").select("id", { count: "exact", head: true }).eq("project_id", id),
            supabase.from("scan_results").select("id", { count: "exact", head: true }).eq("project_id", id),
          ]);
          out[id] = { repos: repos ?? 0, scans: scans ?? 0 };
        }),
      );
      return out;
    },
  });

  function refresh() {
    if (ws) queryClient.invalidateQueries({ queryKey: ["projects", ws.id] });
    queryClient.invalidateQueries({ queryKey: ["project-counts"] });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/orgs")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold">{ws?.name ?? workspaceSlug}</div>
            <div className="text-xs text-muted-foreground">Projects</div>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!ws}>
          <Plus className="h-4 w-4" /> New project
        </Button>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each project has its own cockpit: code scans, finance, costs, users and more.
        </p>

        <div className="mt-6">
          {wsLoading || projLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !projects || projects.length === 0 ? (
            <EmptyState
              icon={FolderGit2}
              title="No projects yet"
              description="Create your first project — connect a repo and we'll generate the cockpit."
              action={
                <Button onClick={() => setCreateOpen(true)} disabled={!ws}>
                  <Plus className="h-4 w-4" /> New project
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(projects as ProjectRow[]).map((p) => {
                const c = counts?.[p.id];
                const health = p.health_score ?? 0;
                return (
                  <Card
                    key={p.id}
                    className="group cursor-pointer transition-colors hover:border-primary/40"
                    onClick={() => navigate(`/app/${ws!.slug}/${p.slug}/actions/dashboard`)}
                  >
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="flex h-11 w-11 items-center justify-center rounded-md bg-secondary">
                          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setRenameTarget(p)}>
                                <Pencil className="h-4 w-4" /> Rename
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive onClick={() => setDeleteTarget(p)}>
                                <Trash2 className="h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      <div className="mt-4">
                        <div className="truncate font-semibold">{p.name}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{p.slug}</div>
                      </div>

                      <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <GitBranch className="h-3.5 w-3.5" /> {c?.repos ?? "—"} repos
                        </span>
                        <span className="flex items-center gap-1">
                          <ScanLine className="h-3.5 w-3.5" /> {c?.scans ?? "—"} scans
                        </span>
                      </div>

                      <div className="mt-3">
                        <Badge variant={health >= 70 ? "success" : health >= 40 ? "warning" : "secondary"}>
                          health {health}/100
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New project"
        label="Project name"
        placeholder="My SaaS"
        confirmText="Create"
        onSubmit={async (name) => {
          if (!ws) return;
          const p = await createProject(ws.id, name);
          refresh();
          navigate(`/app/${ws.slug}/${p.slug}/actions/dashboard`);
        }}
      />

      <PromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Rename project"
        label="New name"
        initialValue={renameTarget?.name ?? ""}
        confirmText="Rename"
        onSubmit={async (name) => {
          if (!renameTarget) return;
          await renameProject(renameTarget.id, name);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete project"
        description={`This permanently deletes "${deleteTarget?.name}" and all its scans, costs and metrics.`}
        typeToConfirm={deleteTarget?.slug}
        confirmText="Delete project"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteProject(deleteTarget.id);
          refresh();
        }}
      />
    </div>
  );
}
