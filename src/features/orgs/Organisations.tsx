import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CubeIcon as Boxes,
  PlusIcon as Plus,
  CircleNotchIcon as Loader2,
  SignOutIcon as LogOut,
  DotsThreeVerticalIcon as MoreVertical,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  FolderIcon as FolderGit2,
  UsersIcon as Users,
} from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
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
import {
  useWorkspaces,
  useWorkspaceStats,
  createWorkspace,
  renameWorkspace,
  type WorkspaceMembership,
} from "@/hooks/useWorkspace";
import { useAuth } from "@/lib/auth-context";
import { callEdge } from "@/lib/edge";

export function OrganisationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, signOut } = useAuth();
  const { data: workspaces, isLoading } = useWorkspaces();
  const ids = useMemo(() => (workspaces ?? []).map((w) => w.workspace_id), [workspaces]);
  const { data: stats } = useWorkspaceStats(ids);

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkspaceMembership | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMembership | null>(null);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["workspaces", user?.id] });
    queryClient.invalidateQueries({ queryKey: ["workspace-stats"] });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        {/* The site's lockup — mark + Audiowide wordmark, in the ink of the
            theme — then the page it is. */}
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2.5 text-foreground">
            <Logo size={20} color="currentColor" />
            <span className="text-[19px] leading-none tracking-[0.02em]" style={{ fontFamily: "'Audiowide', 'Geist', sans-serif" }}>
              ANDURAN.
            </span>
          </span>
          <span className="h-5 w-px bg-border" />
          <span className="text-sm text-muted-foreground">Organisations</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{user?.email}</span>
          <Button variant="ghost" size="icon" onClick={() => signOut()}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Your organisations</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick an organisation to manage its projects.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New organisation
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !workspaces || workspaces.length === 0 ? (
          /* Un compte sans aucune organisation n'a rien à faire ici : c'est un
             arrivant qui a quitté le parcours en route, ou qui revient après. Le
             bouton « nouvelle organisation » le laisserait recréer à la main ce
             que le parcours fait — contexte d'entreprise et premier agent
             compris. On le renvoie donc là, sans boucle possible : le parcours
             ne renvoie ici QUE lorsqu'une organisation existe. */
          <EmptyState
            icon={Boxes}
            title="Votre espace n'est pas encore créé"
            description="Reprenez le parcours d'arrivée : il crée votre organisation, écrit le contexte que vos agents liront et embauche votre premier agent."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => navigate("/onboarding")}>
                  Reprendre le parcours
                </Button>
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> Créer à la main
                </Button>
              </div>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((m) => {
              const s = stats?.[m.workspace_id];
              return (
                <Card
                  key={m.workspace_id}
                  className="group cursor-pointer transition-colors hover:border-primary/40"
                  onClick={() => navigate(`/orgs/${m.workspaces.slug}/projects`)}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex h-11 w-11 items-center justify-center rounded-md bg-secondary">
                        <Boxes className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setRenameTarget(m)}>
                              <Pencil className="h-4 w-4" /> Rename
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              destructive
                              disabled={m.role !== "owner"}
                              onClick={() => setDeleteTarget(m)}
                            >
                              <Trash2 className="h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="truncate font-semibold">{m.workspaces.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{m.workspaces.slug}</div>
                    </div>

                    <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FolderGit2 className="h-3.5 w-3.5" /> {s?.projects ?? "—"} projects
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" /> {s?.members ?? "—"} members
                      </span>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <Badge variant={m.role === "owner" ? "default" : "outline"}>{m.role}</Badge>
                      <Badge variant="secondary">{m.workspaces.plan ?? "free"}</Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Create */}
      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New organisation"
        label="Organisation name"
        placeholder="Acme Inc."
        confirmText="Create"
        onSubmit={async (name) => {
          if (!user) return;
          const ws = await createWorkspace(name);
          refresh();
          navigate(`/orgs/${ws.slug}/projects`);
        }}
      />

      {/* Rename */}
      <PromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Rename organisation"
        label="New name"
        initialValue={renameTarget?.workspaces.name ?? ""}
        confirmText="Rename"
        onSubmit={async (name) => {
          if (!renameTarget) return;
          await renameWorkspace(renameTarget.workspace_id, name);
          refresh();
        }}
      />

      {/* Delete */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete organisation"
        description={`This permanently deletes "${deleteTarget?.workspaces.name}" and all its projects, scans and data.`}
        typeToConfirm={deleteTarget?.workspaces.slug}
        confirmText="Delete organisation"
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
