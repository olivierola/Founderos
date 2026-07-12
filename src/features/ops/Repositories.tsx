import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Github, Loader2, RefreshCw, ScanLine, KeyRound, ExternalLink,
  CheckSquare, Square, MoreVertical, Trash2, FileSearch,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { deleteRepository } from "@/hooks/useWorkspace";
import { cn } from "@/lib/utils";

interface GithubRepoItem {
  id: number; name: string; full_name: string; private: boolean;
  default_branch: string; description: string | null; language: string | null; updated_at: string;
}
interface TrackedRepo {
  id: string; full_name: string; default_branch: string | null; private: boolean; last_scanned_at: string | null;
}

export function RepositoriesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaceId, projectId, workspace, project, loading } = useCurrentContext();
  const openDetail = (id: string) => navigate(`/app/${workspace?.slug}/${project?.slug}/repos/repo/${id}`);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [search, setSearch] = useState("");
  const [rescanning, setRescanning] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; full_name: string } | null>(null);
  const [showReconnect, setShowReconnect] = useState(false);

  const connectorQuery = useQuery({
    queryKey: ["connector", "github", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("*").eq("project_id", projectId!).eq("provider", "github").maybeSingle();
      return data;
    },
  });

  const reposQuery = useQuery({
    queryKey: ["github-repos", projectId],
    enabled: !!projectId && !!connectorQuery.data,
    queryFn: async () => {
      const res = await callEdge<{ repos: GithubRepoItem[] }>("github-list-repos", { workspace_id: workspaceId, project_id: projectId });
      return res.repos;
    },
  });

  const trackedQuery = useQuery({
    queryKey: ["repositories", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("repositories").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as TrackedRepo[];
    },
  });

  async function handleConnect() {
    if (!workspaceId || !projectId) return;
    setConnecting(true); setConnectError(null);
    try {
      await callEdge("connect-github", { workspace_id: workspaceId, project_id: projectId, token: token.trim() });
      setToken("");
      await queryClient.invalidateQueries({ queryKey: ["connector", "github", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["github-repos", projectId] });
    } catch (e) { setConnectError(e instanceof Error ? e.message : String(e)); } finally { setConnecting(false); }
  }

  function toggle(fullName: string) {
    setSelected((prev) => { const next = new Set(prev); next.has(fullName) ? next.delete(fullName) : next.add(fullName); return next; });
  }
  function toggleAll(repos: GithubRepoItem[]) {
    setSelected((prev) => (prev.size === repos.length ? new Set() : new Set(repos.map((r) => r.full_name))));
  }

  async function scanSelected() {
    if (!workspaceId || !projectId || selected.size === 0) return;
    const repos = (reposQuery.data ?? []).filter((r) => selected.has(r.full_name));
    setScanning(true); setScanProgress({ done: 0, total: repos.length });
    try {
      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i]!;
        try {
          await callEdge("repo-scan", {
            workspace_id: workspaceId, project_id: projectId,
            github_repo: { external_id: repo.id, full_name: repo.full_name, name: repo.name, private: repo.private, default_branch: repo.default_branch },
          });
        } catch (e) { console.error(`Scan failed for ${repo.full_name}`, e); }
        setScanProgress({ done: i + 1, total: repos.length });
      }
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
    } finally { setScanning(false); setTimeout(() => setScanProgress(null), 2500); }
  }

  async function rescanOne(repo: TrackedRepo) {
    if (!workspaceId || !projectId) return;
    setRescanning(repo.id);
    try {
      await callEdge("repo-scan", {
        workspace_id: workspaceId, project_id: projectId,
        github_repo: { full_name: repo.full_name, name: repo.full_name.split("/").pop(), private: repo.private, default_branch: repo.default_branch ?? "main" },
      });
      await queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["scan_result", repo.id] });
    } finally { setRescanning(null); }
  }

  async function handleDeleteRepo() {
    if (!deleteTarget) return;
    await deleteRepository(deleteTarget.id);
    await queryClient.invalidateQueries({ queryKey: ["repositories", projectId] });
  }

  if (loading) return <div><PageHeader title="Dépôts" /><div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div></div>;

  const repos = reposQuery.data ?? [];
  const filtered = search ? repos.filter((r) => r.full_name.toLowerCase().includes(search.toLowerCase())) : repos;
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.full_name));

  return (
    <div>
      <PageHeader title="Dépôts" description="Connectez GitHub, choisissez les dépôts, puis lancez un scan de code." />

      {!connectorQuery.data ? (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> Connecter GitHub</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Créez un Personal Access Token (fine-grained) avec accès lecture à vos dépôts sur{" "}
              <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline">github.com/settings/tokens</a>.
              Le token est chiffré avant stockage et jamais renvoyé au navigateur.
            </p>
            <Input type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
            <Button onClick={handleConnect} disabled={connecting || token.length < 20}>
              {connecting && <Loader2 className="h-4 w-4 animate-spin" />}<Github className="h-4 w-4" /> Connecter GitHub
            </Button>
            {connectError && <p className="text-sm text-destructive">{connectError}</p>}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="order-2">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2"><Github className="h-4 w-4" /> Connecté en tant que @{(connectorQuery.data.metadata as { github_login?: string })?.github_login ?? "github"}</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setShowReconnect((v) => !v)}><KeyRound className="h-4 w-4" /> Reconnecter</Button>
                  <Button variant="ghost" size="sm" onClick={() => reposQuery.refetch()} disabled={reposQuery.isFetching}>
                    <RefreshCw className={cn("h-4 w-4", reposQuery.isFetching && "animate-spin")} /> Actualiser
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {reposQuery.error && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  <span>Identifiants GitHub invalides ou expirés (« Bad credentials »). Reconnectez GitHub avec un token valide.</span>
                  <Button size="sm" variant="outline" onClick={() => setShowReconnect(true)}>Reconnecter</Button>
                </div>
              )}
              {showReconnect && (
                <div className="mb-3 space-y-2 rounded-md border border-border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Collez un nouveau Personal Access Token (le token actuel est remplacé et rechiffré).</p>
                  <div className="flex items-center gap-2">
                    <Input type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} className="h-9" />
                    <Button size="sm" onClick={async () => { await handleConnect(); if (!connectError) setShowReconnect(false); }} disabled={connecting || token.length < 20}>
                      {connecting && <Loader2 className="h-4 w-4 animate-spin" />} Reconnecter
                    </Button>
                  </div>
                  {connectError && <p className="text-xs text-destructive">{connectError}</p>}
                </div>
              )}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => toggleAll(filtered)} disabled={filtered.length === 0}>
                    {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}{allSelected ? "Tout désélectionner" : "Tout sélectionner"}
                  </Button>
                  <Input placeholder="Filtrer les dépôts…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-56" />
                </div>
                <div className="flex items-center gap-3">
                  {scanProgress && <span className="text-xs text-muted-foreground">Scannés {scanProgress.done}/{scanProgress.total}</span>}
                  <Button onClick={scanSelected} disabled={scanning || selected.size === 0}>
                    {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />} Scanner ({selected.size})
                  </Button>
                </div>
              </div>

              {reposQuery.isLoading ? <div className="text-sm text-muted-foreground">Chargement des dépôts…</div>
                : reposQuery.error ? <div className="text-sm text-destructive">{(reposQuery.error as Error).message}</div>
                : filtered.length === 0 ? <p className="text-sm text-muted-foreground">Aucun dépôt.</p>
                : (
                  <ul className="divide-y divide-border">
                    {filtered.slice(0, 60).map((repo) => {
                      const isSel = selected.has(repo.full_name);
                      return (
                        <li key={repo.id}>
                          <button onClick={() => toggle(repo.full_name)} className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-secondary/30">
                            {isSel ? <CheckSquare className="h-4 w-4 shrink-0 text-primary" /> : <Square className="h-4 w-4 shrink-0 text-muted-foreground" />}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-medium">{repo.full_name}</span>
                                {repo.private ? <Badge variant="secondary">privé</Badge> : <Badge variant="outline">public</Badge>}
                                {repo.language && <span className="text-xs text-muted-foreground">{repo.language}</span>}
                              </div>
                              {repo.description && <div className="truncate text-xs text-muted-foreground">{repo.description}</div>}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
            </CardContent>
          </Card>

          <div className="order-1">
            <h2 className="mb-3 text-sm font-semibold">Dépôts suivis</h2>
            {(trackedQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun dépôt suivi. Sélectionnez des dépôts dans la liste ci-dessous et cliquez sur Scanner.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {trackedQuery.data!.map((repo) => {
                  const scanned = !!repo.last_scanned_at;
                  return (
                    <Card key={repo.id} className="group cursor-pointer" onClick={() => openDetail(repo.id)}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary"><Github className="h-5 w-5 text-muted-foreground" /></div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onClick={() => openDetail(repo.id)}><FileSearch className="h-4 w-4" /> Ouvrir</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => rescanOne(repo)}><ScanLine className="h-4 w-4" /> Re-scanner</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive onClick={() => setDeleteTarget({ id: repo.id, full_name: repo.full_name })}><Trash2 className="h-4 w-4" /> Retirer</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <div className="mt-3">
                          <div className="truncate font-medium">{repo.full_name}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{repo.default_branch ?? "main"}</span>
                            {repo.private ? <Badge variant="secondary">privé</Badge> : <Badge variant="outline">public</Badge>}
                          </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          {rescanning === repo.id ? <Badge variant="info"><Loader2 className="mr-1 h-3 w-3 animate-spin" /> scan…</Badge>
                            : scanned ? <Badge variant="success">scanné</Badge> : <Badge variant="secondary">jamais scanné</Badge>}
                          <a href={`https://github.com/${repo.full_name}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></a>
                        </div>
                        {scanned && <div className="mt-1 text-xs text-muted-foreground">dernier scan {new Date(repo.last_scanned_at!).toLocaleString("fr-FR")}</div>}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Retirer le dépôt"
        description={`Retirer « ${deleteTarget?.full_name} » et son historique de scan de ce projet ? Le dépôt GitHub n'est pas affecté.`}
        confirmText="Retirer"
        onConfirm={handleDeleteRepo}
      />
    </div>
  );
}
