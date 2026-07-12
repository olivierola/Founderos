import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X, Play, Loader2, Download, ExternalLink, ImageIcon, LayoutPanelTop, PanelBottom,
  FileText, Sparkles, RotateCcw, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { FileCard, formatOfSource, type FormatFileProps } from "./FileCard";

export interface FileRow {
  id: string; collection_id: string; type: string; title: string;
  source_ref: string | null; status: string;
}

// ── OCR / extraction config (Document-AI style) ──────────────────────────────
interface ExtractConfig {
  model: string;
  responseFormat: "markdown" | "json" | "text";
  pages: string;
  images: boolean;
  header: boolean;
  footer: boolean;
  boundingBoxes: boolean;
  tables: "markdown" | "separate" | "none";
  annotateImages: boolean;
  confidence: "none" | "page" | "block";
}
const DEFAULT_CONFIG: ExtractConfig = {
  model: "founderos-extract", responseFormat: "markdown", pages: "",
  images: true, header: false, footer: false, boundingBoxes: true,
  tables: "markdown", annotateImages: false, confidence: "none",
};

const MODELS = [
  { id: "founderos-extract", label: "FounderOS Extract", hint: "Extraction texte + tableaux (par défaut)" },
  { id: "mistral-ocr-latest", label: "Mistral OCR Latest", hint: "OCR haute fidélité (mistral-ocr-latest)" },
  { id: "fast-extract", label: "Extraction rapide", hint: "Plus rapide, moins précise" },
];

export function FileDetailSidebar({ file, onClose }: { file: FileRow; onClose: () => void }) {
  const [phase, setPhase] = useState<"config" | "running" | "result">("config");
  const [config, setConfig] = useState<ExtractConfig>(DEFAULT_CONFIG);
  const set = <K extends keyof ExtractConfig>(k: K, v: ExtractConfig[K]) => setConfig((c) => ({ ...c, [k]: v }));

  const format = formatOfSource(file);

  function run() {
    setPhase("running");
    // Extraction already ran server-side on ingest; we surface the real result.
    // A short beat makes the "run" legible (and matches the Document-AI flow).
    setTimeout(() => setPhase("result"), 550);
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="scale-90"><FileCard formatFile={format} /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={file.title}>{file.title}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{format}</div>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>

      {phase === "result"
        ? <ResultView file={file} format={format} config={config} onReconfigure={() => setPhase("config")} />
        : <ConfigView config={config} set={set} format={format} running={phase === "running"} onRun={run} />}
    </aside>
  );
}

// ── Phase 1 : extraction configuration ───────────────────────────────────────
function ConfigView({ config, set, format, running, onRun }: {
  config: ExtractConfig;
  set: <K extends keyof ExtractConfig>(k: K, v: ExtractConfig[K]) => void;
  format: FormatFileProps;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
        <span className="text-xs text-muted-foreground">Configurez l'extraction avant de lancer</span>
        <Button size="sm" onClick={onRun} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
          Exécuter
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-2">
        <Row label="Modèle" help="Moteur d'extraction / OCR">
          <NativeSelect value={config.model} onChange={(v) => set("model", v)}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </NativeSelect>
        </Row>
        <Row label="Format de réponse" help="Structure de la sortie">
          <NativeSelect value={config.responseFormat} onChange={(v) => set("responseFormat", v as ExtractConfig["responseFormat"])}>
            <option value="markdown">Markdown</option>
            <option value="json">JSON</option>
            <option value="text">Texte brut</option>
          </NativeSelect>
        </Row>
        <Row label="Pages" help="Laissez vide pour tout le document">
          <Input value={config.pages} onChange={(e) => set("pages", e.target.value)} placeholder='par ex. "1-4,8"' className="h-9 w-40 text-right" />
        </Row>
        <Row label="Extraire">
          <div className="flex flex-wrap justify-end gap-1.5">
            <Toggle active={config.images} onClick={() => set("images", !config.images)} icon={ImageIcon}>Images</Toggle>
            <Toggle active={config.header} onClick={() => set("header", !config.header)} icon={LayoutPanelTop}>En-tête</Toggle>
            <Toggle active={config.footer} onClick={() => set("footer", !config.footer)} icon={PanelBottom}>Pied de page</Toggle>
          </div>
        </Row>
        <Row label="Boîtes englobantes" help="Coordonnées des blocs détectés">
          <Switch on={config.boundingBoxes} onToggle={() => set("boundingBoxes", !config.boundingBoxes)} />
        </Row>
        <Row label="Extraire les tableaux">
          <NativeSelect value={config.tables} onChange={(v) => set("tables", v as ExtractConfig["tables"])}>
            <option value="markdown">Markdown intégré</option>
            <option value="separate">Séparé (par tableau)</option>
            <option value="none">Ne pas extraire</option>
          </NativeSelect>
        </Row>
        <Row label="Annoter les images" help="Légendes générées par IA">
          <Switch on={config.annotateImages} onToggle={() => set("annotateImages", !config.annotateImages)} />
        </Row>
        <Row label="Scores de confiance">
          <NativeSelect value={config.confidence} onChange={(v) => set("confidence", v as ExtractConfig["confidence"])}>
            <option value="none">Aucun</option>
            <option value="page">Par page</option>
            <option value="block">Par bloc</option>
          </NativeSelect>
        </Row>

        <p className="px-1 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          L'extraction est exécutée à l'ingestion du fichier. « Exécuter » affiche le contenu extrait
          {format === "pdf" ? " et un aperçu du PDF" : ""} avec la configuration choisie.
        </p>
      </div>
    </>
  );
}

// ── Phase 2 : preview + extracted content + metadata ─────────────────────────
function ResultView({ file, format, config, onReconfigure }: {
  file: FileRow; format: FormatFileProps; config: ExtractConfig; onReconfigure: () => void;
}) {
  // Full source row (byte_size, chunk_count, dates, error).
  const { data: source } = useQuery({
    queryKey: ["rag_source_detail", file.id],
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources")
        .select("id, title, type, source_ref, status, chunk_count, byte_size, error_message, created_at")
        .eq("id", file.id).maybeSingle();
      return data as {
        id: string; title: string; type: string; source_ref: string | null; status: string;
        chunk_count: number; byte_size: number | null; error_message: string | null; created_at: string;
      } | null;
    },
  });

  // Extracted text (the chunks the retriever searches).
  const { data: extracted, isLoading: loadingText } = useQuery({
    queryKey: ["rag_source_extracted", file.id],
    queryFn: async () => {
      const { data } = await supabase.from("rag_chunks").select("content, created_at")
        .eq("source_id", file.id).order("created_at", { ascending: true }).limit(400);
      return (data ?? []).map((c) => (c as { content: string }).content).join("\n\n");
    },
  });

  // Signed preview URL for uploaded documents/images.
  const { data: previewUrl } = useQuery({
    queryKey: ["rag_source_preview", file.id, file.source_ref],
    enabled: file.type === "document" && !!file.source_ref,
    queryFn: async () => {
      const { data } = await supabase.storage.from("rag-docs").createSignedUrl(file.source_ref!, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const isImage = ["png", "jpg", "jpeg", "img"].includes(format);
  const displayed = useMemo(() => {
    if (!extracted) return "";
    const max = 12000;
    return extracted.length > max ? extracted.slice(0, max) + "\n\n…" : extracted;
  }, [extracted]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> Résultat de l'extraction
        </span>
        <Button size="sm" variant="ghost" onClick={onReconfigure}><RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reconfigurer</Button>
      </div>

      <div className="space-y-5 p-4">
        {/* Preview */}
        <section>
          <SectionTitle>Aperçu</SectionTitle>
          {file.type === "url" ? (
            <a href={file.source_ref ?? "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
              {file.source_ref} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : format === "pdf" && previewUrl ? (
            <iframe title={file.title} src={previewUrl} className="h-72 w-full rounded-lg border border-border bg-white" />
          ) : isImage && previewUrl ? (
            <img src={previewUrl} alt={file.title} className="max-h-72 w-full rounded-lg border border-border object-contain" />
          ) : previewUrl ? (
            <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/40">
              <Download className="h-4 w-4" /> Ouvrir / télécharger le fichier
            </a>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              <FileText className="h-4 w-4" /> Aperçu indisponible pour ce type.
            </div>
          )}
        </section>

        {/* Description + metadata */}
        <section>
          <SectionTitle>Informations</SectionTitle>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <Meta label="Type" value={file.type} />
            <Meta label="Format" value={format.toUpperCase()} />
            <Meta label="Statut" value={
              <span className={cn("inline-flex items-center gap-1",
                source?.status === "ready" ? "text-emerald-600 dark:text-emerald-400" : source?.status === "failed" ? "text-red-500" : "text-amber-600")}>
                {source?.status === "ready" ? <CheckCircle2 className="h-3 w-3" /> : source?.status === "failed" ? <AlertTriangle className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
                {source?.status ?? "—"}
              </span>
            } />
            <Meta label="Taille" value={source?.byte_size ? `${(source.byte_size / 1024).toFixed(0)} Ko` : "—"} />
            <Meta label="Blocs (chunks)" value={String(source?.chunk_count ?? 0)} />
            <Meta label="Ajouté le" value={source ? new Date(source.created_at).toLocaleDateString("fr-FR") : "—"} />
          </dl>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Tag>{config.model}</Tag>
            <Tag>{config.responseFormat}</Tag>
            {config.tables !== "none" && <Tag>tableaux: {config.tables}</Tag>}
            {config.boundingBoxes && <Tag>boîtes englobantes</Tag>}
            {config.images && <Tag>images</Tag>}
          </div>
          {source?.error_message && <p className="mt-2 text-xs text-red-500">{source.error_message}</p>}
        </section>

        {/* Extracted content with markup */}
        <section>
          <SectionTitle>Contenu extrait {config.responseFormat === "markdown" ? "(Markdown)" : ""}</SectionTitle>
          {loadingText ? (
            <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : !displayed ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              Aucun texte extrait{source?.status === "processing" ? " — extraction en cours…" : "."}
            </p>
          ) : config.responseFormat === "markdown" ? (
            <div className="chat-prose max-w-none break-words rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayed}</ReactMarkdown>
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/20 p-3 text-[12px] leading-relaxed">{displayed}</pre>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────
function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {help && <div className="text-[11px] text-muted-foreground">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
function NativeSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {children}
    </select>
  );
}
function Toggle({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof ImageIcon; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
        active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/40")}>
      <Icon className="h-3.5 w-3.5" /> {children}
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
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h4>;
}
function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">{children}</span>;
}
