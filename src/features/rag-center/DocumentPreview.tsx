import { useEffect, useRef, useState } from "react";
import { Loader2, Download, FileText } from "lucide-react";
import type { FormatFileProps } from "./FileCard";

// Load the file bytes: directly from a local File (new upload) or by fetching a
// signed URL (existing source). Used by the docx / xlsx renderers.
function useArrayBuffer(enabled: boolean, file?: File, url?: string | null) {
  const [state, setState] = useState<{ buf: ArrayBuffer | null; loading: boolean; error: string | null }>(
    { buf: null, loading: enabled, error: null },
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ buf: null, loading: true, error: null });
    (async () => {
      try {
        const buf = file ? await file.arrayBuffer() : url ? await (await fetch(url)).arrayBuffer() : null;
        if (!cancelled) setState({ buf, loading: false, error: buf ? null : "Fichier indisponible" });
      } catch (e) {
        if (!cancelled) setState({ buf: null, loading: false, error: e instanceof Error ? e.message : "Erreur de chargement" });
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, file, url]);
  return state;
}

const IMAGE = new Set<FormatFileProps>(["png", "jpg", "jpeg", "img"]);
const SHEET = new Set<FormatFileProps>(["xls", "xlsx", "csv"]);

export function DocumentPreview({ format, previewUrl, file, page, fileName }: {
  format: FormatFileProps;
  previewUrl: string | null;
  file?: File;
  page: number;
  fileName: string;
}) {
  if (format === "pdf" && previewUrl) {
    return (
      <iframe
        key={`${previewUrl}-${page}`}
        title={fileName}
        src={`${previewUrl}#page=${page}&toolbar=0&navpanes=0`}
        className="h-[70vh] w-full rounded-lg border border-neutral-800 bg-white"
      />
    );
  }
  if (IMAGE.has(format) && previewUrl) {
    return <img src={previewUrl} alt={fileName} className="mx-auto max-h-[75vh] w-auto max-w-full rounded-lg border border-neutral-800 bg-white object-contain" />;
  }
  if (format === "doc") return <DocxView file={file} url={previewUrl} />;
  if (SHEET.has(format)) return <SheetView file={file} url={previewUrl} isCsv={format === "csv"} />;
  if (format === "txt" || format === "md" || format === "mdx" || format === "json" || format === "code" || format === "css") {
    return <TextView file={file} url={previewUrl} />;
  }
  // Fallback (ppt, zip, video, …) — offer to open.
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-neutral-400">
      <FileText className="h-8 w-8" />
      <span className="text-sm">Aperçu non disponible pour ce type de fichier.</span>
      {previewUrl && (
        <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800">
          <Download className="h-4 w-4" /> Ouvrir le fichier
        </a>
      )}
    </div>
  );
}

function PageWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-[200px] max-w-3xl rounded-lg bg-white p-8 text-neutral-900 shadow-xl">{children}</div>;
}
function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[200px] items-center justify-center gap-2 text-sm text-neutral-400">{children}</div>;
}

// ── DOCX → faithful Word-styled pages (docx-preview, lazy) ───────────────────
function DocxView({ file, url }: { file?: File; url?: string | null }) {
  const { buf, loading, error } = useArrayBuffer(true, file, url);
  const ref = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!buf || !ref.current) return;
    let cancelled = false;
    setRendering(true); setRenderError(null);
    (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = "";
        // renderAsync keeps the document's own styling (fonts, headings, tables,
        // colours) and lays it out as Word-like pages.
        await renderAsync(buf, ref.current, undefined, {
          className: "docx", inWrapper: true, ignoreLastRenderedPageBreak: true, breakPages: true,
        });
        if (!cancelled) setRendering(false);
      } catch (e) {
        if (!cancelled) { setRenderError(e instanceof Error ? e.message : "Rendu impossible"); setRendering(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [buf]);

  if (loading) return <Center><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</Center>;
  if (error || renderError) return <Center>{error ?? renderError}</Center>;
  return (
    <div className="docx-host">
      {rendering && <Center><Loader2 className="h-4 w-4 animate-spin" /> Rendu du document…</Center>}
      <div ref={ref} />
    </div>
  );
}

// ── XLSX / CSV → HTML table (SheetJS, lazy) ──────────────────────────────────
function SheetView({ file, url, isCsv }: { file?: File; url?: string | null; isCsv: boolean }) {
  const { buf, loading, error } = useArrayBuffer(true, file, url);
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [active, setActive] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!buf) return;
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(buf, { type: "array" });
        const out = wb.SheetNames.map((name) => ({ name, html: XLSX.utils.sheet_to_html(wb.Sheets[name]) }));
        if (!cancelled) setSheets(out.length ? out : [{ name: "Feuille", html: "<p>Vide</p>" }]);
      } catch (e) {
        if (!cancelled) setParseError(e instanceof Error ? e.message : "Lecture impossible");
      }
    })();
    return () => { cancelled = true; };
  }, [buf]);

  if (loading) return <Center><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</Center>;
  if (error || parseError) return <Center>{error ?? parseError}</Center>;
  if (!sheets) return <Center><Loader2 className="h-4 w-4 animate-spin" /> Lecture du classeur…</Center>;

  return (
    <div className="mx-auto max-w-5xl">
      {!isCsv && sheets.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button key={s.name} onClick={() => setActive(i)}
              className={`rounded-md px-2.5 py-1 text-xs ${i === active ? "bg-white text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-preview overflow-auto rounded-lg bg-white p-3 text-neutral-900 shadow-xl">
        <div dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? "" }} />
      </div>
    </div>
  );
}

// ── Plain text / code / markdown ─────────────────────────────────────────────
function TextView({ file, url }: { file?: File; url?: string | null }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = file ? await file.text() : url ? await (await fetch(url)).text() : "";
        if (!cancelled) setText(t.slice(0, 100_000));
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Erreur"); }
    })();
    return () => { cancelled = true; };
  }, [file, url]);
  if (error) return <Center>{error}</Center>;
  if (text == null) return <Center><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</Center>;
  return (
    <PageWrap>
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-neutral-800">{text}</pre>
    </PageWrap>
  );
}
