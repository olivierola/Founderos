import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Plus, Code2, RotateCcw, Play, ChevronLeft, ChevronRight, Minus, ArrowLeft,
  ImageIcon, LayoutPanelTop, PanelBottom, Loader2, CheckCircle2, ExternalLink,
  HelpCircle, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { FileCard, formatOfSource, type FormatFileProps } from "./FileCard";
import { DocumentPreview } from "./DocumentPreview";

interface ExtractConfig {
  model: string;
  responseFormat: string | null;   // null = "Ajouter" not set
  pages: string;
  images: boolean;
  header: boolean;
  footer: boolean;
  boundingBoxes: boolean;
  tables: "markdown" | "separate" | "none";
  annotate: string | null;
  confidence: "none" | "page" | "block";
}
const DEFAULT: ExtractConfig = {
  model: "mistral-ocr-latest", responseFormat: null, pages: "",
  images: true, header: false, footer: false, boundingBoxes: true,
  tables: "markdown", annotate: null, confidence: "none",
};

const MODELS = [
  { id: "mistral-ocr-latest", label: "Mistral OCR Latest" },
  { id: "founderos-extract", label: "Anduran Extract" },
  { id: "fast-extract", label: "Extraction rapide" },
];

export interface WorkspaceSource { id: string; title: string; type: string; source_ref: string | null; status: string }

export function DocumentAiWorkspace({
  mode, collectionId, workspaceId, projectId, file, source, onClose, onIngested, onAddFile,
}: {
  mode: "new" | "existing";
  collectionId: string;
  workspaceId: string;
  projectId: string;
  file?: File;
  source?: WorkspaceSource;
  onClose: () => void;
  onIngested?: () => void;
  onAddFile?: (f: File) => void;
}) {
  const [config, setConfig] = useState<ExtractConfig>(DEFAULT);
  const set = <K extends keyof ExtractConfig>(k: K, v: ExtractConfig[K]) => setConfig((c) => ({ ...c, [k]: v }));
  const [phase, setPhase] = useState<"config" | "running" | "result">(mode === "existing" ? "config" : "config");
  const [newSourceId, setNewSourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [page, setPage] = useState(1);

  const fileName = mode === "new" ? file?.name ?? "document" : source?.title ?? "document";
  const format: FormatFileProps = mode === "new"
    ? formatOfSource({ type: "document", title: fileName })
    : formatOfSource(source ?? { type: "document", title: fileName });
  // Preview URL: object URL for a new local file, signed URL for an existing one.
  const objectUrl = useMemo(() => (mode === "new" && file ? URL.createObjectURL(file) : null), [mode, file]);
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);
  const { data: signedUrl } = useQuery({
    queryKey: ["ws_preview", source?.id, source?.source_ref],
    enabled: mode === "existing" && source?.type === "document" && !!source?.source_ref,
    queryFn: async () => {
      const { data } = await supabase.storage.from("rag-docs").createSignedUrl(source!.source_ref!, 3600);
      return data?.signedUrl ?? null;
    },
  });
  const previewUrl = objectUrl ?? signedUrl ?? null;

  const effectiveSourceId = mode === "existing" ? source?.id ?? null : newSourceId;

  async function run() {
    setError(null);
    if (mode === "existing") { setPhase("result"); return; }
    if (!file) return;
    setPhase("running");
    try {
      const path = `${projectId}/collection-${collectionId}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
      const { error: upErr } = await supabase.storage.from("rag-docs").upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
      if (upErr) throw new Error(upErr.message);
      const res = await callEdge<{ source_id?: string }>("rag-extract-file", {
        workspace_id: workspaceId, project_id: projectId, collection_id: collectionId,
        title: file.name, storage_path: path, mime: file.type, config,
      });
      setNewSourceId(res?.source_id ?? null);
      onIngested?.();
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("config");
    }
  }

  // Ctrl/Cmd+Enter → run.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (phase !== "running") void run(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const statusLabel = mode === "new"
    ? (phase === "running" ? "Ajout de 1 fichier…" : phase === "result" ? "Chargé" : "Prêt")
    : "Chargé";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card">
      {/* wrapper fills the whole content zone (no floating margins) */}
      <div className="flex h-full flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <button onClick={onClose} className="flex items-center gap-2 text-base font-semibold hover:opacity-80" title="Retour">
            <ArrowLeft className="h-4 w-4 text-muted-foreground" /> Document AI
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
              <Plus className="h-4 w-4" /> Ajouter des fichiers
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onAddFile?.(f); }} />
            </label>
            <Button size="sm" variant="outline" onClick={() => setShowCode(true)}><Code2 className="mr-1.5 h-4 w-4" /> Code</Button>
            <Button size="sm" variant="outline" onClick={() => { setConfig(DEFAULT); setPhase("config"); setError(null); }}>
              <RotateCcw className="mr-1.5 h-4 w-4" /> Recommencer
            </Button>
            <Button size="sm" onClick={run} disabled={phase === "running"} className="bg-orange-600 text-white hover:bg-orange-600/90">
              {phase === "running" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Exécuter (Ctrl+Enter)
            </Button>
          </div>
        </div>

        {/* Body : preview (left) + config/result (right) */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Left — preview */}
          <div className="flex min-h-0 flex-1 flex-col border-b border-border lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-2 px-4 py-2.5">
              <div className="scale-75 origin-left"><FileCard formatFile={format} /></div>
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={fileName}>{fileName}</span>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                {phase === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                {statusLabel}
              </span>
            </div>

            {/* Viewer toolbar */}
            <div className="flex items-center justify-center gap-2 bg-neutral-900 px-3 py-2 text-neutral-200">
              <ToolbarBtn onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" /></ToolbarBtn>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="rounded bg-neutral-800 px-2 py-0.5 tabular-nums">{page}</span>
                {["png", "jpg", "jpeg", "img"].includes(format) && <span className="text-neutral-400">/ 1</span>}
              </div>
              <ToolbarBtn onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></ToolbarBtn>
              <div className="mx-2 h-4 w-px bg-neutral-700" />
              <ToolbarBtn onClick={() => setZoom((z) => Math.max(25, z - 10))}><Minus className="h-4 w-4" /></ToolbarBtn>
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-sm tabular-nums">{zoom}%</span>
              <ToolbarBtn onClick={() => setZoom((z) => Math.min(300, z + 10))}><Plus className="h-4 w-4" /></ToolbarBtn>
            </div>

            {/* Preview area */}
            <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-4">
              <div className="mx-auto origin-top" style={{ width: `${zoom}%` }}>
                <DocumentPreview format={format} previewUrl={previewUrl} file={mode === "new" ? file : undefined} page={page} fileName={fileName} />
              </div>
            </div>
          </div>

          {/* Right — config or result */}
          <div className="flex w-full min-h-0 flex-col lg:w-[46%] lg:max-w-[640px]">
            {phase === "result"
              ? <ResultPane sourceId={effectiveSourceId} config={config} onReconfigure={() => setPhase("config")} />
              : <ConfigPane config={config} set={set} error={error} />}
          </div>
        </div>
      </div>

      <CodeDialog open={showCode} onClose={() => setShowCode(false)} fileName={fileName} config={config} />
    </div>
  );
}

// ── Config pane (copy of the Document-AI options) ────────────────────────────
function ConfigPane({ config, set, error }: {
  config: ExtractConfig;
  set: <K extends keyof ExtractConfig>(k: K, v: ExtractConfig[K]) => void;
  error: string | null;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error && <p className="m-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}

      <Row label="Modèle">
        <div className="flex flex-col items-end">
          <select value={config.model} onChange={(e) => set("model", e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none">
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span className="mt-0.5 text-[11px] text-muted-foreground">{config.model}</span>
        </div>
      </Row>

      <Row label="Format de réponse">
        {config.responseFormat == null ? (
          <AddBtn onClick={() => set("responseFormat", "")} />
        ) : (
          <input value={config.responseFormat} onChange={(e) => set("responseFormat", e.target.value)} placeholder="Schéma JSON…"
            className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm" />
        )}
      </Row>

      <Row label="Pages">
        <Input value={config.pages} onChange={(e) => set("pages", e.target.value)} placeholder='par ex. "1-4,8"' className="h-9 w-44 text-right" />
      </Row>

      <Row label="Extraire">
        <div className="flex flex-wrap justify-end gap-1.5">
          <Seg active={config.images} onClick={() => set("images", !config.images)} icon={ImageIcon}>Images</Seg>
          <Seg active={config.header} onClick={() => set("header", !config.header)} icon={LayoutPanelTop}>En-tête</Seg>
          <Seg active={config.footer} onClick={() => set("footer", !config.footer)} icon={PanelBottom}>Pied de page</Seg>
        </div>
      </Row>

      <Row label="Extraire les boîtes englobantes">
        <Switch on={config.boundingBoxes} onToggle={() => set("boundingBoxes", !config.boundingBoxes)} />
      </Row>

      <Row label="Extraire les tableaux">
        <select value={config.tables} onChange={(e) => set("tables", e.target.value as ExtractConfig["tables"])}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          <option value="markdown">Markdown intégré</option>
          <option value="separate">Séparé</option>
          <option value="none">Ne pas extraire</option>
        </select>
      </Row>

      <Row label="Annoter les images">
        {config.annotate == null ? (
          <AddBtn onClick={() => set("annotate", "")} />
        ) : (
          <input value={config.annotate} onChange={(e) => set("annotate", e.target.value)} placeholder="Prompt d'annotation…"
            className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm" />
        )}
      </Row>

      <Row label="Scores de confiance" last>
        <select value={config.confidence} onChange={(e) => set("confidence", e.target.value as ExtractConfig["confidence"])}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          <option value="none">Aucun</option>
          <option value="page">Par page</option>
          <option value="block">Par bloc</option>
        </select>
      </Row>

      <p className="px-5 py-4 text-sm text-muted-foreground">
        Fonctionnalités supplémentaires disponibles via l'API Document AI <ExternalLink className="inline h-3 w-3" />.
      </p>
    </div>
  );
}

// ── Result pane (extracted content) ──────────────────────────────────────────
function ResultPane({ sourceId, config, onReconfigure }: { sourceId: string | null; config: ExtractConfig; onReconfigure: () => void }) {
  const { data: source } = useQuery({
    queryKey: ["ws_source_detail", sourceId],
    enabled: !!sourceId,
    refetchInterval: (q) => ((q.state.data as { status?: string } | undefined)?.status === "processing" ? 2500 : false),
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("id, status, chunk_count, byte_size, error_message, created_at").eq("id", sourceId!).maybeSingle();
      return data as { id: string; status: string; chunk_count: number; byte_size: number | null; error_message: string | null; created_at: string } | null;
    },
  });
  const { data: text, isLoading } = useQuery({
    queryKey: ["ws_source_text", sourceId, source?.status],
    enabled: !!sourceId && source?.status === "ready",
    queryFn: async () => {
      const { data } = await supabase.from("rag_chunks").select("content, created_at").eq("source_id", sourceId!).order("created_at", { ascending: true }).limit(400);
      return (data ?? []).map((c) => (c as { content: string }).content).join("\n\n");
    },
  });
  const displayed = useMemo(() => (text && text.length > 12000 ? text.slice(0, 12000) + "\n\n…" : text ?? ""), [text]);
  const processing = !source || source.status === "processing";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2">
        <span className="inline-flex items-center gap-1.5 text-sm"><Sparkles className="h-4 w-4 text-primary" /> Résultat</span>
        <Button size="sm" variant="ghost" onClick={onReconfigure}><RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reconfigurer</Button>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Statut : <b className={source?.status === "ready" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600"}>{source?.status ?? "…"}</b></span>
          <span>Blocs : {source?.chunk_count ?? 0}</span>
          {source?.byte_size ? <span>Taille : {(source.byte_size / 1024).toFixed(0)} Ko</span> : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Tag>{config.model}</Tag>
          {config.tables !== "none" && <Tag>tableaux: {config.tables}</Tag>}
          {config.boundingBoxes && <Tag>boîtes englobantes</Tag>}
          {config.images && <Tag>images</Tag>}
          {config.confidence !== "none" && <Tag>confiance: {config.confidence}</Tag>}
        </div>
        {source?.error_message && <p className="text-xs text-red-500">{source.error_message}</p>}

        <div>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Contenu extrait (Markdown)</h4>
          {processing || isLoading ? (
            <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Extraction…</div>
          ) : !displayed ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Aucun texte extrait.</p>
          ) : (
            <div className="chat-prose max-w-none break-words rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayed}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────
function Row({ label, last, children }: { label: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-5 py-4", !last && "border-b border-border/60")}>
      <div className="flex items-center gap-1.5 text-sm">{label}<HelpCircle className="h-3.5 w-3.5 text-muted-foreground/50" /></div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
function AddBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground">
      Ajouter <Plus className="h-3.5 w-3.5" />
    </button>
  );
}
function Seg({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof ImageIcon; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
      active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/40")}>
      <Icon className="h-4 w-4" /> {children}
    </button>
  );
}
function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className={cn("relative h-5 w-9 rounded-full transition-colors", on ? "bg-emerald-500" : "bg-muted")}>
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}
function ToolbarBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className="rounded p-1 text-neutral-300 hover:bg-neutral-800 hover:text-white">{children}</button>;
}
function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">{children}</span>;
}

function CodeDialog({ open, onClose, fileName, config }: { open: boolean; onClose: () => void; fileName: string; config: ExtractConfig }) {
  const snippet = `await fetch("/functions/v1/rag-extract-file", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${token}\` },
  body: JSON.stringify({
    workspace_id, project_id, collection_id,
    title: ${JSON.stringify(fileName)},
    storage_path, // uploaded to the "rag-docs" bucket
    config: ${JSON.stringify(config, null, 2).split("\n").join("\n    ")},
  }),
});`;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Code2 className="h-4 w-4" /> Appel API équivalent</DialogTitle></DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/30 p-4 text-[12px] leading-relaxed">{snippet}</pre>
      </DialogContent>
    </Dialog>
  );
}
