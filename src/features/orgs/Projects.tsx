import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon, CircleNotchIcon as Loader2, DotsThreeIcon, FolderIcon, GitBranchIcon,
  PencilSimpleIcon, PlusIcon, RobotIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PromptDialog } from "@/components/PromptDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import { useProjects, createProject, renameProject, deleteProject } from "@/hooks/useWorkspace";
import { MonoChip, Monogram, SectionLabel, SelectionTopBar } from "./chrome";

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
      const { data } = await supabase.from("workspaces").select("id, name, slug, plan").eq("slug", workspaceSlug!).maybeSingle();
      return data;
    },
  });

  const { data: projects, isLoading: projLoading } = useProjects(ws?.id ?? null);

  const projectIds = useMemo(() => (projects ?? []).map((p: ProjectRow) => p.id), [projects]);
  const { data: counts } = useQuery({
    queryKey: ["project-counts-v2", [...projectIds].sort()],
    enabled: projectIds.length > 0,
    queryFn: async () => {
      const out: Record<string, { repos: number; agents: number }> = {};
      await Promise.all(
        projectIds.map(async (id) => {
          const [{ count: repos }, { count: agents }, { count: publicAgents }] = await Promise.all([
            supabase.from("repositories").select("id", { count: "exact", head: true }).eq("project_id", id),
            supabase.from("internal_agents").select("id", { count: "exact", head: true }).eq("project_id", id).eq("is_archived", false),
            supabase.from("rag_agents").select("id", { count: "exact", head: true }).eq("project_id", id),
          ]);
          out[id] = { repos: repos ?? 0, agents: (agents ?? 0) + (publicAgents ?? 0) };
        }),
      );
      return out;
    },
  });

  function refresh() {
    if (ws) queryClient.invalidateQueries({ queryKey: ["projects", ws.id] });
    queryClient.invalidateQueries({ queryKey: ["project-counts-v2"] });
  }

  const list = (projects ?? []) as ProjectRow[];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SelectionTopBar
        crumbs={
          <>
            <button onClick={() => navigate("/orgs")} className="text-muted-foreground transition-colors hover:text-foreground">Organisations</button>
            <span className="text-muted-foreground/60">/</span>
            <span className="truncate font-medium">{ws?.name ?? workspaceSlug}</span>
          </>
        }
      />

      <main className="mx-auto w-full max-w-[1280px] px-6 pb-16 pt-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-4">
            <Monogram name={ws?.name ?? workspaceSlug ?? "?"} seed={ws?.id} size={52} className="rounded-2xl" />
            <div>
              <h1 className="text-[30px] font-medium leading-tight tracking-tight">{ws?.name ?? workspaceSlug}</h1>
              <p className="mt-1 text-[15px] text-muted-foreground">Choisissez un projet</p>
            </div>
          </div>
          <Button className="h-9 rounded-full px-4" onClick={() => setCreateOpen(true)} disabled={!ws}>
            <PlusIcon className="h-4 w-4" /> Nouveau projet
          </Button>
        </div>

        <div className="mt-10">
          {wsLoading || projLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
            </div>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center rounded-3xl border border-dashed border-border px-6 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <FolderIcon weight="duotone" className="h-6 w-6" />
              </span>
              <h2 className="mt-5 text-[20px] font-medium tracking-tight">Aucun projet pour l'instant</h2>
              <p className="mt-1.5 max-w-md text-[14px] text-muted-foreground">Créez un projet pour y installer vos agents et vos services.</p>
              <Button className="mt-6 rounded-full" onClick={() => setCreateOpen(true)} disabled={!ws}>
                <PlusIcon className="h-4 w-4" /> Nouveau projet
              </Button>
            </div>
          ) : (
            <>
              <SectionLabel count={list.length}>Projets</SectionLabel>
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                {list.map((p) => {
                  const c = counts?.[p.id];
                  const health = p.health_score ?? 0;
                  const open = () => navigate(`/app/${ws!.slug}/${p.slug}`);
                  return (
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      // La racine du projet choisit la page d'arrivée (PlaneLanding).
                      onClick={open}
                      onKeyDown={(e) => e.key === "Enter" && open()}
                      className="group relative flex cursor-pointer flex-col rounded-2xl border border-border bg-card p-5 outline-none transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:border-primary"
                    >
                      <div className="flex items-start gap-3.5">
                        <Monogram name={p.name} seed={p.id} />
                        <div className="min-w-0 flex-1 pt-0.5">
                          <div className="truncate text-[16px] font-medium tracking-tight">{p.name}</div>
                          <div className="truncate text-[12px] text-muted-foreground">Créé {formatRelative(p.created_at)}</div>
                        </div>
                        <div onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                                aria-label="Actions"
                              >
                                <DotsThreeIcon weight="bold" className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setRenameTarget(p)}>
                                <PencilSimpleIcon className="h-4 w-4" /> Renommer
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive onClick={() => setDeleteTarget(p)}>
                                <TrashIcon className="h-4 w-4" /> Supprimer
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      <div className="mt-6 grid grid-cols-2 gap-2">
                        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
                          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><RobotIcon className="h-3.5 w-3.5" /> Agents</div>
                          <div className="mt-1 text-[18px] font-medium tabular-nums">{c?.agents ?? "–"}</div>
                        </div>
                        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
                          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><GitBranchIcon className="h-3.5 w-3.5" /> Dépôts</div>
                          <div className="mt-1 text-[18px] font-medium tabular-nums">{c?.repos ?? "–"}</div>
                        </div>
                      </div>

                      <div className="mt-4">
                        <div className="flex items-center justify-between text-[12px]">
                          <span className="text-muted-foreground">Santé</span>
                          <MonoChip tone={health >= 70 ? "ok" : health >= 40 ? "warn" : "idle"}>{health}/100</MonoChip>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn("h-full rounded-full", health >= 70 ? "bg-emerald-500" : health >= 40 ? "bg-amber-500" : "bg-muted-foreground/40")}
                            style={{ width: `${Math.max(health > 0 ? 3 : 0, health)}%` }}
                          />
                        </div>
                      </div>

                      <div className="mt-4 flex items-center text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                        Ouvrir <ArrowRightIcon className="ml-1.5 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </div>
                  );
                })}

                <button
                  onClick={() => setCreateOpen(true)}
                  disabled={!ws}
                  className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/30 hover:text-foreground"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"><PlusIcon className="h-4 w-4" /></span>
                  <span className="text-[14px] font-medium">Nouveau projet</span>
                </button>
              </div>
            </>
          )}
        </div>
      </main>

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Nouveau projet"
        label="Nom du projet"
        placeholder="Mon produit"
        confirmText="Créer"
        onSubmit={async (name) => {
          if (!ws) return;
          const p = await createProject(ws.id, name);
          refresh();
          navigate(`/app/${ws.slug}/${p.slug}`);
        }}
      />

      <PromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Renommer le projet"
        label="Nouveau nom"
        initialValue={renameTarget?.name ?? ""}
        confirmText="Renommer"
        onSubmit={async (name) => {
          if (!renameTarget) return;
          await renameProject(renameTarget.id, name);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Supprimer le projet"
        description={`« ${deleteTarget?.name} » sera supprimé définitivement, avec ses agents et ses données.`}
        typeToConfirm={deleteTarget?.slug}
        confirmText="Supprimer le projet"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteProject(deleteTarget.id);
          refresh();
        }}
      />
    </div>
  );
}
