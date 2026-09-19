import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  PlusIcon as Plus,
  BooksIcon as Library,
  UploadSimpleIcon as Upload,
  SlidersHorizontalIcon as Settings2,
  TrashIcon as Trash2,
  FolderPlusIcon as FolderPlus,
  ArrowLeftIcon as ArrowLeft,
  PencilLineIcon as PenLine,
  FileTextIcon as FileText,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { CollectionFolderCard, fileKindOf } from "./FileFolderGallery";
import { FileCard, formatOfSource } from "./FileCard";
import { DocumentAiWorkspace, type WorkspaceSource } from "./DocumentAiWorkspace";
import { ProcedureEditor, type ProcedureSource } from "./ProcedureEditor";

interface Collection { id: string; name: string; description: string | null; enabled: boolean; created_at: string }
interface SourceRow { id: string; collection_id: string; type: string; title: string; source_ref: string | null; status: string; metadata?: { body?: string; authored?: boolean } | null }

// The Document-AI workspace target: a new local file, or an existing source.
type WsTarget = { kind: "new"; file: File } | { kind: "existing"; source: WorkspaceSource };

export function KnowledgeCollectionsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: collections, isLoading } = useQuery({
    queryKey: ["rag_collections", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_collections").select("id, name, description, enabled, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Collection[];
    },
  });

  const { data: sources } = useQuery({
    queryKey: ["rag_sources_by_collection", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources")
        .select("id, collection_id, type, title, source_ref, status, metadata")
        .eq("project_id", projectId!).not("collection_id", "is", null)
        .order("created_at", { ascending: false });
      return (data ?? []) as SourceRow[];
    },
    refetchInterval: (q) => ((q.state.data as SourceRow[] | undefined)?.some((s) => s.status === "processing") ? 3000 : false),
  });

  const byCollection = useMemo(() => {
    const map = new Map<string, SourceRow[]>();
    for (const s of sources ?? []) {
      const arr = map.get(s.collection_id) ?? [];
      arr.push(s);
      map.set(s.collection_id, arr);
    }
    return map;
  }, [sources]);

  async function createCollection(draft: { name: string; description: string }) {
    if (!workspaceId || !projectId || !draft.name.trim()) return;
    await supabase.from("rag_collections").insert({
      workspace_id: workspaceId, project_id: projectId, name: draft.name.trim(),
      description: draft.description || null, created_by: user?.id ?? null,
    });
    qc.invalidateQueries({ queryKey: ["rag_collections", projectId] });
    setNewOpen(false);
  }

  const openCollection = (collections ?? []).find((c) => c.id === openId) ?? null;

  if (openCollection) {
    return (
      <CollectionDetail
        collection={openCollection}
        files={byCollection.get(openCollection.id) ?? []}
        onBack={() => setOpenId(null)}
        onChanged={() => qc.invalidateQueries({ queryKey: ["rag_sources_by_collection", projectId] })}
        onDeleted={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ["rag_collections", projectId] }); qc.invalidateQueries({ queryKey: ["rag_sources_by_collection", projectId] }); }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-7xl space-y-4">
        <PageHeader
          title="Base de connaissances"
          description="Vos collections de connaissances — documents, PDF, Word, Excel, images… Cliquez une collection pour l'ouvrir."
          actions={<Button size="sm" onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> Nouvelle collection</Button>}
        />

        {isLoading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (collections ?? []).length === 0 ? (
          <EmptyState
            icon={Library}
            title="Aucune collection"
            description="Une collection regroupe des fichiers (PDF, DOCX, XLSX, images, notes) réutilisables par vos agents."
            action={<Button size="sm" onClick={() => setNewOpen(true)}><FolderPlus className="mr-1.5 h-4 w-4" /> Créer une collection</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(collections ?? []).map((c) => {
              const files = byCollection.get(c.id) ?? [];
              return (
                <CollectionFolderCard
                  key={c.id}
                  folderName={c.name}
                  count={files.length}
                  kinds={files.map((f) => fileKindOf(f))}
                  onOpen={() => setOpenId(c.id)}
                />
              );
            })}
          </div>
        )}

        <NewCollectionDialog open={newOpen} onOpenChange={setNewOpen} onCreate={createCollection} />
      </div>
    </div>
  );
}

function CollectionDetail({ collection, files, onBack, onChanged, onDeleted }: {
  collection: Collection; files: SourceRow[]; onBack: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const [ws, setWs] = useState<WsTarget | null>(null);
  /** "new" opens a blank procedure; a source opens it for editing. */
  const [proc, setProc] = useState<"new" | ProcedureSource | null>(null);
  // Written procedures are text sources we authored — told apart from an
  // ingested .txt by the flag the editor stamps on them.
  const written = files.filter((f) => f.type === "text" && f.metadata?.authored);
  const documents = files.filter((f) => !(f.type === "text" && f.metadata?.authored));

  async function remove() {
    if (!confirm("Supprimer cette collection et tous ses fichiers ? Les agents qui l'utilisent perdront cette connaissance.")) return;
    await supabase.from("rag_collections").delete().eq("id", collection.id);
    onDeleted();
  }

  // ── Written procedure (markdown, same editor as skills and playbooks) ──
  if (proc && workspaceId && projectId) {
    return (
      <ProcedureEditor
        key={proc === "new" ? "new" : proc.id}
        collectionId={collection.id}
        workspaceId={workspaceId}
        projectId={projectId}
        source={proc === "new" ? undefined : proc}
        onClose={() => setProc(null)}
        onSaved={onChanged}
      />
    );
  }

  // ── Document-AI extraction workspace (full-width, with margins) ──
  if (ws && workspaceId && projectId) {
    return (
      <DocumentAiWorkspace
        key={ws.kind === "new" ? ws.file.name + ws.file.size : ws.source.id}
        mode={ws.kind}
        collectionId={collection.id}
        workspaceId={workspaceId}
        projectId={projectId}
        file={ws.kind === "new" ? ws.file : undefined}
        source={ws.kind === "existing" ? ws.source : undefined}
        onClose={() => setWs(null)}
        onIngested={onChanged}
        onAddFile={(f) => setWs({ kind: "new", file: f })}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-7xl">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Collections</Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{collection.name}</h1>
            {collection.description && <p className="truncate text-xs text-muted-foreground">{collection.description}</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => setProc("new")}>
            <PenLine className="mr-1 h-3.5 w-3.5" /> Rédiger une procédure
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/40">
            <Upload className="h-3.5 w-3.5" /> Ajouter des fichiers
            <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setWs({ kind: "new", file: f }); e.target.value = ""; }} />
          </label>
          <Button size="sm" variant="outline" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/knowledge/${collection.id}`)}>
            <Settings2 className="mr-1 h-3.5 w-3.5" /> Gérer
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-red-500" onClick={remove}><Trash2 className="h-4 w-4" /></Button>
        </div>

        {/* Written procedures — listed apart from imported documents: one is
            authored here and re-editable, the other is an extraction. */}
        {written.length > 0 && (
          <section className="pt-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Procédures rédigées
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {written.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setProc({ id: f.id, title: f.title, metadata: f.metadata ?? null })}
                  className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-card p-3 text-left transition-colors hover:border-primary/50"
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.title}</span>
                    <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                      {(f.metadata?.body ?? "").replace(/[#*`>_\n]+/g, " ").trim().slice(0, 120) || "Vide"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Imported documents */}
        <div className="py-5">
          {documents.length === 0 ? (
            written.length === 0 ? (
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-sm text-muted-foreground hover:bg-muted/20">
                <Upload className="h-6 w-6" />
                <span>Collection vide — importez un fichier (PDF, DOCX, XLSX, images…) ou rédigez une procédure.</span>
                <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setWs({ kind: "new", file: f }); e.target.value = ""; }} />
              </label>
            ) : null
          ) : (
            <>
              {written.length > 0 && (
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Documents importés
                </h2>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-x-2 gap-y-5">
                {documents.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setWs({ kind: "existing", source: f })}
                    className={cn("group flex flex-col items-center gap-2 rounded-lg p-2 text-center transition-colors hover:bg-muted/40")}
                    title={f.title}
                  >
                    <FileCard formatFile={formatOfSource(f)} />
                    <span className="w-full truncate text-[11px] text-muted-foreground">{f.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NewCollectionDialog({ open, onOpenChange, onCreate }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: { name: string; description: string }) => Promise<void>;
}) {
  const [d, setD] = useState({ name: "", description: "" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.name.trim()) return; setSaving(true); try { await onCreate(d); setD({ name: "", description: "" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Library className="h-4 w-4 text-primary" /> Nouvelle collection</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Nom</label>
            <Input value={d.name} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} autoFocus placeholder="Docs produit, Base légale…" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
            <Input value={d.description} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))} placeholder="Ce que couvre cette base de connaissances" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={saving || !d.name.trim()}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Créer</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
