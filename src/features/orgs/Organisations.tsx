import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon, CircleNotchIcon as Loader2, DotsThreeIcon, FolderIcon, MagnifyingGlassIcon,
  PencilSimpleIcon, PlusIcon, TrashIcon, UsersIcon, CubeIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PromptDialog } from "@/components/PromptDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  useWorkspaces, useWorkspaceStats, createWorkspace, renameWorkspace, type WorkspaceMembership,
} from "@/hooks/useWorkspace";
import { useAuth } from "@/lib/auth-context";
import { callEdge } from "@/lib/edge";
import { useFirstName } from "@/features/journey/api";
import { MonoChip, Monogram, SectionLabel, SelectionTopBar } from "./chrome";

const ROLE_LABEL: Record<string, string> = { owner: "Propriétaire", admin: "Admin", member: "Membre", viewer: "Lecteur" };

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 || h >= 18 ? "Bonsoir" : "Bonjour";
}

export function OrganisationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const firstName = useFirstName();
  const { data: workspaces, isLoading } = useWorkspaces();
  const ids = useMemo(() => (workspaces ?? []).map((w) => w.workspace_id), [workspaces]);
  const { data: stats } = useWorkspaceStats(ids);

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkspaceMembership | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMembership | null>(null);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["workspaces", user?.id] });
    queryClient.invalidateQueries({ queryKey: ["workspace-stats"] });
  }

  const q = search.trim().toLowerCase();
  const list = (workspaces ?? []).filter((m) => !q || m.workspaces.name.toLowerCase().includes(q) || m.workspaces.slug.includes(q));
  const many = (workspaces ?? []).length > 6;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SelectionTopBar crumbs={<span className="text-muted-foreground">Organisations</span>} />

      <main className="mx-auto w-full max-w-[1280px] px-6 pb-16 pt-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[30px] font-medium leading-tight tracking-tight">
              {greeting()}{firstName ? `, ${firstName}` : ""}
            </h1>
            <p className="mt-1.5 text-[15px] text-muted-foreground">Choisissez l'organisation dans laquelle travailler.</p>
          </div>
          <div className="flex items-center gap-2">
            {many && (
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher"
                  className="h-9 w-56 rounded-full border border-border bg-card pl-9 pr-3 text-[13px] outline-none transition-colors focus:border-primary/60"
                />
              </div>
            )}
            <Button className="h-9 rounded-full px-4" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="h-4 w-4" /> Nouvelle organisation
            </Button>
          </div>
        </div>

        <div className="mt-10">
          {isLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
            </div>
          ) : !workspaces || workspaces.length === 0 ? (
            /* Un compte sans organisation est un arrivant qui a quitté le
               parcours en route : on le renvoie là, où l'organisation, le
               contexte et le premier agent se créent ensemble. */
            <div className="flex flex-col items-center rounded-3xl border border-dashed border-border px-6 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <CubeIcon weight="duotone" className="h-6 w-6" />
              </span>
              <h2 className="mt-5 text-[20px] font-medium tracking-tight">Votre espace n'est pas encore créé</h2>
              <p className="mt-1.5 max-w-md text-[14px] text-muted-foreground">
                Reprenez le parcours : il crée votre organisation, le contexte que vos agents liront et votre premier agent.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button className="rounded-full" onClick={() => navigate("/onboarding")}>Reprendre le parcours</Button>
                <Button variant="outline" className="rounded-full" onClick={() => setCreateOpen(true)}>
                  <PlusIcon className="h-4 w-4" /> Créer à la main
                </Button>
              </div>
            </div>
          ) : (
            <>
              <SectionLabel count={list.length}>Vos organisations</SectionLabel>
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                {list.map((m) => {
                  const s = stats?.[m.workspace_id];
                  return (
                    <div
                      key={m.workspace_id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/orgs/${m.workspaces.slug}/projects`)}
                      onKeyDown={(e) => e.key === "Enter" && navigate(`/orgs/${m.workspaces.slug}/projects`)}
                      className="group relative flex cursor-pointer flex-col rounded-2xl border border-border bg-card p-5 outline-none transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:border-primary"
                    >
                      <div className="flex items-start gap-3.5">
                        <Monogram name={m.workspaces.name} seed={m.workspace_id} />
                        <div className="min-w-0 flex-1 pt-0.5">
                          <div className="truncate text-[16px] font-medium tracking-tight">{m.workspaces.name}</div>
                          <div className="truncate font-mono text-[12px] text-muted-foreground">{m.workspaces.slug}</div>
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
                              <DropdownMenuItem onClick={() => setRenameTarget(m)}>
                                <PencilSimpleIcon className="h-4 w-4" /> Renommer
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive disabled={m.role !== "owner"} onClick={() => setDeleteTarget(m)}>
                                <TrashIcon className="h-4 w-4" /> Supprimer
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      <div className="mt-6 grid grid-cols-2 gap-2">
                        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
                          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><FolderIcon className="h-3.5 w-3.5" /> Projets</div>
                          <div className="mt-1 text-[18px] font-medium tabular-nums">{s?.projects ?? "–"}</div>
                        </div>
                        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
                          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> Membres</div>
                          <div className="mt-1 text-[18px] font-medium tabular-nums">{s?.members ?? "–"}</div>
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-1.5">
                        <MonoChip tone={m.role === "owner" ? "accent" : "idle"}>{ROLE_LABEL[m.role] ?? m.role}</MonoChip>
                        <MonoChip>{m.workspaces.plan ?? "free"}</MonoChip>
                        <ArrowRightIcon className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </div>
                    </div>
                  );
                })}

                <button
                  onClick={() => setCreateOpen(true)}
                  className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/30 hover:text-foreground"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"><PlusIcon className="h-4 w-4" /></span>
                  <span className="text-[14px] font-medium">Nouvelle organisation</span>
                </button>
              </div>
            </>
          )}
        </div>
      </main>

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Nouvelle organisation"
        label="Nom de l'organisation"
        placeholder="Acme"
        confirmText="Créer"
        onSubmit={async (name) => {
          if (!user) return;
          const ws = await createWorkspace(name);
          refresh();
          navigate(`/orgs/${ws.slug}/projects`);
        }}
      />

      <PromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Renommer l'organisation"
        label="Nouveau nom"
        initialValue={renameTarget?.workspaces.name ?? ""}
        confirmText="Renommer"
        onSubmit={async (name) => {
          if (!renameTarget) return;
          await renameWorkspace(renameTarget.workspace_id, name);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Supprimer l'organisation"
        description={`« ${deleteTarget?.workspaces.name} » sera supprimée définitivement, avec tous ses projets et leurs données.`}
        typeToConfirm={deleteTarget?.workspaces.slug}
        confirmText="Supprimer l'organisation"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await callEdge("delete-workspace", {
            workspace_id: deleteTarget.workspace_id,
            confirm_slug: deleteTarget.workspaces.slug,
          });
          refresh();
        }}
      />
    </div>
  );
}
