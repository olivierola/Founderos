import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import {
  X,
  Download,
  Copy,
  Check,
  FileText,
  FileDown,
  FileJson,
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  Code,
  Pencil,
  Eye,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import TurndownService from "turndown";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
} from "docx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";

interface DocumentCanvasProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Initial markdown content from the AI. */
  initialMarkdown: string;
  /** Optional title — defaults to the first H1 of the markdown. */
  title?: string;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});

function markdownToHtml(md: string): string {
  // We let ReactMarkdown render the *initial* preview and use its DOM in the
  // editor — but TipTap doesn't accept markdown directly. We need a quick
  // markdown -> HTML pass. Use a tiny converter that maps the subset we care
  // about (headings, bold, italic, lists, quotes, code, links, hr).
  const lines = md.split("\n");
  const out: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let inCodeBlock = false;
  let codeBuffer: string[] = [];

  function closeList() {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  }

  function inlineFmt(s: string): string {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^```/.test(line)) {
      if (inCodeBlock) {
        out.push("<pre><code>" + codeBuffer.join("\n") + "</code></pre>");
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        closeList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inlineFmt(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^---+$/.test(line)) {
      closeList();
      out.push("<hr/>");
      continue;
    }
    if (/^>\s+/.test(line)) {
      closeList();
      out.push("<blockquote><p>" + inlineFmt(line.replace(/^>\s+/, "")) + "</p></blockquote>");
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (inList !== "ol") {
        closeList();
        out.push("<ol>");
        inList = "ol";
      }
      out.push(`<li>${inlineFmt(ol[1])}</li>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (inList !== "ul") {
        closeList();
        out.push("<ul>");
        inList = "ul";
      }
      out.push(`<li>${inlineFmt(ul[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineFmt(line)}</p>`);
  }
  closeList();
  if (inCodeBlock) out.push("<pre><code>" + codeBuffer.join("\n") + "</code></pre>");
  return out.join("\n");
}

export function DocumentCanvas({ open, onOpenChange, initialMarkdown, title }: DocumentCanvasProps) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  // Extract a default title from the first H1.
  const computedTitle = useMemo(() => {
    if (title) return title;
    const m = initialMarkdown.match(/^#\s+(.+)$/m);
    return m ? m[1].slice(0, 100) : "Untitled document";
  }, [title, initialMarkdown]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: "text-[hsl(var(--primary-soft))] underline" } }),
      Placeholder.configure({ placeholder: "Type your document…" }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class:
          "prose prose-invert prose-sm sm:prose-base max-w-none focus:outline-none min-h-[500px] px-8 py-6 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:text-xl [&_h3]:font-semibold [&_a]:cursor-pointer [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:text-xs [&_pre]:bg-secondary [&_pre]:rounded [&_pre]:p-3 [&_pre]:text-xs [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5",
      },
    },
  });

  // Hydrate the editor whenever the document opens with new content.
  useEffect(() => {
    if (!open || !editor) return;
    const html = markdownToHtml(initialMarkdown);
    editor.commands.setContent(html);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMarkdown, editor]);

  /* ====== Exporters ====== */
  function getMarkdown(): string {
    if (!editor) return initialMarkdown;
    return turndown.turndown(editor.getHTML());
  }

  function getPlainHtml(): string {
    if (!editor) return "";
    return editor.getHTML();
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(getMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Markdown copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  function downloadMarkdown() {
    const md = getMarkdown();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(computedTitle) + ".md";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Markdown downloaded");
  }

  function downloadHtml() {
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(computedTitle)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;line-height:1.6;color:#0f172a}
h1,h2,h3{line-height:1.2;margin-top:1.8em}h1{font-size:2.2rem}h2{font-size:1.7rem}h3{font-size:1.3rem}
blockquote{border-left:3px solid #cbd5e1;padding-left:1rem;color:#475569;font-style:italic;margin-left:0}
pre{background:#0f172a;color:#e2e8f0;padding:1rem;border-radius:6px;overflow:auto}
code{background:#f1f5f9;padding:.2em .4em;border-radius:3px;font-size:.85em}
a{color:#1d4ed8}hr{border:0;border-top:1px solid #e2e8f0;margin:2rem 0}
</style></head>
<body>${getPlainHtml()}</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(computedTitle) + ".html";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("HTML downloaded");
  }

  async function downloadPdf() {
    const md = getMarkdown();
    // Render the markdown into an off-screen white page sized like a printed
    // letter so html2canvas captures it crisply.
    const stage = document.createElement("div");
    stage.style.cssText =
      "position:fixed;left:-99999px;top:0;width:794px;background:#fff;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:48px 64px;line-height:1.6;font-size:14px";
    stage.innerHTML = `<style>
h1{font-size:30px;font-weight:600;margin:0 0 12px}h2{font-size:22px;font-weight:600;margin:24px 0 8px}h3{font-size:18px;font-weight:600;margin:18px 0 6px}
p{margin:0 0 12px}ul,ol{margin:0 0 12px;padding-left:24px}blockquote{border-left:3px solid #cbd5e1;padding-left:12px;color:#475569;font-style:italic;margin:0 0 12px}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;overflow:auto;font-size:12px}code{background:#f1f5f9;padding:2px 4px;border-radius:3px;font-size:12px}
a{color:#1d4ed8}hr{border:0;border-top:1px solid #e2e8f0;margin:24px 0}
</style>${markdownToHtml(md)}`;
    document.body.appendChild(stage);
    try {
      const canvas = await html2canvas(stage, { scale: 2, backgroundColor: "#ffffff" });
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      let heightLeft = imgH;
      let position = 0;
      const imgData = canvas.toDataURL("image/png");
      pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position = heightLeft - imgH;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
      pdf.save(sanitizeFilename(computedTitle) + ".pdf");
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error("PDF export failed", e instanceof Error ? e.message : String(e));
    } finally {
      stage.remove();
    }
  }

  async function downloadDocx() {
    const md = getMarkdown();
    const paragraphs = markdownToDocxParagraphs(md);
    const doc = new DocxDocument({
      creator: "FounderOS",
      title: computedTitle,
      sections: [{ properties: {}, children: paragraphs }],
    });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(computedTitle) + ".docx";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("DOCX downloaded");
  }

  /* ====== Toolbar ====== */
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 backdrop-blur-sm">
      <div className="m-4 flex h-[calc(100%-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card/80 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <FileText className="h-4 w-4 shrink-0 text-[hsl(var(--primary-soft))]" />
            <span className="truncate text-sm font-medium">{computedTitle}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-[10px]">
              <button
                onClick={() => setMode("edit")}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
                  mode === "edit" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Pencil className="h-3 w-3" /> Edit
              </button>
              <button
                onClick={() => setMode("preview")}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
                  mode === "preview" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Eye className="h-3 w-3" /> Preview
              </button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} title="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Editor toolbar */}
        {mode === "edit" && editor && (
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-card/50 px-3 py-2">
            <ToolbarBtn active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
              <Heading1 className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
              <Heading2 className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
              <Heading3 className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <span className="mx-1 h-4 w-px bg-border" />
            <ToolbarBtn active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
              <Bold className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
              <Italic className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
              <Code className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <span className="mx-1 h-4 w-px bg-border" />
            <ToolbarBtn active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
              <List className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
              <ListOrdered className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
              <Quote className="h-3.5 w-3.5" />
            </ToolbarBtn>

            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={copyMarkdown}>
                {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <DownloadMenu
                onMd={downloadMarkdown}
                onPdf={downloadPdf}
                onDocx={downloadDocx}
                onHtml={downloadHtml}
              />
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-background">
          {mode === "edit" ? (
            <EditorContent editor={editor} />
          ) : (
            <div ref={previewRef} className="prose prose-invert prose-sm sm:prose-base mx-auto max-w-3xl px-8 py-8">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{getMarkdown()}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Preview footer (so the user can still export) */}
        {mode === "preview" && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-card/50 px-3 py-2">
            <Button size="sm" variant="outline" onClick={copyMarkdown}>
              {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy markdown"}
            </Button>
            <DownloadMenu onMd={downloadMarkdown} onPdf={downloadPdf} onDocx={downloadDocx} onHtml={downloadHtml} />
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded border transition",
        active
          ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]"
          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function DownloadMenu({
  onMd,
  onPdf,
  onDocx,
  onHtml,
}: {
  onMd: () => void;
  onPdf: () => void;
  onDocx: () => void;
  onHtml: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button size="sm" onClick={() => setOpen((v) => !v)}>
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
      {open && (
        <div className="absolute right-0 top-9 z-10 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
          <MenuItem icon={FileText} label="Markdown (.md)" onClick={() => { onMd(); setOpen(false); }} />
          <MenuItem icon={FileDown} label="PDF (.pdf)" onClick={() => { onPdf(); setOpen(false); }} />
          <MenuItem icon={FileJson} label="Word (.docx)" onClick={() => { onDocx(); setOpen(false); }} />
          <MenuItem icon={FileText} label="HTML (.html)" onClick={() => { onHtml(); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-secondary"
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      {label}
    </button>
  );
}

/* ====== Helpers ====== */

function sanitizeFilename(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "document";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal markdown → docx paragraph[] conversion for the .docx exporter. */
function markdownToDocxParagraphs(md: string): Paragraph[] {
  const lines = md.split("\n");
  const out: Paragraph[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*$/.test(line)) {
      out.push(new Paragraph({ children: [new TextRun("")] }));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const headingLevel =
        level === 1 ? HeadingLevel.HEADING_1 :
        level === 2 ? HeadingLevel.HEADING_2 :
        level === 3 ? HeadingLevel.HEADING_3 :
        HeadingLevel.HEADING_4;
      out.push(new Paragraph({ heading: headingLevel, children: parseInlineDocx(h[2]) }));
      continue;
    }
    if (/^---+$/.test(line)) {
      out.push(new Paragraph({ children: [new TextRun({ text: "—".repeat(20) })], alignment: AlignmentType.CENTER }));
      continue;
    }
    if (/^>\s+/.test(line)) {
      out.push(
        new Paragraph({
          children: parseInlineDocx(line.replace(/^>\s+/, "")),
          indent: { left: 360 },
        }),
      );
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      out.push(new Paragraph({ numbering: { reference: "default-numbering", level: 0 }, children: parseInlineDocx(ol[1]) }));
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      out.push(new Paragraph({ bullet: { level: 0 }, children: parseInlineDocx(ul[1]) }));
      continue;
    }
    out.push(new Paragraph({ children: parseInlineDocx(line) }));
  }
  return out;
}

function parseInlineDocx(text: string): TextRun[] {
  // Tokenise **bold** and *italic*; fall back to plain text.
  const runs: TextRun[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun(text.slice(lastIndex, match.index)));
    }
    const t = match[0];
    if (t.startsWith("**")) runs.push(new TextRun({ text: t.slice(2, -2), bold: true }));
    else if (t.startsWith("`")) runs.push(new TextRun({ text: t.slice(1, -1), font: "Consolas" }));
    else runs.push(new TextRun({ text: t.slice(1, -1), italics: true }));
    lastIndex = match.index + t.length;
  }
  if (lastIndex < text.length) runs.push(new TextRun(text.slice(lastIndex)));
  if (runs.length === 0) runs.push(new TextRun(""));
  return runs;
}
