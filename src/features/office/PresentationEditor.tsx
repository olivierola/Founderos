import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Loader2, ArrowLeft, Check, Sparkles, Download, Presentation as PresIcon,
  Plus, Trash2, ChevronUp, ChevronDown, Play,
} from "lucide-react";
import jsPDF from "jspdf";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { useOfficeDoc } from "./useOfficeDoc";
import { OfficeAiPanel, type AiResult } from "./OfficeAiPanel";
import { OfficePlateEditor } from "./OfficePlateEditor";
import { type PresentationContent, type Slide, sanitizeFilename, slateToMarkdown } from "./shared";

const LAYOUTS: Slide["layout"][] = ["title", "title-content", "section", "blank"];

export function PresentationEditorPage() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { workspaceId, projectId } = useCurrentContext();
  const { data: doc, isLoading, saving, savedAt, scheduleSave } = useOfficeDoc(docId, "presentation");

  const [title, setTitle] = useState("");
  const [slides, setSlides] = useState<Slide[]>([]);
  const [active, setActive] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);
  const [present, setPresent] = useState(false);

  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title);
    setSlides((doc.content as PresentationContent).slides ?? []);
    setActive(0);
  }, [doc?.id]);

  function persist(next: Slide[]) {
    scheduleSave({ content: { slides: next } as PresentationContent });
  }
  function update(i: number, patch: Partial<Slide>) {
    setSlides((prev) => { const next = prev.map((s, j) => (j === i ? { ...s, ...patch } : s)); persist(next); return next; });
  }
  function addSlide() {
    setSlides((prev) => { const next = [...prev, { title: "New slide", body: "", layout: "title-content" as const }]; persist(next); setActive(next.length - 1); return next; });
  }
  function removeSlide(i: number) {
    setSlides((prev) => { const next = prev.filter((_, j) => j !== i); persist(next); setActive((a) => Math.max(0, Math.min(a, next.length - 1))); return next; });
  }
  function move(i: number, dir: -1 | 1) {
    setSlides((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev]; [next[i], next[j]] = [next[j], next[i]]; persist(next); setActive(j); return next;
    });
  }
  function onTitleChange(v: string) { setTitle(v); scheduleSave({ title: v || "Untitled presentation" }); }

  function applyAi(r: AiResult) {
    if (r.action === "set_slides" && r.slides) {
      const next: Slide[] = r.slides.map((s) => ({
        title: s.title ?? "Slide",
        body: s.body ?? "",
        layout: (LAYOUTS.includes(s.layout as Slide["layout"]) ? s.layout : "title-content") as Slide["layout"],
        notes: s.notes,
      }));
      setSlides(next); persist(next); setActive(0);
      toast.success("Slides generated");
    }
  }

  function exportPdf() {
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    slides.forEach((s, i) => {
      if (i > 0) pdf.addPage();
      pdf.setFillColor(15, 23, 42); pdf.rect(0, 0, W, H, "F");
      pdf.setTextColor(255, 255, 255);
      if (s.layout === "section" || s.layout === "title") {
        pdf.setFontSize(34); pdf.text(s.title || "", W / 2, H / 2 - 10, { align: "center", maxWidth: W - 120 });
        if (s.body) { pdf.setFontSize(16); pdf.setTextColor(190, 200, 215); pdf.text(stripMd(s.body), W / 2, H / 2 + 30, { align: "center", maxWidth: W - 160 }); }
      } else {
        pdf.setFontSize(28); pdf.text(s.title || "", 60, 90, { maxWidth: W - 120 });
        pdf.setFontSize(16); pdf.setTextColor(210, 218, 230);
        const lines = bullets(s.body);
        pdf.text(lines, 70, 150, { maxWidth: W - 140, lineHeightFactor: 1.5 });
      }
      pdf.setFontSize(10); pdf.setTextColor(120, 130, 145);
      pdf.text(`${i + 1} / ${slides.length}`, W - 60, H - 24);
    });
    pdf.save(sanitizeFilename(title) + ".pdf");
    toast.success("PDF downloaded");
  }

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!doc) return <EmptyState icon={PresIcon} title="Presentation not found" />;

  const slide = slides[active];
  const contextText = slides.map((s, i) => `Slide ${i + 1} [${s.layout}]: ${s.title}\n${s.body}`).join("\n\n");

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /></Button>
        <span className="text-lg">{doc.emoji ?? "🖼️"}</span>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold focus:outline-none"
          placeholder="Untitled presentation"
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</> : savedAt ? <><Check className="h-3 w-3" /> Saved</> : null}
        </span>
        <Button variant="outline" size="sm" onClick={() => setPresent(true)} disabled={slides.length === 0}><Play className="h-3.5 w-3.5" /> Present</Button>
        <Button variant="outline" size="sm" onClick={exportPdf} disabled={slides.length === 0}><Download className="h-3.5 w-3.5" /> PDF</Button>
        <Button size="sm" variant={aiOpen ? "default" : "outline"} onClick={() => setAiOpen((v) => !v)}><Sparkles className="h-3.5 w-3.5" /> AI</Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Slide rail */}
        <div className="flex w-48 shrink-0 flex-col border-r border-border">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {slides.map((s, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={cn(
                  "group relative block w-full overflow-hidden rounded border text-left transition-colors",
                  active === i ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40",
                )}
              >
                <div className="flex aspect-video flex-col justify-center bg-slate-900 p-2 text-white">
                  <span className="line-clamp-2 text-[10px] font-semibold">{s.title || "Untitled"}</span>
                  {s.layout === "title-content" && <span className="mt-0.5 line-clamp-2 text-[8px] text-slate-300">{stripMd(s.body).slice(0, 50)}</span>}
                </div>
                <span className="absolute left-1 top-1 rounded bg-black/40 px-1 text-[8px] text-white">{i + 1}</span>
              </button>
            ))}
            <Button variant="outline" size="sm" className="w-full" onClick={addSlide}><Plus className="h-3.5 w-3.5" /> Slide</Button>
          </div>
        </div>

        {/* Slide editor */}
        <div className="flex min-w-0 flex-1 flex-col p-4">
          {!slide ? (
            <EmptyState icon={PresIcon} title="No slides" description="Add a slide or generate with AI." action={<Button onClick={addSlide}><Plus className="h-4 w-4" /> Add slide</Button>} />
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <select
                  value={slide.layout}
                  onChange={(e) => update(active, { layout: e.target.value as Slide["layout"] })}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                >
                  {LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <div className="ml-auto flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" disabled={active === 0} onClick={() => move(active, -1)}><ChevronUp className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" disabled={active === slides.length - 1} onClick={() => move(active, 1)}><ChevronDown className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => removeSlide(active)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>

              {/* Slide title (shown on the dark canvas header) */}
              <div className="flex w-full flex-col rounded-t-lg bg-slate-900 p-6 text-white shadow-inner">
                <input
                  value={slide.title}
                  onChange={(e) => update(active, { title: e.target.value })}
                  placeholder="Slide title"
                  className={cn(
                    "w-full bg-transparent font-semibold focus:outline-none placeholder:text-slate-500",
                    slide.layout === "title" || slide.layout === "section" ? "text-center text-3xl" : "text-2xl",
                  )}
                />
              </div>

              {/* Slide body — full rich editor with toolbar */}
              {slide.layout !== "section" && slide.layout !== "blank" ? (
                <div className="min-h-[260px] flex-1 overflow-hidden rounded-b-lg border border-t-0 border-border">
                  <OfficePlateEditor
                    // Remount when switching slide so the editor hydrates the new body.
                    key={active}
                    value={slide.body}
                    onChange={(v) => update(active, { body: slateToMarkdown(v) })}
                    placeholder="Slide content — type / for blocks, or use the toolbar…"
                    editorClassName="px-6 py-4"
                    workspaceId={workspaceId}
                    projectId={projectId}
                  />
                </div>
              ) : (
                <div className="rounded-b-lg border border-t-0 border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                  This layout has no body content.
                </div>
              )}

              {/* Speaker notes */}
              <div className="mt-3">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Speaker notes</label>
                <textarea
                  value={slide.notes ?? ""}
                  onChange={(e) => update(active, { notes: e.target.value })}
                  rows={2}
                  placeholder="Notes for the presenter (not shown on the slide)…"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </>
          )}
        </div>

        <OfficeAiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          kind="presentation"
          docTitle={title}
          contextText={contextText}
          workspaceId={workspaceId}
          projectId={projectId}
          onResult={applyAi}
        />
      </div>

      {present && slides.length > 0 && (
        <PresentMode slides={slides} startAt={active} onClose={() => setPresent(false)} />
      )}
    </div>
  );
}

function PresentMode({ slides, startAt, onClose }: { slides: Slide[]; startAt: number; onClose: () => void }) {
  const [i, setI] = useState(startAt);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === " ") setI((x) => Math.min(x + 1, slides.length - 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(x - 1, 0));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length, onClose]);

  const s = slides[i];
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900 text-white" onClick={() => setI((x) => Math.min(x + 1, slides.length - 1))}>
      <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="absolute right-4 top-4 text-slate-400 hover:text-white">Esc ✕</button>
      <div className="flex flex-1 flex-col justify-center px-[10vw]">
        <h1 className={cn("font-semibold", s.layout === "title" || s.layout === "section" ? "text-center text-5xl" : "text-4xl")}>{s.title}</h1>
        {s.layout !== "section" && s.layout !== "blank" && (
          <div className={cn("mt-8 space-y-3 text-2xl text-slate-200", s.layout === "title" && "text-center")}>
            {bullets(s.body).map((line, k) => <p key={k}>{line}</p>)}
          </div>
        )}
      </div>
      <div className="px-8 py-4 text-sm text-slate-500">{i + 1} / {slides.length}</div>
    </div>
  );
}

function stripMd(s: string): string {
  return (s ?? "").replace(/^[-*+]\s+/gm, "").replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim();
}
function bullets(body: string): string[] {
  return (body ?? "").split("\n").map((l) => l.replace(/^[-*+]\s+/, "• ").trim()).filter(Boolean);
}
