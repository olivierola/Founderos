/**
 * The two ways a PDF enters an agent's deliverables.
 *
 *   PdfDeliverableView — a `generate_pdf` deliverable: the agent stored a spec,
 *                        the file is rendered here, on open, and can be
 *                        re-themed before it is downloaded.
 *   ArtifactPdfButton  — a block report or deck (add_block/publish_artifact),
 *                        exported on demand through the same studio.
 */
import { useMemo, useState } from "react";
import {
  ArrowLeftIcon as ArrowLeft,
  DownloadSimpleIcon as Download,
  FilePdfIcon as FilePdf,
  ArrowSquareOutIcon as ExternalLink,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { ArtifactDocument } from "@/features/artifacts/blocks";
import { PDF_THEMES, type PdfDeliverablePayload, type PdfThemeName } from "@/lib/pdf/types";
import { pdfFileName } from "@/lib/pdf/text";
import { PdfExportDialog, PdfFrame } from "./PdfStudio";
import { pdfFromArtifact } from "./adapters";
import { saveBlob, specTitle } from "./renderPdf";
import { THEME_LABELS } from "./themes";
import { usePdfRender } from "./usePdfRender";

const btn = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 hover:bg-muted disabled:opacity-50";

export function PdfDeliverableView({ payload, title, onBack, fill = true, height }: {
  payload: PdfDeliverablePayload;
  title?: string;
  onBack?: () => void;
  /** Fill the parent; false inside a scrolling list, with `height` instead. */
  fill?: boolean;
  height?: string;
}) {
  const [theme, setTheme] = useState<PdfThemeName>(payload.options?.theme ?? "modern");
  const options = useMemo(() => ({ ...payload.options, theme }), [payload.options, theme]);
  const state = usePdfRender(payload.spec, options);
  const name = title || specTitle(payload.spec);

  return (
    <div
      className={fill ? "flex h-full min-h-0 flex-col" : "flex flex-col overflow-hidden rounded-xl border border-border"}
      style={fill ? undefined : { height: height ?? "min(75vh, 820px)" }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
        {onBack && (
          <button
            type="button" onClick={onBack} aria-label="Retour"
            className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <FilePdf className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-medium text-foreground">{name}</span>
        {state.blob && <span className="hidden shrink-0 sm:inline">· {(state.blob.size / 1024).toFixed(0)} Ko</span>}
        <span className="flex-1" />
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as PdfThemeName)}
          aria-label="Thème du PDF"
          className="h-7 rounded-lg border border-border bg-background px-1.5 text-xs text-foreground"
        >
          {PDF_THEMES.map((t) => <option key={t} value={t}>{THEME_LABELS[t]}</option>)}
        </select>
        <button type="button" className={btn} disabled={!state.url} onClick={() => state.url && window.open(state.url, "_blank", "noopener")}>
          <ExternalLink className="h-3.5 w-3.5" /> Ouvrir
        </button>
        <button type="button" className={btn} disabled={!state.blob} onClick={() => state.blob && saveBlob(state.blob, pdfFileName(name))}>
          <Download className="h-3.5 w-3.5" /> Télécharger
        </button>
      </div>
      <PdfFrame state={state} className="min-h-0 flex-1" />
    </div>
  );
}

export function ArtifactPdfButton({ doc, title, deck, className }: {
  doc: ArtifactDocument;
  title: string;
  deck?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Built only once the studio opens: a document can be long, and most views
  // are read, not exported.
  const spec = useMemo(
    () => (open ? { kind: "document" as const, doc: pdfFromArtifact(doc, { title, deck }) } : null),
    [open, doc, title, deck],
  );
  if (doc.blocks.length === 0) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn(btn, className)} title="Exporter en PDF vectoriel">
        <FilePdf className="h-3.5 w-3.5" /> PDF
      </button>
      <PdfExportDialog
        open={open}
        onOpenChange={setOpen}
        spec={spec}
        defaultOptions={{ theme: "modern", landscape: !!deck }}
      />
    </>
  );
}
