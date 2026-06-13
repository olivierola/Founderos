import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plate, usePlateEditor, PlateContent, ParagraphPlugin } from "platejs/react";
import {
  BoldPlugin, ItalicPlugin, UnderlinePlugin, StrikethroughPlugin, CodePlugin,
  H1Plugin, H2Plugin, H3Plugin, BlockquotePlugin,
} from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { toggleList, ListStyleType } from "@platejs/list";
import { IndentPlugin } from "@platejs/indent/react";
import { indent, outdent } from "@platejs/indent";
import { TextAlignPlugin } from "@platejs/basic-styles/react";
import { LinkPlugin } from "@platejs/link/react";
import { KEYS } from "platejs";
import {
  H1Element, H2Element, H3Element, ParagraphElement,
  BlockquoteElement, LinkElement, CodeLeaf,
} from "./plate-nodes";
import {
  Loader2, ArrowLeft, Check, Sparkles, Download, FileText, FileDown, FileJson,
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code as CodeIcon,
  Heading1, Heading2, Heading3, Quote, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, Indent, Outdent,
} from "lucide-react";
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
import { OfficeAiPanel, type AiResult } from "./OfficeAiPanel";
import {
  type DocumentContent, slateToText, slateToMarkdown, markdownToSlate,
  downloadBlob, sanitizeFilename,
} from "./shared";

const PLUGINS = [
  // Marks
  BoldPlugin, ItalicPlugin, UnderlinePlugin, StrikethroughPlugin,
  CodePlugin.withComponent(CodeLeaf),
  // Blocks (with styled node components)
  H1Plugin.withComponent(H1Element),
  H2Plugin.withComponent(H2Element),
  H3Plugin.withComponent(H3Element),
  BlockquotePlugin.withComponent(BlockquoteElement),
  LinkPlugin.withComponent(LinkElement),
  ParagraphPlugin.withComponent(ParagraphElement),
  // Structure
  IndentPlugin, ListPlugin, TextAlignPlugin,
];

export function DocumentEditorPage() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { workspaceId, projectId } = useCurrentContext();
  const { data: doc, isLoading, saving, savedAt, scheduleSave } = useOfficeDoc(docId, "document");

  const [title, setTitle] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const initialValue = useMemo(() => {
    const nodes = (doc?.content as DocumentContent)?.nodes;
    return Array.isArray(nodes) && nodes.length ? nodes : [{ type: "p", children: [{ text: "" }] }];
  }, [doc?.id]); // hydrate once per doc

  const editor = usePlateEditor({ plugins: PLUGINS, value: initialValue }, [doc?.id]);

  useEffect(() => { if (doc) setTitle(doc.title); }, [doc?.id]);

  function onTitleChange(v: string) {
    setTitle(v);
    scheduleSave({ title: v || "Untitled document" });
  }

  function onEditorChange() {
    const nodes = editor.children;
    scheduleSave({ content: { nodes } as DocumentContent });
  }

  function applyAi(r: AiResult) {
    if (r.action === "replace_document" && r.markdown != null) {
      const nodes = markdownToSlate(r.markdown);
      editor.tf.setValue(nodes);
      scheduleSave({ content: { nodes } as DocumentContent });
      toast.success("Document generated");
    } else if (r.action === "insert_markdown" && r.markdown != null) {
      const nodes = markdownToSlate(r.markdown);
      // Append generated blocks to the end of the document.
      const merged = [...editor.children, ...nodes];
      editor.tf.setValue(merged);
      scheduleSave({ content: { nodes: merged } as DocumentContent });
      toast.success("Inserted");
    }
  }

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!doc) return <EmptyState icon={FileText} title="Document not found" />;

  const contextText = slateToText(editor?.children ?? []);

  function exportMarkdown() {
    downloadBlob(sanitizeFilename(title) + ".md", slateToMarkdown(editor.children), "text/markdown");
    toast.success("Markdown downloaded");
  }
  async function exportDocx() {
    const paras = docxParagraphs(editor.children);
    const d = new DocxDocument({ creator: "FounderOS", title, sections: [{ properties: {}, children: paras }] });
    downloadBlob(sanitizeFilename(title) + ".docx", await Packer.toBlob(d));
    toast.success("DOCX downloaded");
  }
  async function exportPdf() {
    const stage = document.createElement("div");
    stage.style.cssText =
      "position:fixed;left:-99999px;top:0;width:794px;background:#fff;color:#0f172a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:48px 64px;line-height:1.6;font-size:14px";
    stage.innerHTML = `<h1 style="font-size:28px;font-weight:600;margin:0 0 16px">${escapeHtml(title)}</h1>` +
      mdToHtml(slateToMarkdown(editor.children));
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

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-lg">{doc.emoji ?? "📝"}</span>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold focus:outline-none"
          placeholder="Untitled document"
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>
            : savedAt ? <><Check className="h-3 w-3" /> Saved</> : null}
        </span>
        <div className="relative">
          <Button variant="outline" size="sm" onClick={() => setExportOpen((v) => !v)}>
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          {exportOpen && (
            <div className="absolute right-0 top-9 z-20 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover shadow-xl" onMouseLeave={() => setExportOpen(false)}>
              <MenuItem icon={FileText} label="Markdown (.md)" onClick={() => { exportMarkdown(); setExportOpen(false); }} />
              <MenuItem icon={FileDown} label="PDF (.pdf)" onClick={() => { exportPdf(); setExportOpen(false); }} />
              <MenuItem icon={FileJson} label="Word (.docx)" onClick={() => { exportDocx(); setExportOpen(false); }} />
            </div>
          )}
        </div>
        <Button size="sm" variant={aiOpen ? "default" : "outline"} onClick={() => setAiOpen((v) => !v)}>
          <Sparkles className="h-3.5 w-3.5" /> AI
        </Button>
      </div>

      {/* Body: editor + AI panel */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Plate editor={editor} onChange={onEditorChange}>
            <Toolbar editor={editor} />
            {/* Soft backdrop with a centered white "paper" page, like a real doc. */}
            <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-100 py-8 dark:bg-zinc-900/40">
              <div className="mx-auto w-full max-w-3xl rounded-lg bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200">
                <PlateContent
                  className={cn(
                    "min-h-[60vh] px-14 py-12 text-[15px] leading-7 focus:outline-none",
                    // list rendering (Plate v53 indent-based lists set listStyleType inline)
                    "[&_[data-slate-node=element]]:my-1",
                    "[&_li]:my-1",
                  )}
                  placeholder="Start writing, or use the AI panel to generate content…"
                />
              </div>
            </div>
          </Plate>
        </div>

        <OfficeAiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          kind="document"
          docTitle={title}
          contextText={contextText}
          workspaceId={workspaceId}
          projectId={projectId}
          onResult={applyAi}
        />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: any }) {
  const toggleBlock = (type: string) => editor.tf.toggleBlock(type);
  const setAlign = (align: "left" | "center" | "right") =>
    editor.tf.setNodes({ [KEYS.textAlign]: align }, { match: (n: any) => editor.api.isBlock(n) });
  const list = (style: string) => toggleList(editor, { listStyleType: style });

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
      <TBtn onClick={() => editor.tf.bold.toggle()} title="Bold (Ctrl+B)"><Bold className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => editor.tf.italic.toggle()} title="Italic (Ctrl+I)"><Italic className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => editor.tf.underline.toggle()} title="Underline (Ctrl+U)"><UnderlineIcon className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => editor.tf.strikethrough.toggle()} title="Strikethrough"><Strikethrough className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => editor.tf.code.toggle()} title="Inline code"><CodeIcon className="h-3.5 w-3.5" /></TBtn>
      <span className="mx-1 h-4 w-px bg-border" />
      <TBtn onClick={() => toggleBlock("h1")} title="Heading 1"><Heading1 className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => toggleBlock("h2")} title="Heading 2"><Heading2 className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => toggleBlock("h3")} title="Heading 3"><Heading3 className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => toggleBlock("blockquote")} title="Quote"><Quote className="h-3.5 w-3.5" /></TBtn>
      <span className="mx-1 h-4 w-px bg-border" />
      <TBtn onClick={() => list(ListStyleType.Disc)} title="Bulleted list"><List className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => list(ListStyleType.Decimal)} title="Numbered list"><ListOrdered className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => indent(editor)} title="Indent"><Indent className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => outdent(editor)} title="Outdent"><Outdent className="h-3.5 w-3.5" /></TBtn>
      <span className="mx-1 h-4 w-px bg-border" />
      <TBtn onClick={() => setAlign("left")} title="Align left"><AlignLeft className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => setAlign("center")} title="Align center"><AlignCenter className="h-3.5 w-3.5" /></TBtn>
      <TBtn onClick={() => setAlign("right")} title="Align right"><AlignRight className="h-3.5 w-3.5" /></TBtn>
    </div>
  );
}

function TBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
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
