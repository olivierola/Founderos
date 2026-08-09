import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Github, Search, Check, Loader2, Lock, GitFork, AlertCircle, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";

// A repo picker backed by the project's GitHub connection (github-list-repos,
// which resolves either a stored PAT or — the common case now — the Composio
// GitHub OAuth account, proxying the listing when the token is masked). Selected
// repos are registered as real `repositories` rows via repo-scan, so the Vibe
// Coder studio agent can immediately drive them. This is why "add a repo" lives
// in the Assets tab: it's how a specialized dashboard feeds its coding agent.

interface GithubRepoItem {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

export function RepoPickerDialog({
  open, onOpenChange, workspaceId, projectId, existingFullNames, onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  projectId: string;
  /** Repos already tracked — shown as "déjà ajouté", not selectable. */
  existingFullNames: Set<string>;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { workspaceSlug, projectSlug } = useParams();

  const reposQuery = useQuery({
    queryKey: ["github_repos_picker", projectId],
    enabled: open,
    queryFn: async () => {
      const res = await callEdge<{ repos: GithubRepoItem[]; error?: string }>("github-list-repos", {
        workspace_id: workspaceId, project_id: projectId,
      });
      return res.repos ?? [];
    },
  });

  // "GitHub not connected" comes back as an edge error — surface a CTA rather
  // than a stack trace.
  const notConnected = reposQuery.isError &&
    /not connected|non connect/i.test((reposQuery.error as Error)?.message ?? "");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = reposQuery.data ?? [];
    return q ? list.filter((r) => r.full_name.toLowerCase().includes(q)) : list;
  }, [reposQuery.data, query]);

  function toggle(fullName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName); else next.add(fullName);
      return next;
    });
  }

  async function confirm() {
    const repos = (reposQuery.data ?? []).filter((r) => selected.has(r.full_name));
    if (repos.length === 0) return;
    setAdding(true);
    setError(null);
    setProgress({ done: 0, total: repos.length });
    try {
      for (let i = 0; i < repos.length; i++) {
        const r = repos[i]!;
        try {
          // repo-scan inserts the repositories row (RLS blocks a direct
          // frontend insert) and indexes the repo. Same path the standalone
          // Repositories page uses.
          await callEdge("repo-scan", {
            workspace_id: workspaceId, project_id: projectId,
            github_repo: { external_id: r.id, full_name: r.full_name, name: r.name, private: r.private, default_branch: r.default_branch },
          });
        } catch (e) {
          console.error(`repo-scan failed for ${r.full_name}`, e);
        }
        setProgress({ done: i + 1, total: repos.length });
      }
      onAdded();
      setSelected(new Set());
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
      setTimeout(() => setProgress(null), 1500);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" /> Ajouter des dépôts GitHub
          </DialogTitle>
        </DialogHeader>

        {notConnected ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertCircle className="h-6 w-6 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              GitHub n'est pas connecté à ce projet. Connectez-le dans les connecteurs, puis revenez ici.
            </p>
            {workspaceSlug && projectSlug && (
              <Button asChild variant="outline" size="sm">
                <a href={`/app/${workspaceSlug}/${projectSlug}/agent/connectors?connect=github`}>
                  Connecter GitHub <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Choisissez les dépôts à rendre disponibles pour ce service. Ils deviennent utilisables par l'agent Vibe Coder.
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un dépôt…" className="pl-9" />
            </div>

            <div className="max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
              {reposQuery.isLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Chargement des dépôts…
                </div>
              ) : reposQuery.isError ? (
                // Connection exists but the listing failed (e.g. 502) — show the
                // real reason rather than a misleading "no repos".
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                  <p className="text-sm text-muted-foreground">Impossible de lister les dépôts.</p>
                  <p className="max-w-sm text-xs text-muted-foreground">{(reposQuery.error as Error)?.message}</p>
                  <Button variant="outline" size="sm" onClick={() => reposQuery.refetch()}>Réessayer</Button>
                </div>
              ) : filtered.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Aucun dépôt trouvé.</p>
              ) : (
                filtered.map((r) => {
                  const already = existingFullNames.has(r.full_name);
                  const on = selected.has(r.full_name);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={already || adding}
                      onClick={() => toggle(r.full_name)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                        already ? "cursor-default border-border opacity-55"
                          : on ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/40",
                      )}
                    >
                      <span className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
                      )}>
                        {on && <Check className="h-3.5 w-3.5" />}
                      </span>
                      <Github className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.full_name}</span>
                      {r.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Privé" />}
                      {r.default_branch && (
                        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
                          <GitFork className="h-3 w-3" /> {r.default_branch}
                        </span>
                      )}
                      {already && <span className="shrink-0 text-[10px] text-muted-foreground">déjà ajouté</span>}
                    </button>
                  );
                })
              )}
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center justify-between border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">
                {progress ? `Ajout… ${progress.done}/${progress.total}` : `${selected.size} sélectionné(s)`}
              </span>
              <Button onClick={confirm} disabled={selected.size === 0 || adding}>
                {adding ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
                Ajouter {selected.size > 0 ? `(${selected.size})` : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
