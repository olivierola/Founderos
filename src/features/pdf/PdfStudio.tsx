/**
 * The one place a PDF is previewed, themed and saved — whatever produced it.
 *
 * The dashboard export, the report export and the agent's PDF deliverables all
 * open this. The preview IS the file: the bytes shown in the frame are the bytes
 * that get downloaded, so what the user approves is exactly what they send.
 */
import { useState } from "react";
import {
  ArrowSquareOutIcon as ExternalLink,
  CircleNotchIcon as Loader2,
  DownloadSimpleIcon as Download,
  WarningIcon as TriangleAlert,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PDF_THEMES, type PdfRenderOptions, type PdfSpec, type PdfThemeName } from "@/lib/pdf/types";
import { pdfFileName } from "@/lib/pdf/text";
import { THEMES, THEME_LABELS } from "./themes";
import { saveBlob, specTitle } from "./renderPdf";
import { usePdfRender, type PdfRenderState } from "./usePdfRender";

export function PdfFrame({ state, className }: { state: PdfRenderState; className?: string }) {
  return (
    <div className={cn("relative min-h-0 overflow-hidden bg-muted/40", className)}>
      {state.url && (
        <iframe
          // The hash hides Chrome's viewer sidebar; the file keeps its own zoom.
          src={`${state.url}#view=FitH&navpanes=0`}
          title="Aperçu PDF"
          className="h-full w-full border-0"
        />
      )}
      {(state.loading || (!state.url && !state.error)) && (
        <div className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground",
          state.url ? "bg-background/40 backdrop-blur-[1px]" : "",
        )}>
          <Loader2 className="h-5 w-5 animate-spin" />
          {!state.url && <span>Génération du PDF…</span>}
        </div>
      )}
      {state.error && !state.loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 p-6 text-center text-sm text-destructive">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          La génération a échoué : {state.error}
        </div>
      )}
    </div>
  );
}

export function ThemePicker({ value, onChange }: { value: PdfThemeName; onChange: (t: PdfThemeName) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {PDF_THEMES.map((name) => {
        const t = THEMES[name];
        return (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
              value === name ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted",
            )}
          >
            <span className="flex shrink-0 overflow-hidden rounded-sm border border-border">
              <span className="h-4 w-2.5" style={{ background: t.colors.primary }} />
              <span className="h-4 w-2.5" style={{ background: t.colors.muted }} />
            </span>
            <span className="truncate">{THEME_LABELS[name]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function PdfExportDialog({
  open,
  onOpenChange,
  spec,
  defaultOptions,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the caller is still gathering the content. */
  spec: PdfSpec | null;
  defaultOptions?: PdfRenderOptions;
  /** One line under the title: where the content comes from, what was left out. */
  description?: string;
}) {
  const [theme, setTheme] = useState<PdfThemeName>(defaultOptions?.theme ?? "modern");
  const [landscape, setLandscape] = useState(!!defaultOptions?.landscape);
  const options: PdfRenderOptions = { ...defaultOptions, theme, landscape };
  const state = usePdfRender(spec, options, open);
  const title = spec ? specTitle(spec) : "PDF";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 border-b border-border px-5 py-3 pr-12">
          <DialogTitle className="truncate text-base">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            {description ?? "PDF vectoriel, texte sélectionnable, généré dans votre navigateur avec pdfcn."}
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <PdfFrame state={state} className="min-h-[50vh] flex-1" />
          <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border p-4 md:w-72 md:border-l md:border-t-0">
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">Thème</h3>
              <ThemePicker value={theme} onChange={setTheme} />
            </section>
            {spec?.kind === "document" && (
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">Orientation</h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {[false, true].map((l) => (
                    <button
                      key={String(l)}
                      type="button"
                      onClick={() => setLandscape(l)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-xs transition-colors",
                        landscape === l ? "border-primary bg-primary/10" : "border-border hover:bg-muted",
                      )}
                    >
                      {l ? "Paysage" : "Portrait"}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {state.warnings.length > 0 && (
              <section className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                {state.warnings.map((w, i) => <p key={i}>{w}</p>)}
              </section>
            )}
            <div className="mt-auto space-y-2">
              {state.ms !== null && state.blob && (
                <p className="text-[11px] text-muted-foreground">
                  {(state.blob.size / 1024).toFixed(0)} Ko · rendu en {state.ms} ms
                </p>
              )}
              <Button
                className="w-full"
                disabled={!state.blob || state.loading}
                onClick={() => state.blob && saveBlob(state.blob, pdfFileName(title))}
              >
                <Download className="h-4 w-4" /> Télécharger
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={!state.url}
                onClick={() => state.url && window.open(state.url, "_blank", "noopener")}
              >
                <ExternalLink className="h-4 w-4" /> Ouvrir dans un onglet
              </Button>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
