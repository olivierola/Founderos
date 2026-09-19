import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  UserIcon as User,
  RobotIcon as Bot,
  GithubLogoIcon as Github,
  LinkIcon,
  FileTextIcon as FileText,
  KeyIcon as KeyRound,
  PlugIcon as Plug,
  NoteIcon as StickyNote,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  CircleNotchIcon as Loader2,
  CubeIcon as Boxes,
  CloudArrowUpIcon as UploadCloud,
  SparkleIcon as Sparkles,
  CheckIcon as Check,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { BrandLogo } from "@/components/BrandLogo";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import {
  ASSET_KINDS, fetchAssets, addAsset, deleteAsset, type AssetKind, type DashboardAsset,
} from "./model";
import { RepoPickerDialog } from "./RepoPickerDialog";
import { deleteRepository } from "@/hooks/useWorkspace";

const KIND_ICON: Record<AssetKind, typeof User> = {
  human: User, agent: Bot, repo: Github, link: LinkIcon, file: FileText, key: KeyRound, connector: Plug, note: StickyNote,
};

// Everything-about-this-service board: real agents (auto), plus manually-dropped
// people, repos, links, files, key references, connected tools and notes — all
// as a card grid, a dashed "+" tile opening the add dialog.
export function AssetsHub({ dashboardId, workspaceId, projectId }: {
  dashboardId: string; workspaceId: string; projectId: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<AssetKind>("link");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);

  // Real tracked repositories (project-scoped) — the same rows the Vibe Coder
  // resolves. Adding a repo here is how a specialized dashboard feeds its
  // coding agent, so this reads `repositories`, not the dashboard_assets cards.
  const { data: repos } = useQuery({
    queryKey: ["repositories", projectId],
    queryFn: async () => {
      const { data } = await supabase
        .from("repositories")
        .select("id, full_name, name, default_branch, private, provider")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      return (data ?? []) as Array<{ id: string; full_name: string | null; name: string; default_branch: string | null; private: boolean | null; provider: string }>;
    },
  });
  const repoFullNames = new Set((repos ?? []).map((r) => r.full_name ?? "").filter(Boolean));

  const { data: assets } = useQuery({
    queryKey: ["service_assets", dashboardId],
    queryFn: () => fetchAssets(dashboardId),
  });
  const { data: agents } = useQuery({
    queryKey: ["service_dashboard_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, description, avatar_url, avatar_style")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false)
        .order("created_at", { ascending: false });
      return (data ?? []) as Array<{ id: string; name: string; description: string | null; avatar_url: string | null; avatar_style: "avatar" | "orb" | null }>;
    },
  });

  const docInputRef = useRef<HTMLInputElement>(null);
  const [ingesting, setIngesting] = useState<string | null>(null);
  const [ingestErr, setIngestErr] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["service_assets", dashboardId] });

  // Upload a document, then vectorize it into EVERY service agent's store
  // (rag-extract-file server-side extraction + embedding) so it becomes a
  // searchable knowledge source for the whole service. Persisted as a "file"
  // asset flagged "vectorisé".
  async function vectorizeDocs(list: FileList | null) {
    const svcAgents = agents ?? [];
    if (!list?.length || !projectId) return;
    if (svcAgents.length === 0) { setIngestErr("Ajoutez d'abord un agent à ce service pour lui donner une source."); return; }
    setIngestErr(null);
    for (const file of Array.from(list)) {
      if (file.size > 15 * 1024 * 1024) { setIngestErr(`"${file.name}" dépasse 15 Mo.`); continue; }
      setIngesting(file.name);
      try {
        const path = `${projectId}/svc-${dashboardId}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("rag-docs").upload(path, file, { contentType: file.type || "application/octet-stream" });
        if (upErr) throw new Error(upErr.message);
        for (const a of svcAgents) {
          await callEdge("rag-extract-file", { workspace_id: workspaceId, project_id: projectId, agent_id: a.id, title: file.name, storage_path: path, mime: file.type }).catch(() => {});
        }
        await addAsset(workspaceId, projectId, dashboardId, user?.id ?? null, { kind: "file", label: file.name, value: "vectorisé" });
        invalidate();
      } catch (e) {
        setIngestErr(e instanceof Error ? e.message : String(e));
      } finally {
        setIngesting(null);
      }
    }
    if (docInputRef.current) docInputRef.current.value = "";
  }
  const kindMeta = ASSET_KINDS.find((k) => k.kind === kind)!;
  // Vectorized knowledge docs (file assets flagged "vectorisé") get their own
  // section; everything else stays in the general assets grid.
  const docs = (assets ?? []).filter((a) => a.kind === "file" && a.value === "vectorisé");
  const manualAssets = (assets ?? []).filter((a) => a.kind !== "agent" && !(a.kind === "file" && a.value === "vectorisé"));

  async function add() {
    if (!label.trim() || saving) return;
    setSaving(true);
    try {
      await addAsset(workspaceId, projectId, dashboardId, user?.id ?? null, { kind, label, value });
      setLabel(""); setValue(""); setAdding(false);
      invalidate();
    } finally { setSaving(false); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-indigo-500" />
          <h1 className="text-xl font-semibold">Assets</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Tout ce qui touche ce service au même endroit : personnes, agents, dépôts, liens, fichiers, clés et outils connectés.</p>
      </div>

      {/* Agents (real, auto from this dashboard) */}
      <section>
        <SectionHead icon={Bot} title="Agents" count={agents?.length ?? 0} />
        {(agents ?? []).length === 0 ? (
          <Empty text="Aucun agent dans ce dashboard. Créez-en un depuis l'onglet Agents." />
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {(agents ?? []).map((a) => (
              <AgentAssetCard
                key={a.id}
                agent={a}
                onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}/agent/${a.id}`)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Knowledge sources — documents vectorized into every service agent's
          RAG store so they become searchable context for the whole service. */}
      <section>
        <SectionHead icon={Sparkles} title="Sources de connaissance" count={docs.length} />
        <p className="-mt-1 mb-2.5 text-xs text-muted-foreground">
          Déposez des documents : ils sont vectorisés et deviennent une source consultable par les agents de ce service.
        </p>
        {ingestErr && <p className="mb-2 text-xs text-destructive">{ingestErr}</p>}
        <input
          ref={docInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".pdf,.txt,.md,.markdown,.docx,.doc,.csv,.json,.html,.htm"
          onChange={(e) => vectorizeDocs(e.target.files)}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <button
            onClick={() => docInputRef.current?.click()}
            disabled={!!ingesting}
            className="group flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-muted-foreground/25 bg-gradient-to-b from-muted/10 to-muted/30 transition-colors hover:border-primary/40 hover:from-primary/5 hover:to-primary/10 disabled:opacity-60"
          >
            {ingesting ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="max-w-[90%] truncate px-2 text-[11px] text-muted-foreground">Vectorisation… {ingesting}</span>
              </>
            ) : (
              <>
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform group-hover:scale-105">
                  <UploadCloud className="h-5 w-5" />
                </span>
                <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">Ajouter un document</span>
              </>
            )}
          </button>
          {docs.map((d) => (
            <DocCard key={d.id} asset={d} onDelete={async () => { await deleteAsset(d.id); invalidate(); }} />
          ))}
        </div>
      </section>

      {/* GitHub repositories — real `repositories` rows the Vibe Coder can drive.
          Picked from the project's GitHub (Composio) connection, shown as cards. */}
      <section>
        <SectionHead icon={Github} title="Dépôts GitHub" count={repos?.length ?? 0} />
        <p className="-mt-1 mb-2.5 text-xs text-muted-foreground">
          Ajoutez des dépôts depuis votre connexion GitHub : ils deviennent disponibles pour l'agent Vibe Coder de ce service.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <button
            onClick={() => setRepoPickerOpen(true)}
            className="group flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-muted-foreground/25 bg-gradient-to-b from-muted/10 to-muted/30 transition-colors hover:border-primary/40 hover:from-primary/5 hover:to-primary/10"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground transition-transform group-hover:scale-105">
              <Github className="h-5 w-5" />
            </span>
            <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">Ajouter des dépôts</span>
          </button>
          {(repos ?? []).map((r) => (
            <RepoCard
              key={r.id}
              fullName={r.full_name ?? r.name}
              defaultBranch={r.default_branch}
              isPrivate={!!r.private}
              onDelete={async () => { await deleteRepository(r.id); queryClient.invalidateQueries({ queryKey: ["repositories", projectId] }); }}
            />
          ))}
        </div>
      </section>

      {/* Manual assets — one card grid per kind, "+" tile opens the add dialog. */}
      <section>
        <SectionHead icon={Boxes} title="Assets" count={manualAssets.length} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <button
            onClick={() => setAdding(true)}
            className="group flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-muted-foreground/25 bg-gradient-to-b from-muted/10 to-muted/30 transition-colors hover:border-primary/40 hover:from-primary/5 hover:to-primary/10"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground transition-transform group-hover:scale-105">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">Ajouter</span>
          </button>
          {manualAssets.map((a) => (
            <AssetTile key={a.id} asset={a} onDelete={async () => { await deleteAsset(a.id); invalidate(); }} />
          ))}
        </div>
      </section>

      <RepoPickerDialog
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
        workspaceId={workspaceId}
        projectId={projectId}
        existingFullNames={repoFullNames}
        onAdded={() => queryClient.invalidateQueries({ queryKey: ["repositories", projectId] })}
      />

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Ajouter un asset</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {/* "repo" has its own dedicated GitHub section above, so it's not
                  offered as a manual free-text kind here. */}
              {ASSET_KINDS.filter((k) => k.kind !== "agent" && k.kind !== "repo").map((k) => {
                const Icon = KIND_ICON[k.kind];
                return (
                  <button key={k.kind} onClick={() => setKind(k.kind)}
                    className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                      kind === k.kind ? "border-indigo-500/50 bg-indigo-500/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                    <Icon className="h-3.5 w-3.5" /> {k.label}
                  </button>
                );
              })}
            </div>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Libellé" autoFocus />
            {kindMeta.hasValue && (
              <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kindMeta.placeholder} />
            )}
            {kind === "key" && <p className="text-[11px] text-amber-600 dark:text-amber-400">Ne collez jamais une clé brute ici — mettez une référence (nom du secret dans le Vault). Ce n'est pas un coffre chiffré.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>Annuler</Button>
              <Button onClick={add} disabled={!label.trim() || saving}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Ajouter
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionHead({ icon: Icon, title, count }: { icon: typeof User; title: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{count}</span>
    </div>
  );
}

// Agent card: a soft raised surface with the agent's own identity (animated
// orb or avatar), name + description, and a subtle "Agent" footer chip. Honours
// avatar_style — never hardcoded.
function AgentAssetCard({ agent, onClick }: {
  agent: { id: string; name: string; description: string | null; avatar_url: string | null; avatar_style: "avatar" | "orb" | null };
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border/70 bg-card text-card-foreground shadow-sm ring-1 ring-transparent transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:ring-primary/10"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 p-4 text-center">
        <span className="rounded-2xl bg-gradient-to-b from-muted/40 to-muted/10 p-1.5 ring-1 ring-border/50">
          <AgentIdentity style={agent.avatar_style} url={agent.avatar_url} seed={agent.name} size={38} rounded="rounded-xl" lightOrb />
        </span>
        <span className="w-full min-w-0">
          <span className="block truncate text-sm font-semibold">{agent.name}</span>
          {agent.description && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{agent.description}</span>}
        </span>
      </div>
      <div className="flex items-center justify-center gap-1 border-t border-border/50 bg-muted/40 px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground">
        <Bot className="h-3 w-3" /> Agent
      </div>
    </div>
  );
}

// Vectorized knowledge document card — document glyph, filename, and a green
// "source des agents" badge signalling it feeds the service's RAG.
function DocCard({ asset, onDelete }: { asset: DashboardAsset; onDelete: () => void }) {
  return (
    <div className="group relative flex aspect-square flex-col justify-between overflow-hidden rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <button
        onClick={onDelete}
        title="Retirer"
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <FileText className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium" title={asset.label}>{asset.label}</span>
        <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="h-2.5 w-2.5" /> Source des agents
        </span>
      </span>
    </div>
  );
}

// A tracked repository card (backed by the real `repositories` row), with the
// GitHub mark, its default branch, and a link out.
function RepoCard({
  fullName, defaultBranch, isPrivate, onDelete,
}: {
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex aspect-square flex-col justify-between overflow-hidden rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Retirer le dépôt"
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <a
        href={`https://github.com/${fullName}`} target="_blank" rel="noopener noreferrer"
        className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-b from-muted/50 to-muted/20 ring-1 ring-border/50"
      >
        <BrandLogo slug="github" className="h-5 w-5" />
      </a>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium" title={fullName}>{fullName.split("/").pop()}</span>
        <span className="block truncate text-[10px] text-muted-foreground" title={fullName}>{fullName}</span>
        <span className="mt-1.5 inline-flex flex-wrap items-center gap-1">
          {defaultBranch && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
              {defaultBranch}
            </span>
          )}
          {isPrivate && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">privé</span>
          )}
        </span>
      </span>
    </div>
  );
}

function AssetTile({ asset, onDelete }: { asset: DashboardAsset; onDelete: () => void }) {
  const href = asset.kind === "repo" ? `https://github.com/${asset.value}`
    : asset.kind === "link" || asset.kind === "file" ? asset.value ?? undefined : undefined;
  const glyph = asset.kind === "repo" ? <BrandLogo slug="github" className="h-5 w-5" />
    : asset.kind === "connector" && asset.value ? <BrandLogo slug={asset.value} className="h-5 w-5" />
    : null;
  const Icon = KIND_ICON[asset.kind];
  const body = (
    <>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-b from-muted/50 to-muted/20 ring-1 ring-border/50">
        {glyph ?? <Icon className="h-5 w-5 text-muted-foreground" />}
      </span>
      <span className="w-full min-w-0">
        <span className="block truncate text-sm font-medium">{asset.label}</span>
        {asset.value && <span className="block truncate text-[10px] text-muted-foreground">{asset.value}</span>}
      </span>
    </>
  );
  return (
    <div className="group relative flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border border-border/70 bg-card p-3 text-center shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <button
        onClick={onDelete}
        title="Retirer"
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-2">
          {body}
        </a>
      ) : body}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{text}</div>;
}
