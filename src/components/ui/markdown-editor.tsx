import { useCallback, useRef } from "react";
import {
  Loader2, Save, Check, Eye, Pencil, Bold, Italic, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code, Link2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Reusable rich-markdown editor: a formatting toolbar wraps the textarea
// selection in markdown, with an Edit/Preview toggle and a Save button. The
// value is controlled by the caller; saving/persistence is caller-owned.
export function MarkdownEditor({
  value, onChange, onSave, saving = false, savedAt = null, preview, onTogglePreview,
  title, description, placeholder, heightClass = "h-[calc(100vh-11rem)]",
}: {
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  saving?: boolean;
  savedAt?: number | null;
  preview: boolean;
  onTogglePreview: () => void;
  title?: string;
  description?: string;
  placeholder?: string;
  heightClass?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  const applyFormat = useCallback((fmt: Format) => {
    const ta = taRef.current;
    if (!ta) return;
    const { value: next, selStart, selEnd } = transform(value, ta.selectionStart, ta.selectionEnd, fmt);
    onChange(next);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(selStart, selEnd); });
  }, [value, onChange]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const map: Record<string, Format> = { b: "bold", i: "italic", k: "link" };
    const fmt = map[e.key.toLowerCase()];
    if (fmt) { e.preventDefault(); applyFormat(fmt); }
  }

  return (
    <div className={cn("flex flex-col", heightClass)}>
      {(title || onSave) && (
        <div className="flex items-center justify-between pb-3">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          <div className="flex items-center gap-2">
            {savedAt && Date.now() - savedAt < 4000 && (
              <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Enregistré</span>
            )}
            <Button size="sm" variant="ghost" onClick={onTogglePreview}>
              {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span className="ml-1">{preview ? "Éditer" : "Preview"}</span>
            </Button>
            {onSave && (
              <Button size="sm" onClick={onSave} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                <span className="ml-1">Save</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {!preview && (
        <div className="mb-2 flex flex-wrap items-center gap-0.5">
          <Tb title="Gras (Ctrl/⌘B)" onClick={() => applyFormat("bold")}><Bold className="h-3.5 w-3.5" /></Tb>
          <Tb title="Italique (Ctrl/⌘I)" onClick={() => applyFormat("italic")}><Italic className="h-3.5 w-3.5" /></Tb>
          <Tb title="Barré" onClick={() => applyFormat("strike")}><Strikethrough className="h-3.5 w-3.5" /></Tb>
          <Div />
          <Tb title="Titre 1" onClick={() => applyFormat("h1")}><Heading1 className="h-3.5 w-3.5" /></Tb>
          <Tb title="Titre 2" onClick={() => applyFormat("h2")}><Heading2 className="h-3.5 w-3.5" /></Tb>
          <Tb title="Titre 3" onClick={() => applyFormat("h3")}><Heading3 className="h-3.5 w-3.5" /></Tb>
          <Div />
          <Tb title="Liste à puces" onClick={() => applyFormat("ul")}><List className="h-3.5 w-3.5" /></Tb>
          <Tb title="Liste numérotée" onClick={() => applyFormat("ol")}><ListOrdered className="h-3.5 w-3.5" /></Tb>
          <Tb title="Citation" onClick={() => applyFormat("quote")}><Quote className="h-3.5 w-3.5" /></Tb>
          <Div />
          <Tb title="Code inline" onClick={() => applyFormat("code")}><Code className="h-3.5 w-3.5" /></Tb>
          <Tb title="Lien (Ctrl/⌘K)" onClick={() => applyFormat("link")}><Link2 className="h-3.5 w-3.5" /></Tb>
        </div>
      )}

      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {value.trim() ? (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-primary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">Rien à prévisualiser.</p>
          )}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(
            "min-h-0 flex-1 w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-foreground",
            "border-0 p-0 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0",
          )}
        />
      )}
    </div>
  );
}

function Tb({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
      {children}
    </button>
  );
}
function Div() { return <span className="mx-1 h-4 w-px bg-border" />; }

type Format = "bold" | "italic" | "strike" | "code" | "link" | "h1" | "h2" | "h3" | "ul" | "ol" | "quote";
const INLINE: Partial<Record<Format, { wrap: string; placeholder: string }>> = {
  bold: { wrap: "**", placeholder: "texte en gras" }, italic: { wrap: "*", placeholder: "texte en italique" },
  strike: { wrap: "~~", placeholder: "barré" }, code: { wrap: "`", placeholder: "code" },
};
const LINE_PREFIX: Partial<Record<Format, (i: number) => string>> = {
  h1: () => "# ", h2: () => "## ", h3: () => "### ", ul: () => "- ", ol: (i) => `${i + 1}. `, quote: () => "> ",
};
function transform(text: string, start: number, end: number, fmt: Format): { value: string; selStart: number; selEnd: number } {
  const selected = text.slice(start, end);
  const inline = INLINE[fmt];
  if (inline) {
    const body = selected || inline.placeholder;
    const value = text.slice(0, start) + `${inline.wrap}${body}${inline.wrap}` + text.slice(end);
    const innerStart = start + inline.wrap.length;
    return { value, selStart: innerStart, selEnd: innerStart + body.length };
  }
  if (fmt === "link") {
    const label = selected || "texte du lien";
    const value = text.slice(0, start) + `[${label}](url)` + text.slice(end);
    const urlStart = start + 1 + label.length + 2;
    return { value, selStart: urlStart, selEnd: urlStart + 3 };
  }
  const prefixFn = LINE_PREFIX[fmt];
  if (prefixFn) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = text.length;
    const newBlock = text.slice(lineStart, lineEnd).split("\n")
      .map((ln, i) => prefixFn(i) + ln.replace(/^(\s*)(#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s+)/, "$1")).join("\n");
    const value = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
    return { value, selStart: lineStart, selEnd: lineStart + newBlock.length };
  }
  return { value: text, selStart: start, selEnd: end };
}
