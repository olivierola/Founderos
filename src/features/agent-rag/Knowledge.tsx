import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon, BookOpenIcon, CircleNotchIcon as Loader2, DatabaseIcon, FileArrowUpIcon,
  FileTextIcon, GlobeIcon, GridFourIcon, HardDrivesIcon, LinkSimpleIcon, MagnifyingGlassIcon,
  SparkleIcon, StackIcon, TextTIcon, TrashIcon, UploadSimpleIcon, WarningCircleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SoftInput, SoftTextarea } from "@/components/ui/soft-form";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import type { Agent } from "./AgentBuilder";
import { PaCard, PaHeader, PaKpi, PaKpiGrid, PaPage, PaSegmented, PaStatus, fmtBytes, nf } from "./ui";

interface Source {
  id: string; type: string; title: string; status: string; chunk_count: number;
  byte_size?: number; error_message: string | null; created_at: string;
}

type AddType = "text" | "url" | "saas_structure";

const TYPE_META: Record<string, { label: string; icon: PhosphorIcon }> = {
  url: { label: "Page web", icon: LinkSimpleIcon },
  text: { label: "Texte", icon: TextTIcon },
  file: { label: "Fichier", icon: FileTextIcon },
  saas_structure: { label: "Structure de l'app", icon: GridFourIcon },
};
const typeMeta = (t: string) => TYPE_META[t] ?? { label: t, icon: FileTextIcon };

const MAX_BYTES = 15 * 1024 * 1024; // à garder en phase avec rag-extract-file
const ACCEPT = ".txt,.md,.csv,.json,.html,.pdf,.docx";

export function KnowledgeTab({ agent, workspaceId, projectId }: { agent: Agent; workspaceId: string | null; projectId: string | null }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<AddType>("text");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "url" | "text" | "file" | "saas_structure">("all");
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: sources, isLoading } = useQuery({
    queryKey: ["rag_sources", agent.id],
    enabled: !!agent.id,
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.status === "processing" || s.status === "pending") ? 3000 : 15000),
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as Source[];
    },
  });

  const all = sources ?? [];
  const ready = all.filter((s) => s.status === "ready");
  const pending = all.filter((s) => s.status === "processing" || s.status === "pending").length;
  const failed = all.filter((s) => s.status === "failed").length;
  const chunks = ready.reduce((n, s) => n + (s.chunk_count ?? 0), 0);
  const bytes = all.reduce((n, s) => n + (s.byte_size ?? 0), 0);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["rag_sources", agent.id] });

  async function remove(id: string) {
    await supabase.from("rag_sources").delete().eq("id", id);
    refresh();
  }

  function open(t: AddType) { setAddType(t); setAddOpen(true); }

  // Le fichier part dans le Storage, puis le serveur l'extrait et le vectorise.
  async function onFiles(files: FileList | File[] | null) {
    if (!files || !workspaceId || !projectId) return;
    setUploadErr(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_BYTES) throw new Error(`« ${file.name} » fait ${(file.size / 1048576).toFixed(1)} Mo, la limite est de 15 Mo.`);
        setUploading(file.name);
        const path = `${projectId}/${agent.id}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
        try {
          const { error } = await supabase.storage.from("rag-docs").upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
          if (error) throw new Error(error.message);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(/failed to fetch|networkerror|load failed/i.test(msg)
            ? `L'envoi de « ${file.name} » a été bloqué par le réseau. Vérifiez la connexion et la configuration CORS du stockage.`
            : `L'envoi de « ${file.name} » a échoué : ${msg}`);
        }
        try {
          await callEdge("rag-extract-file", {
            workspace_id: workspaceId, project_id: projectId, agent_id: agent.id,
            title: file.name, storage_path: path, mime: file.type,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(/failed to fetch|networkerror|load failed/i.test(msg)
            ? `Le fichier « ${file.name} » est envoyé mais le serveur n'a pas pu être joint pour le lire. Réessayez.`
            : `« ${file.name} » n'a pas pu être lu : ${msg}`);
        }
      }
      refresh();
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = all.filter((s) => (filter === "all" || s.type === filter) && (!q || s.title.toLowerCase().includes(q)));
  const counts = all.reduce<Record<string, number>>((m, s) => ({ ...m, [s.type]: (m[s.type] ?? 0) + 1 }), {});

  const ADD: Array<{ key: string; icon: PhosphorIcon; label: string; sub: string; onClick: () => void }> = [
    { key: "url", icon: GlobeIcon, label: "Page web", sub: "Une URL, lue et découpée", onClick: () => open("url") },
    { key: "text", icon: TextTIcon, label: "Texte libre", sub: "FAQ, procédure, notes", onClick: () => open("text") },
    { key: "saas", icon: GridFourIcon, label: "Structure de l'app", sub: "Les pages du dernier scan", onClick: () => open("saas_structure") },
  ];

  return (
    <PaPage>
      <PaHeader
        title="Connaissances"
        sub="Ce que l'agent lit avant de répondre"
        actions={
          <>
            <Button variant="outline" className="rounded-full" onClick={() => open("url")}><GlobeIcon className="h-4 w-4" /> Page web</Button>
            <Button className="rounded-full" onClick={() => fileRef.current?.click()} disabled={!!uploading}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadSimpleIcon className="h-4 w-4" />} Importer
            </Button>
          </>
        }
      />

      <PaKpiGrid>
        <PaKpi
          icon={StackIcon} label="Sources" value={nf(all.length)}
          sub={`${ready.length} prête${ready.length > 1 ? "s" : ""}`}
          meter={all.length ? { label: "Indexées", pct: Math.round((ready.length / all.length) * 100), tone: failed ? "warn" : "accent" } : undefined}
        />
        <PaKpi icon={DatabaseIcon} label="Passages" value={nf(chunks)} sub="morceaux que l'agent peut retrouver" />
        <PaKpi icon={HardDrivesIcon} label="Stockage" value={fmtBytes(bytes)} sub="texte extrait, tous types" />
        <PaKpi
          icon={ArrowsClockwiseIcon} label="Indexation" value={pending ? nf(pending) : failed ? nf(failed) : "OK"}
          sub={pending ? "en cours" : failed ? `source${failed > 1 ? "s" : ""} en échec` : "tout est à jour"}
        />
      </PaKpiGrid>

      <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => void onFiles(e.target.files)} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── La bibliothèque ── */}
        <PaCard
          title="Bibliothèque"
          sub={all.length ? `${filtered.length} sur ${all.length}` : "vide"}
          live={pending > 0}
          bodyClassName="pt-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <MagnifyingGlassIcon className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <SoftInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une source" className="pl-10" />
            </div>
            <PaSegmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `Toutes ${all.length}` },
                ...(["url", "file", "text", "saas_structure"] as const)
                  .filter((t) => counts[t])
                  .map((t) => ({ value: t, label: `${typeMeta(t).label} ${counts[t]}` })),
              ]}
            />
          </div>

          {uploadErr && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.06] p-3 text-[13px] text-red-700 dark:text-red-400">
              <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0" /> {uploadErr}
            </div>
          )}

          {isLoading ? (
            <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-14 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <BookOpenIcon className="h-5 w-5" />
              </span>
              <div className="text-[14px] font-medium">{all.length ? "Aucune source ne correspond" : "Aucune source pour l'instant"}</div>
              <p className="max-w-sm text-[13px] text-muted-foreground">
                {all.length ? "Changez la recherche ou le filtre." : "Importez un fichier, collez une page web ou écrivez une FAQ."}
              </p>
            </div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-xl border border-border/70">
              <div className="hidden grid-cols-[minmax(0,1fr)_120px_110px_90px_90px_40px] gap-3 border-b border-border/70 bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
                <span>Source</span><span>Type</span><span>État</span><span className="text-right">Passages</span><span className="text-right">Ajoutée</span><span />
              </div>
              <ul className="divide-y divide-border/70">
                {filtered.map((s) => <SourceRow key={s.id} source={s} onRemove={() => void remove(s.id)} />)}
              </ul>
            </div>
          )}
        </PaCard>

        {/* ── Ajouter ── */}
        <div className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void onFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed p-7 text-center transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/50 hover:bg-muted/30",
            )}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileArrowUpIcon weight="duotone" className="h-5 w-5" />}
            </span>
            <div className="text-[14px] font-medium">{uploading ? `Envoi de ${uploading}…` : "Déposez vos fichiers ici"}</div>
            <div className="text-[12px] text-muted-foreground">PDF, Word, Markdown, CSV, HTML · 15 Mo max</div>
          </div>

          {ADD.map((a) => (
            <button
              key={a.key}
              onClick={a.onClick}
              className="group flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground group-hover:text-foreground">
                <a.icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">{a.label}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{a.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <AddSourceDialog
        open={addOpen}
        type={addType}
        onType={setAddType}
        onClose={() => setAddOpen(false)}
        onAdded={() => { refresh(); setAddOpen(false); }}
        agent={agent}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </PaPage>
  );
}

function SourceRow({ source, onRemove }: { source: Source; onRemove: () => void }) {
  const meta = typeMeta(source.type);
  const pending = source.status === "processing" || source.status === "pending";
  const failed = source.status === "failed";
  return (
    <li className="group grid grid-cols-[minmax(0,1fr)_40px] items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_120px_110px_90px_90px_40px]">
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground",
          failed && "border-red-500/20 bg-red-500/5 text-red-600 dark:text-red-400",
        )}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <meta.icon className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" title={source.title}>{source.title}</div>
          {source.error_message
            ? <div className="truncate text-[12px] text-red-600 dark:text-red-400" title={source.error_message}>{source.error_message}</div>
            : <div className="truncate text-[12px] text-muted-foreground md:hidden">{meta.label} · {fmtBytes(source.byte_size ?? 0)}</div>}
        </div>
      </div>
      <span className="hidden text-[13px] text-muted-foreground md:block">{meta.label}</span>
      <span className="hidden md:block">
        <PaStatus tone={source.status === "ready" ? "ok" : failed ? "error" : "live"}>
          {source.status === "ready" ? "Prête" : failed ? "Échec" : "Indexation"}
        </PaStatus>
      </span>
      <span className="hidden text-right text-[13px] tabular-nums md:block">{source.status === "ready" ? nf(source.chunk_count) : "–"}</span>
      <span className="hidden text-right text-[12px] text-muted-foreground md:block">{formatRelative(source.created_at)}</span>
      <button
        onClick={onRemove}
        aria-label={`Supprimer ${source.title}`}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </li>
  );
}

function AddSourceDialog({ open, type, onType, onClose, onAdded, agent, workspaceId, projectId }: {
  open: boolean; type: AddType; onType: (t: AddType) => void; onClose: () => void; onAdded: () => void;
  agent: Agent; workspaceId: string | null; projectId: string | null;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);

  async function ingest() {
    if (!workspaceId || !projectId) return;
    setBusy(true); setError(null);
    try {
      const payload: Record<string, unknown> = {
        workspace_id: workspaceId, project_id: projectId, agent_id: agent.id, type,
        title: title || (type === "saas_structure" ? "Structure de l'app" : type === "url" ? url : "Texte"),
      };
      if (type === "text") payload.content = content;
      if (type === "url") payload.url = url;
      await callEdge("rag-ingest", payload);
      setTitle(""); setContent(""); setUrl("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg overflow-x-hidden scrollbar-hide">
        <DialogHeader><DialogTitle>Ajouter une source</DialogTitle></DialogHeader>
        <div className="min-w-0 space-y-4">
          <PaSegmented
            value={type}
            onChange={onType}
            options={[
              { value: "url", label: "Page web", icon: GlobeIcon },
              { value: "text", label: "Texte", icon: TextTIcon },
              { value: "saas_structure", label: "Structure", icon: GridFourIcon },
            ]}
          />
          {type !== "saas_structure" && <SoftInput placeholder="Titre (facultatif)" value={title} onChange={(e) => setTitle(e.target.value)} />}
          {type === "text" && (
            <SoftTextarea placeholder="Collez une FAQ, une procédure, des conditions…" value={content} onChange={(e) => setContent(e.target.value)} rows={8} />
          )}
          {type === "url" && <SoftInput placeholder="https://docs.exemple.com/page" value={url} onChange={(e) => setUrl(e.target.value)} />}
          {type === "saas_structure" && (
            <p className="rounded-xl bg-muted/50 p-3.5 text-[13px] text-muted-foreground">
              Importe les pages de votre app depuis le dernier scan de code. Lancez un scan d'abord.
            </p>
          )}
          {error && <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button
              className="rounded-full"
              onClick={() => void ingest()}
              disabled={busy || (type === "text" && !content.trim()) || (type === "url" && !url.trim())}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SparkleIcon className="h-4 w-4" />} Indexer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
