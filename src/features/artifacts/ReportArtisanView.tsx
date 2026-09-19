/**
 * A report written by Le Rédacteur.
 *
 * Unlike every other artifact, this one is not blocks the app draws: it is a
 * finished HTML file — banners, SVG charts, KPI tiles, and an embedded editor —
 * built server-side and stored whole. So it is shown as itself, in a frame,
 * rather than re-rendered through a second engine that would never quite agree
 * with the file the client receives by mail.
 *
 * WHY THE FILE IS INLINED RATHER THAN LINKED
 * Pointing the frame at the storage URL does not work: object storage refuses to
 * serve an uploaded .html as html (a deliberate anti-phishing measure — that is
 * why opening the link in a tab shows source code, and why the frame came up
 * blank). The bytes are therefore fetched with the storage client and handed to
 * the frame through `srcdoc`, which is parsed inline and never negotiates a
 * content type with anyone.
 *
 * The frame is sandboxed WITHOUT allow-same-origin: the document is written by a
 * model, and an opaque origin is what keeps it away from the app's session. The
 * report's runtime expects that — its local autosave is wrapped in a try/catch
 * and degrades gracefully, while the editor, the charts and printing all work.
 *
 * ON SCREEN THE SHEET IS DISSOLVED (`screenSkin` below): the file is designed as
 * a sheet of paper on a desk, which is right for something you email and print,
 * and wrong inside a panel that already has a background. So the paper's own
 * ground, border and shadow are removed for screen only, its toolbar is hidden —
 * this view carries those actions in the app's own bar — and its theme is set
 * from the app's. Print keeps the original design untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon as ArrowLeft,
  DownloadSimpleIcon as Download,
  CircleNotchIcon as Loader2,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowsInSimpleIcon as Minimize2,
  PrinterIcon as Printer,
  WarningIcon as TriangleAlert,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";

export interface ReportArtisanPayload {
  format: "report-artisan";
  version: number;
  bucket: string;
  path: string;
  static_path?: string;
  built_at?: string;
  bytes?: number;
  warnings?: string[];
  /** The content document, kept so the report can be rebuilt without asking the
   *  model to write it a second time. Not used for display. */
  doc?: { title?: string; subtitle?: string; blocks?: unknown[] };
}

/** Recognise a Rédacteur report from a deliverable's stored content. Returns
 *  null for every other shape, so callers can fall through to the block
 *  renderer without sniffing formats themselves. */
export function parseReportArtisan(content: unknown): ReportArtisanPayload | null {
  if (!content) return null;
  let raw: unknown = content;
  if (typeof content === "string") {
    const s = content.trim();
    if (!s.startsWith("{") || !s.includes("report-artisan")) return null;
    try { raw = JSON.parse(s); } catch { return null; }
  }
  const p = raw as Partial<ReportArtisanPayload> | null;
  if (!p || p.format !== "report-artisan" || typeof p.path !== "string" || !p.path) return null;
  return { ...p, bucket: p.bucket || "agent-reports" } as ReportArtisanPayload;
}

// allow-same-origin is deliberately absent — see the header.
const SANDBOX = "allow-scripts allow-modals allow-popups allow-downloads allow-forms";

const DOC_OPEN = '<script id="ra-doc" type="application/json">';

/** Screen-only: dissolve the sheet into whatever is behind the frame, and drop
 *  the file's own toolbar. Scoped to `screen` so the printed PDF — the reason
 *  the paper exists — is exactly what the file was designed to produce. */
const screenSkin = `
@media screen {
  html, body { background: transparent !important; }
  .ra-shell { padding: 0 !important; min-height: 0 !important; }
  .ra-paper {
    background: transparent !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  .ra-bar { display: none !important; }
}
`;

/** Printing has to happen INSIDE the frame, and an opaque origin cannot be
 *  scripted from here — so the frame is given a one-line listener instead. */
const bridge = `
addEventListener("message", function (e) {
  if (e.data && e.data.type === "ra:print") { try { print(); } catch (_) {} }
});
`;

/**
 * The stored file, prepared for display: app theme, no sheet, no toolbar.
 *
 * Every anchor here is found with lastIndexOf, and that is not a detail. The
 * file inlines its own runtime, and that runtime contains an HTML exporter —
 * so the literal strings `</body>` and `</head>` appear INSIDE a <script> long
 * before the document's real ones. Injecting at the first `</body>` planted a
 * `</script>` in the middle of the engine, which ended it there and spilled the
 * rest of its source into the page as text.
 */
export function forDisplay(html: string, dark: boolean): string {
  let out = html;
  // The runtime re-applies `data-theme` from the payload at boot, so the theme
  // has to be changed in the payload — setting the attribute would be undone.
  const i = out.lastIndexOf(DOC_OPEN);
  if (i >= 0) {
    const start = i + DOC_OPEN.length;
    const end = out.indexOf("</script>", start);
    if (end > start) {
      try {
        const doc = JSON.parse(out.slice(start, end).split("<\\/").join("</")) as Record<string, unknown>;
        doc.theme = dark ? "dark" : "light";
        out = out.slice(0, start) + JSON.stringify(doc).replace(/<\//g, "<\\/") + out.slice(end);
      } catch { /* leave the payload alone rather than corrupt it */ }
    }
  }
  const inject = `<style id="ra-app-skin">${screenSkin}</style><script>${bridge}</script>`;
  const at = out.lastIndexOf("</body>");
  return at >= 0 ? out.slice(0, at) + inject + out.slice(at) : out + inject;
}

/** Mirrors the app's dark class (same signal the code blocks watch). */
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function ReportArtisanView({ payload, title, fill = true, height, onBack }: {
  payload: ReportArtisanPayload;
  title?: string;
  /** Rendered as a back arrow at the start of the bar. */
  onBack?: () => void;
  /** Fill the parent (the viewer). Set false inside a scrolling list, where the
   *  frame needs a height of its own. */
  fill?: boolean;
  /** Frame height when `fill` is false. */
  height?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const dark = useIsDark();

  useEffect(() => {
    let alive = true;
    setHtml(null); setError(null);
    (async () => {
      const { data, error } = await supabase.storage.from(payload.bucket).download(payload.path);
      if (!alive) return;
      if (error || !data) { setError(error?.message ?? "fichier introuvable"); return; }
      try {
        setHtml(await data.text());
      } catch (e) {
        setError(e instanceof Error ? e.message : "fichier illisible");
      }
    })();
    return () => { alive = false; };
  }, [payload.bucket, payload.path]);

  // Rebuilt on a theme flip: the banner and the charts are drawn once, at boot,
  // so re-skinning a live document would leave half of it in the old theme.
  const display = useMemo(() => (html === null ? null : forDisplay(html, dark)), [html, dark]);

  // Esc leaves the expanded view — the frame swallows clicks, so a keyboard way
  // out is the only reliable one.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const print = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "ra:print" }, "*");
  }, []);

  const download = useCallback(async () => {
    // The frozen build (no editor, ~90 kB) is the one you send someone. A signed
    // URL with a download disposition is served as an attachment, so the content
    // type the store insists on stops mattering.
    const name = `${(title || payload.doc?.title || "rapport").replace(/[^\w-]+/g, "-").slice(0, 60)}.html`;
    const { data } = await supabase.storage.from(payload.bucket)
      .createSignedUrl(payload.static_path || payload.path, 3600, { download: name });
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener");
  }, [payload, title]);

  const btn = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 hover:bg-muted";

  // ONE bar. The file's own toolbar is hidden by the skin above, and what was
  // worth keeping from it lives here.
  const bar = (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
      {onBack && !expanded && (
        <button
          type="button" onClick={onBack} aria-label="Retour"
          className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <span className="truncate font-medium text-foreground">{title || payload.doc?.title || "Rapport"}</span>
      {payload.built_at && (
        <span className="hidden shrink-0 sm:inline">· {new Date(payload.built_at).toLocaleDateString("fr-FR")}</span>
      )}
      {payload.warnings && payload.warnings.length > 0 && (
        <span title={payload.warnings.join("\n")} className="hidden shrink-0 cursor-help items-center gap-1 sm:inline-flex">
          · <TriangleAlert className="h-3 w-3" /> {payload.warnings.length}
        </span>
      )}
      {/* The file's own status line said so; it is hidden now, and a document you
          can type into that saves nothing must not stay silent about it. */}
      <span
        className="hidden shrink-0 cursor-help sm:inline"
        title="Le texte est modifiable dans le document, mais rien n'est enregistré ici : téléchargez le fichier pour garder une version."
      >
        · non enregistré
      </span>
      <span className="flex-1" />
      <button type="button" onClick={print} className={btn} title="Imprimer ou enregistrer en PDF">
        <Printer className="h-3.5 w-3.5" /> PDF
      </button>
      <button type="button" onClick={() => setExpanded((v) => !v)} className={btn}>
        {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        {expanded ? "Réduire" : "Plein écran"}
      </button>
      <button
        type="button" onClick={download} className={btn}
        title="Version figée, sans éditeur — c'est celle qu'on envoie à un client."
      >
        <Download className="h-3.5 w-3.5" /> Télécharger
      </button>
    </div>
  );

  const body = error
    ? (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        Le fichier du rapport n'a pas pu être lu ({error}).
      </div>
    )
    : display === null
      ? <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      : (
        <iframe
          ref={frameRef}
          srcDoc={display}
          title={title || payload.doc?.title || "Rapport"}
          sandbox={SANDBOX}
          // Transparent, so the report sits ON the app's background rather than
          // on a sheet of its own.
          className="h-full w-full border-0 bg-transparent"
        />
      );

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        {bar}
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    );
  }

  return (
    <div
      className={fill ? "flex h-full min-h-0 flex-col" : "flex flex-col overflow-hidden rounded-xl border border-border"}
      style={fill ? undefined : { height: height ?? "min(70vh, 760px)" }}
    >
      {bar}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
