// Ressources › Sources › RAG : les collections de connaissances du projet.
//
// Une collection regroupe des sources (texte, page web, fichier). Chaque source
// passe par le pipeline : extraction, découpage, vectorisation (le modèle
// d'embeddings de la passerelle), rangement dans rag_chunks. Une collection
// activée sur un agent devient interrogeable par son outil rag_search ; l'essai
// de recherche ici emprunte le même chemin.
//
// Un fichier s'ouvre dans l'atelier Document AI (réglages d'extraction, aperçu,
// résultat, puis vectorisation) ; une procédure se rédige dans l'éditeur. Les
// deux viennent de l'ancienne « Base de connaissances », retirée du rail.

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ArrowClockwiseIcon, BooksIcon, CheckCircleIcon, CircleNotchIcon, CloudArrowUpIcon, DatabaseIcon,
  FileTextIcon, GlobeIcon, MagnifyingGlassIcon, PencilLineIcon, PlusIcon, PowerIcon, RobotIcon, TextAaIcon, TrashIcon, WarningIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { DocumentAiWorkspace, type WorkspaceSource } from "./DocumentAiWorkspace";
import { ProcedureEditor, type ProcedureSource } from "./ProcedureEditor";
import {
  collectionStats, createCollection, deleteCollection, deleteSource, ingestFile, ingestText, ingestUrl,
  listActivations, listCollections, listSources, retrySource, searchCollections, setActivation, updateCollection,
  type RagCollection, type RagHit, type RagSource,
} from "./api";

const STATUS: Record<string, { label: string; cls: string }> = {
  ready: { label: "Vectorisée", cls: "text-emerald-600" },
  processing: { label: "En cours", cls: "text-amber-600" },
  pending: { label: "En attente", cls: "text-muted-foreground" },
  failed: { label: "Échec", cls: "text-destructive" },
};
const SOURCE_ICON: Record<string, typeof FileTextIcon> = { text: TextAaIcon, url: GlobeIcon, document: FileTextIcon };

/** L'atelier Document AI : un fichier à extraire, ou une source à rouvrir. */
type DocTarget = { kind: "new"; file: File } | { kind: "existing"; source: WorkspaceSource };
/** L'éditeur de procédures : une nouvelle, ou une existante. */
type ProcTarget = "new" | ProcedureSource;
interface Openers { openDocument: (t: DocTarget) => void; openProcedure: (p: ProcTarget) => void }

export function RagSourcesPanel({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("collection");
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("collection", id); else next.delete("collection");
    setParams(next, { replace: true });
  };
  const [creating, setCreating] = useState(false);
  const [doc, setDoc] = useState<DocTarget | null>(null);
  const [proc, setProc] = useState<ProcTarget | null>(null);
  const queryClient = useQueryClient();

  const { data: collections, isLoading } = useQuery({
    queryKey: ["rag_collections", projectId],
    queryFn: () => listCollections(projectId),
  });
  const selected = (collections ?? []).find((c) => c.id === selectedId) ?? (collections ?? [])[0] ?? null;
  const refreshSelected = () => {
    if (!selected) return;
    queryClient.invalidateQueries({ queryKey: ["rag_sources", selected.id] });
    queryClient.invalidateQueries({ queryKey: ["rag_collection_stats", selected.id] });
  };

  // ── Atelier Document AI : charger, régler l'extraction, relire, vectoriser ──
  if (doc && selected) {
    return (
      <div className="h-full">
        <DocumentAiWorkspace
          key={doc.kind === "new" ? doc.file.name + doc.file.size : doc.source.id}
          mode={doc.kind}
          collectionId={selected.id}
          workspaceId={workspaceId}
          projectId={projectId}
          file={doc.kind === "new" ? doc.file : undefined}
          source={doc.kind === "existing" ? doc.source : undefined}
          onClose={() => { setDoc(null); refreshSelected(); }}
          onIngested={refreshSelected}
          onAddFile={(f) => setDoc({ kind: "new", file: f })}
        />
      </div>
    );
  }
  // ── Procédure rédigée (markdown, le même éditeur que les skills) ──
  if (proc && selected) {
    return (
      <div className="h-full">
        <ProcedureEditor
          key={proc === "new" ? "new" : proc.id}
          collectionId={selected.id}
          workspaceId={workspaceId}
          projectId={projectId}
          source={proc === "new" ? undefined : proc}
          onClose={() => { setProc(null); refreshSelected(); }}
          onSaved={refreshSelected}
        />
      </div>
    );
  }
  const openers: Openers = { openDocument: setDoc, openProcedure: setProc };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <DatabaseIcon className="h-5 w-5 text-indigo-500" />
            <h1 className="text-xl font-semibold">RAG</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Des collections de connaissances. Chaque élément ajouté est découpé et vectorisé ; une collection activée
            sur un collaborateur devient une source qu'il interroge pendant ses missions.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}><PlusIcon className="mr-1 h-4 w-4" /> Nouvelle collection</Button>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (collections ?? []).length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border p-10 text-center">
          <BooksIcon className="h-7 w-7 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">Aucune collection. Commencez par en créer une : documentation d'exploitation, procédures, runbooks…</p>
          <Button size="sm" onClick={() => setCreating(true)}><PlusIcon className="mr-1 h-4 w-4" /> Créer une collection</Button>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          <nav className="space-y-1.5">
            {(collections ?? []).map((c) => (
              <CollectionRow key={c.id} c={c} active={selected?.id === c.id} onClick={() => select(c.id)} />
            ))}
          </nav>
          {selected && (
            <CollectionDetail
              key={selected.id} collection={selected} workspaceId={workspaceId} projectId={projectId}
              onDeleted={() => select(null)} openers={openers}
            />
          )}
        </div>
      )}

      <NewCollectionDialog
        open={creating} onOpenChange={setCreating} workspaceId={workspaceId} projectId={projectId}
        onCreated={(c) => { setCreating(false); select(c.id); }}
      />
    </div>
  );
}

function CollectionRow({ c, active, onClick }: { c: RagCollection; active: boolean; onClick: () => void }) {
  const { data: stats } = useQuery({ queryKey: ["rag_collection_stats", c.id], queryFn: () => collectionStats(c.id) });
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
        active ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30 hover:bg-muted/30",
      )}
    >
      <div className="flex items-center gap-2">
        <BooksIcon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
        {!c.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Désactivée</span>}
      </div>
      <div className="mt-1 flex gap-3 pl-6 text-[11px] text-muted-foreground">
        <span>{stats?.sources ?? 0} source(s)</span>
        <span>{stats?.chunks ?? 0} passages</span>
        <span>{stats?.agents ?? 0} agent(s)</span>
      </div>
    </button>
  );
}

function CollectionDetail({ collection, workspaceId, projectId, onDeleted, openers }: {
  collection: RagCollection; workspaceId: string; projectId: string; onDeleted: () => void; openers: Openers;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const scope = { workspaceId, projectId, collectionId: collection.id };
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["rag_sources", collection.id] });
    queryClient.invalidateQueries({ queryKey: ["rag_collection_stats", collection.id] });
  };

  const { data: sources, isLoading } = useQuery({
    queryKey: ["rag_sources", collection.id],
    queryFn: () => listSources(collection.id),
    // Tant qu'une source est dans le pipeline, on suit son état.
    refetchInterval: (q) => ((q.state.data as RagSource[] | undefined)?.some((s) => s.status === "processing" || s.status === "pending") ? 3000 : false),
  });

  async function toggleEnabled() {
    await updateCollection(collection.id, { enabled: !collection.enabled });
    queryClient.invalidateQueries({ queryKey: ["rag_collections", projectId] });
  }
  async function remove() {
    if (!(await confirm(`Supprimer « ${collection.name} » et ses sources ? Les agents qui l'utilisent perdront ces connaissances.`))) return;
    await deleteCollection(collection.id);
    queryClient.invalidateQueries({ queryKey: ["rag_collections", projectId] });
    onDeleted();
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{collection.name}</h2>
          {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={() => openers.openProcedure("new")}>
          <PencilLineIcon className="mr-1 h-3.5 w-3.5" /> Rédiger une procédure
        </Button>
        <Button size="sm" variant="outline" onClick={toggleEnabled}>
          <PowerIcon className="mr-1 h-3.5 w-3.5" /> {collection.enabled ? "Désactiver" : "Activer"}
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={remove} aria-label="Supprimer la collection">
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>

      <AddSource scope={scope} onAdded={refresh} onExtract={(file) => openers.openDocument({ kind: "new", file })} />

      <section className="rounded-2xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-medium">Sources</span>
          <button onClick={refresh} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Rafraîchir">
            <ArrowClockwiseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center"><CircleNotchIcon className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (sources ?? []).length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Aucune source. Ajoutez un texte, une page web ou un fichier ci-dessus.</p>
        ) : (
          <div className="divide-y divide-border">
            {(sources ?? []).map((s) => (
              <SourceRow key={s.id} s={s}
                onDelete={async () => { await deleteSource(s.id); refresh(); }}
                onRetry={async () => { if (await retrySource(scope, s)) refresh(); }}
                onOpen={
                  s.type === "text" && s.metadata?.authored ? () => openers.openProcedure({ id: s.id, title: s.title, metadata: s.metadata })
                  : s.type === "document" ? () => openers.openDocument({ kind: "existing", source: s })
                  : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <SearchTest collectionId={collection.id} workspaceId={workspaceId} projectId={projectId} />
        <Activation collectionId={collection.id} workspaceId={workspaceId} projectId={projectId} />
      </div>
    </div>
  );
}

function SourceRow({ s, onDelete, onRetry, onOpen }: { s: RagSource; onDelete: () => void; onRetry: () => void; onOpen?: () => void }) {
  const Icon = s.type === "text" && s.metadata?.authored ? PencilLineIcon : SOURCE_ICON[s.type] ?? FileTextIcon;
  const st = STATUS[s.status] ?? { label: s.status, cls: "text-muted-foreground" };
  return (
    <div className="group flex items-center gap-3 px-4 py-2.5">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {onOpen ? (
          <button onClick={onOpen} className="block max-w-full truncate text-left text-sm hover:underline"
            title={s.type === "document" ? "Ouvrir dans l'atelier Document AI" : "Modifier la procédure"}>
            {s.title}
          </button>
        ) : (
          <div className="truncate text-sm">{s.title}</div>
        )}
        <div className="flex items-center gap-2 text-[11px]">
          <span className={cn("flex items-center gap-1", st.cls)}>
            {s.status === "ready" ? <CheckCircleIcon className="h-3 w-3" />
              : s.status === "failed" ? <WarningIcon className="h-3 w-3" />
              : <CircleNotchIcon className="h-3 w-3 animate-spin" />}
            {st.label}
          </span>
          {s.status === "ready" && <span className="text-muted-foreground">· {s.chunk_count} passages</span>}
          {s.error_message && <span className="truncate text-destructive" title={s.error_message}>· {s.error_message}</span>}
        </div>
      </div>
      {s.status === "failed" && s.type === "url" && (
        <button onClick={onRetry} className="rounded p-1 text-muted-foreground hover:text-foreground" title="Relancer">
          <ArrowClockwiseIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <button onClick={onDelete} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" aria-label="Supprimer la source">
        <TrashIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type Kind = "text" | "url" | "file";

function AddSource({ scope, onAdded, onExtract }: {
  scope: { workspaceId: string; projectId: string; collectionId: string };
  onAdded: () => void;
  /** Ouvre l'atelier Document AI sur ce fichier : réglages d'extraction, aperçu, vectorisation. */
  onExtract: (file: File) => void;
}) {
  const [kind, setKind] = useState<Kind>("file");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setError(null);
    try {
      await fn();
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onAdded(); // la source en échec apparaît avec sa cause
    } finally {
      setBusy(null);
    }
  }
  // Un fichier : l'atelier Document AI. Plusieurs d'un coup : vectorisés
  // directement, avec les réglages par défaut.
  async function files(list: FileList | null) {
    if (!list?.length) return;
    if (list.length === 1) onExtract(list[0]);
    else for (const f of Array.from(list)) await run(f.name, () => ingestFile(scope, f));
    if (fileRef.current) fileRef.current.value = "";
  }

  const tabs: Array<{ k: Kind; label: string; icon: typeof FileTextIcon }> = [
    { k: "file", label: "Fichiers", icon: CloudArrowUpIcon },
    { k: "url", label: "Page web", icon: GlobeIcon },
    { k: "text", label: "Texte", icon: TextAaIcon },
  ];

  return (
    <section className="rounded-2xl border border-border p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <span className="mr-2 text-sm font-medium">Ajouter</span>
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setKind(t.k)}
            className={cn("flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors",
              kind === t.k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50")}>
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {kind === "file" && (
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void files(e.dataTransfer.files); }}
          className={cn("flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed py-7 text-sm text-muted-foreground transition-colors",
            drag ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/30")}
        >
          <CloudArrowUpIcon className="h-6 w-6" />
          <span>Déposez un fichier ou cliquez : il s'ouvre dans l'atelier Document AI pour régler l'extraction avant la vectorisation</span>
          <span className="text-[11px]">PDF, DOCX, TXT, Markdown, CSV, JSON, HTML, 15 Mo au plus. Plusieurs fichiers à la fois : vectorisés directement.</span>
          <input ref={fileRef} type="file" multiple className="hidden"
            accept=".pdf,.txt,.md,.markdown,.docx,.doc,.csv,.json,.html,.htm"
            onChange={(e) => void files(e.target.files)} />
        </label>
      )}
      {kind === "url" && (
        <div className="flex gap-2">
          <Input placeholder="https://docs.interne.exemple/runbook" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button disabled={!url.trim() || !!busy} onClick={() => run(url, async () => { await ingestUrl(scope, url.trim()); setUrl(""); })}>
            Vectoriser
          </Button>
        </div>
      )}
      {kind === "text" && (
        <div className="space-y-2">
          <Input placeholder="Titre" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            placeholder="Collez une procédure, une FAQ, des notes…" value={text} onChange={(e) => setText(e.target.value)} rows={5}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end">
            <Button disabled={!text.trim() || !!busy} onClick={() => run(title || "Texte", async () => { await ingestText(scope, title, text); setText(""); setTitle(""); })}>
              Vectoriser
            </Button>
          </div>
        </div>
      )}
      {busy && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><CircleNotchIcon className="h-3.5 w-3.5 animate-spin" /> Vectorisation de {busy}…</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}

function SearchTest({ collectionId, workspaceId, projectId }: { collectionId: string; workspaceId: string; projectId: string }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RagHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setBusy(true); setError(null);
    try {
      setHits(await searchCollections({ workspaceId, projectId, collectionIds: [collectionId], query: query.trim() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium"><MagnifyingGlassIcon className="h-4 w-4" /> Essayer une recherche</div>
      <p className="mb-3 text-[11px] text-muted-foreground">Les passages qu'un agent trouverait pour cette question, avec leur proximité.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <Input placeholder="ex. Comment redémarrer l'API de paiement en NPR ?" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" disabled={busy || !query.trim()}>{busy ? <CircleNotchIcon className="h-4 w-4 animate-spin" /> : "Chercher"}</Button>
      </form>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {hits && (
        hits.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">Aucun passage : la collection est vide ou encore en cours de vectorisation.</p> : (
          <ol className="mt-3 space-y-2">
            {hits.map((h) => (
              <li key={h.id} className="rounded-lg border border-border p-2.5">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{Math.round(h.similarity * 100)} %</span>
                  <span className="truncate">{h.source ?? "source inconnue"}</span>
                </div>
                <p className="line-clamp-4 text-xs leading-relaxed">{h.content}</p>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  );
}

function Activation({ collectionId, workspaceId, projectId }: { collectionId: string; workspaceId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const { data: agents } = useQuery({
    queryKey: ["internal_agents_for_rag", projectId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name").eq("project_id", projectId).eq("is_archived", false).order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const { data: active } = useQuery({ queryKey: ["rag_collection_agents", collectionId], queryFn: () => listActivations(collectionId) });
  const on = useMemo(() => active ?? new Set<string>(), [active]);

  async function toggle(agentId: string) {
    setPending(agentId);
    try {
      await setActivation({ workspaceId, projectId, collectionId, agentId, on: !on.has(agentId) });
      queryClient.invalidateQueries({ queryKey: ["rag_collection_agents", collectionId] });
      queryClient.invalidateQueries({ queryKey: ["rag_collection_stats", collectionId] });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rounded-2xl border border-border p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium"><RobotIcon className="h-4 w-4" /> Collaborateurs qui l'utilisent</div>
      <p className="mb-3 text-[11px] text-muted-foreground">Un collaborateur activé reçoit l'outil de recherche, limité aux collections qu'on lui active.</p>
      {(agents ?? []).length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">Aucun collaborateur dans ce projet.</p>
      ) : (
        <div className="space-y-1.5">
          {(agents ?? []).map((a) => {
            const isOn = on.has(a.id);
            return (
              <button key={a.id} onClick={() => toggle(a.id)} disabled={pending === a.id}
                className={cn("flex w-full items-center gap-2 rounded-lg border p-2 text-left text-sm transition-colors",
                  isOn ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/40")}>
                <RobotIcon className={cn("h-4 w-4", isOn ? "text-primary" : "text-muted-foreground")} />
                <span className="flex-1 truncate">{a.name}</span>
                {pending === a.id ? <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" />
                  : <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", isOn ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>{isOn ? "Activée" : "Non"}</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function NewCollectionDialog({ open, onOpenChange, workspaceId, projectId, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; workspaceId: string; projectId: string; onCreated: (c: RagCollection) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setSaving(true); setError(null);
    try {
      const c = await createCollection({ workspaceId, projectId, userId: user?.id ?? null, name, description });
      queryClient.invalidateQueries({ queryKey: ["rag_collections", projectId] });
      setName(""); setDescription("");
      onCreated(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><BooksIcon className="h-4 w-4 text-primary" /> Nouvelle collection</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Nom</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Runbooks OpenShift, Procédures d'astreinte…" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ce que couvre cette collection" />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button type="submit" disabled={saving || !name.trim()}>{saving && <CircleNotchIcon className="mr-1 h-3.5 w-3.5 animate-spin" />}Créer</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
