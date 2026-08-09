import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Loader2, ArrowLeft, Check, Sparkles, FileText, FileDown, FileJson, MoreHorizontal,
} from "lucide-react";
import { Toolbar, ToolbarSeparator } from "@/components/ui/toolbar";
import { UndoToolbarButton, RedoToolbarButton } from "@/components/ui/history-toolbar-button";
import { InsertToolbarButton } from "@/components/ui/insert-toolbar-button";
import { TurnIntoToolbarButton } from "@/components/ui/turn-into-toolbar-button";
import { TableToolbarButton } from "@/components/ui/table-toolbar-button";
import {
  Document as DocxDocument, Packer, Paragraph, HeadingLevel, TextRun,
} from "docx";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { useOfficeDoc } from "./useOfficeDoc";
import { OfficePlateEditor } from "./OfficePlateEditor";
import { OfficeAiPanel, type AiResult } from "./OfficeAiPanel";
import {
  type DocumentContent, slateToText, slateToMarkdown, markdownToSlate,
  downloadBlob, sanitizeFilename,
} from "./shared";

export function DocumentEditorPage({ docId: docIdProp, onBack, embedded }: { docId?: string; onBack?: () => void; embedded?: boolean } = {}) {
  const params = useParams();
  const docId = docIdProp ?? params.docId;
  const navigate = useNavigate();
  const toast = useToast();
  const { workspaceId, projectId } = useCurrentContext();
  const { data: doc, isLoading, saving, savedAt, scheduleSave } = useOfficeDoc(docId, "document");

  const [title, setTitle] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // The current Plate value. Kept in a ref for export/AI without re-rendering on
  // every keystroke, plus a key to force-remount the editor on external replace.
  const nodesRef = useRef<any[]>([{ type: "p", children: [{ text: "" }] }]);
  const [editorKey, setEditorKey] = useState(0);
  const [initialNodes, setInitialNodes] = useState<any[]>([{ type: "p", children: [{ text: "" }] }]);

  // Hydrate once per loaded document.
  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title);
    const nodes = (doc.content as DocumentContent)?.nodes;
    const v = Array.isArray(nodes) && nodes.length ? nodes : [{ type: "p", children: [{ text: "" }] }];
    nodesRef.current = v;
    setInitialNodes(v);
    setEditorKey((k) => k + 1);
  }, [doc?.id]);

  function onTitleChange(v: string) {
    setTitle(v);
    scheduleSave({ title: v || "Untitled document" });
  }

  function onEditorChange(value: any[]) {
    nodesRef.current = value;
    scheduleSave({ content: { nodes: value } as DocumentContent });
  }

  // Replace / insert content produced by the AI panel.
  function applyAi(r: AiResult) {
    if ((r.action === "replace_document" || r.action === "insert_markdown") && r.markdown != null) {
      const generated = markdownToSlate(r.markdown);
      const next = r.action === "replace_document" ? generated : [...nodesRef.current, ...generated];
      nodesRef.current = next;
      setInitialNodes(next);
      setEditorKey((k) => k + 1); // remount editor with new value
      scheduleSave({ content: { nodes: next } as DocumentContent });
      toast.success(r.action === "replace_document" ? "Document generated" : "Inserted");
    }
  }

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!doc) return <EmptyState icon={FileText} title="Document not found" />;

  function exportMarkdown() {
    downloadBlob(sanitizeFilename(title) + ".md", slateToMarkdown(nodesRef.current), "text/markdown");
    toast.success("Markdown downloaded");
  }
  async function exportDocx() {
    const d = new DocxDocument({
      creator: "Anduran", title,
      sections: [{ properties: {}, children: docxParagraphs(nodesRef.current) }],
    });
    downloadBlob(sanitizeFilename(title) + ".docx", await Packer.toBlob(d));
    toast.success("DOCX downloaded");
  }
  async function exportPdf() {
    const stage = document.createElement("div");
    stage.style.cssText =
      "position:fixed;left:-99999px;top:0;width:794px;background:#fff;color:#0f172a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:48px 64px;line-height:1.6;font-size:14px";
    stage.innerHTML = `<h1 style="font-size:28px;font-weight:600;margin:0 0 16px">${escapeHtml(title)}</h1>` +
      mdToHtml(slateToMarkdown(nodesRef.current));
    document.body.appendChild(stage);
    try {
      const canvas = await html2canvas(stage, { scale: 2, backgroundColor: "#ffffff" });
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgH = (canvas.height * pageW) / canvas.width;
      let left = imgH; let pos = 0;
      const img = canvas.toDataURL("image/png");
      pdf.addImage(img, "PNG", 0, pos, pageW, imgH);
      left -= pageH;
      while (left > 0) { pos = left - imgH; pdf.addPage(); pdf.addImage(img, "PNG", 0, pos, pageW, imgH); left -= pageH; }
      pdf.save(sanitizeFilename(title) + ".pdf");
      toast.success("PDF downloaded");
    } finally { stage.remove(); }
  }

  const { workspaceSlug, projectSlug } = useParams();
  function handleBack() {
    if (onBack) onBack();
    else if (window.history.length > 1) navigate(-1);
    else if (workspaceSlug && projectSlug) navigate(`/app/${workspaceSlug}/${projectSlug}/artifacts`);
    else navigate(-1);
  }

  // Clean header rendered INSIDE the Plate tree so its undo/redo + insert
  // (table/blocks) buttons drive the editor. Formatting stays in the floating
  // toolbar; this bar is for structure + doc actions.
  const header = () => (
    <div className="relative z-30 flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2 sm:px-4">
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 relative z-10" onClick={handleBack} title="Retour">
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <span className="shrink-0 text-base">{doc.emoji ?? "📝"}</span>
      <input
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm font-semibold focus:outline-none"
        placeholder="Untitled document"
      />
      <Toolbar className="flex items-center gap-0.5 border-l border-border pl-2">
        <UndoToolbarButton />
        <RedoToolbarButton />
        <ToolbarSeparator />
        <TableToolbarButton />
        <InsertToolbarButton />
        <TurnIntoToolbarButton />
      </Toolbar>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground ml-auto">
        {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>
          : savedAt ? <><Check className="h-3 w-3" /> Saved</> : null}
      </span>
      <div className="flex items-center gap-1 shrink-0 relative z-10">
        <Button type="button" size="sm" variant={aiOpen ? "default" : "outline"} className="h-8 shrink-0 gap-1" onClick={() => setAiOpen((v) => !v)}>
          <Sparkles className="h-3.5 w-3.5" /> AI
        </Button>
        <div className="relative shrink-0">
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setExportOpen((v) => !v)} title="Plus (export…)">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {exportOpen && (
            <div className="absolute right-0 top-9 z-50 min-w-[160px] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl" onMouseLeave={() => setExportOpen(false)}>
              <MenuItem icon={FileText} label="Markdown (.md)" onClick={() => { exportMarkdown(); setExportOpen(false); }} />
              <MenuItem icon={FileDown} label="PDF (.pdf)" onClick={() => { exportPdf(); setExportOpen(false); }} />
              <MenuItem icon={FileJson} label="Word (.docx)" onClick={() => { exportDocx(); setExportOpen(false); }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className={cn("flex flex-col", embedded ? "h-full" : "h-[calc(100vh-3.5rem)]")}>
      {/* Body: full Plate editor (with in-tree header) + AI panel */}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <OfficePlateEditor
            key={editorKey}
            value={initialNodes}
            onChange={onEditorChange}
            placeholder="Type / for commands, or start writing…"
            workspaceId={workspaceId}
            projectId={projectId}
            renderHeader={header}
          />
        </div>

        <OfficeAiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          kind="document"
          docTitle={title}
          contextText={slateToText(nodesRef.current)}
          workspaceId={workspaceId}
          projectId={projectId}
          onResult={applyAi}
        />
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-secondary">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {label}
    </button>
  );
}

// --- export helpers --------------------------------------------------------

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdToHtml(md: string): string {
  return md.split("\n").map((line) => {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) return `<h${h[1].length}>${escapeHtml(h[2])}</h${h[1].length}>`;
    if (/^>\s+/.test(line)) return `<blockquote>${escapeHtml(line.replace(/^>\s+/, ""))}</blockquote>`;
    if (/^\s*[-*+]\s+/.test(line)) return `<li>${escapeHtml(line.replace(/^\s*[-*+]\s+/, ""))}</li>`;
    if (line.trim() === "") return "";
    return `<p>${escapeHtml(line)}</p>`;
  }).join("\n");
}
function docxParagraphs(nodes: any[]): Paragraph[] {
  const out: Paragraph[] = [];
  const inline = (children: any[]) =>
    (children ?? []).map((c: any) => new TextRun({ text: c.text ?? "", bold: !!c.bold, italics: !!c.italic }));
  for (const n of nodes ?? []) {
    const kids = n.children ?? [];
    if (n.type === "h1") out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: inline(kids) }));
    else if (n.type === "h2") out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: inline(kids) }));
    else if (n.type === "h3") out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: inline(kids) }));
    else if (n.type === "blockquote") out.push(new Paragraph({ indent: { left: 360 }, children: inline(kids) }));
    else out.push(new Paragraph({ children: inline(kids) }));
  }
  return out.length ? out : [new Paragraph({ children: [new TextRun("")] })];
}
