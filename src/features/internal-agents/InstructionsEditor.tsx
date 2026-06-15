import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Save, Check, Eye, Pencil, Bold, Italic, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code, Link2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { type InternalAgent, renderInstructionBlocks } from "./shared";

// Instructions are a single editable markdown document describing how the agent
// should behave. It sits directly on the tab container (no card/border) so it
// reads like a document. A formatting toolbar wraps the selection in markdown.
// We persist the raw markdown into `instructions` (the field the worker uses)
// and clear the legacy block model.
export function InstructionsEditor({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => initialInstructions(agent));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(initialInstructions(agent));
  }, [agent.id]);

  // Apply a markdown transform to the current selection, then restore focus and
  // a sensible caret/selection so the user can keep typing.
  const applyFormat = useCallback((fmt: Format) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const { value, selStart, selEnd } = transform(text, start, end, fmt);
    setText(value);
    // Restore selection after React re-renders the controlled value.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
    });
  }, [text]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    const map: Record<string, Format> = { b: "bold", i: "italic", k: "link" };
    if (map[key]) {
      e.preventDefault();
      applyFormat(map[key]);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agents")
        .update({
          instructions: text,
          // Collapse the legacy block model — instructions are now a single doc.
          instruction_blocks: [],
          updated_at: new Date().toISOString(),
        })
        .eq("id", agent.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between pb-3">
        <div>
          <h2 className="text-base font-semibold">Instructions</h2>
          <p className="text-xs text-muted-foreground">
            Markdown describing how {agent.name} should behave. It's used as the agent's system prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>
            {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span className="ml-1">{preview ? "Edit" : "Preview"}</span>
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            <span className="ml-1">Save</span>
          </Button>
        </div>
      </div>

      {/* Formatting toolbar — only while editing. */}
      {!preview && (
        <div className="mb-2 flex flex-wrap items-center gap-0.5">
          <ToolbarBtn title="Bold (Ctrl/⌘B)" onClick={() => applyFormat("bold")}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Italic (Ctrl/⌘I)" onClick={() => applyFormat("italic")}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Strikethrough" onClick={() => applyFormat("strike")}><Strikethrough className="h-3.5 w-3.5" /></ToolbarBtn>
          <Divider />
          <ToolbarBtn title="Heading 1" onClick={() => applyFormat("h1")}><Heading1 className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Heading 2" onClick={() => applyFormat("h2")}><Heading2 className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Heading 3" onClick={() => applyFormat("h3")}><Heading3 className="h-3.5 w-3.5" /></ToolbarBtn>
          <Divider />
          <ToolbarBtn title="Bulleted list" onClick={() => applyFormat("ul")}><List className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Numbered list" onClick={() => applyFormat("ol")}><ListOrdered className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Quote" onClick={() => applyFormat("quote")}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
          <Divider />
          <ToolbarBtn title="Inline code" onClick={() => applyFormat("code")}><Code className="h-3.5 w-3.5" /></ToolbarBtn>
          <ToolbarBtn title="Link (Ctrl/⌘K)" onClick={() => applyFormat("link")}><Link2 className="h-3.5 w-3.5" /></ToolbarBtn>
        </div>
      )}

      {/* Editor / preview — borderless, flush with the container background. */}
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {text.trim() ? (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-primary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDER}
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

function ToolbarBtn({
  title, onClick, children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      // Keep the textarea selection: prevent the button from stealing focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}

// ── Markdown transforms ───────────────────────────────────────────────────────
type Format =
  | "bold" | "italic" | "strike" | "code" | "link"
  | "h1" | "h2" | "h3" | "ul" | "ol" | "quote";

const INLINE: Partial<Record<Format, { wrap: string; placeholder: string }>> = {
  bold: { wrap: "**", placeholder: "bold text" },
  italic: { wrap: "*", placeholder: "italic text" },
  strike: { wrap: "~~", placeholder: "strikethrough" },
  code: { wrap: "`", placeholder: "code" },
};

const LINE_PREFIX: Partial<Record<Format, (i: number) => string>> = {
  h1: () => "# ",
  h2: () => "## ",
  h3: () => "### ",
  ul: () => "- ",
  ol: (i) => `${i + 1}. `,
  quote: () => "> ",
};

interface TransformResult { value: string; selStart: number; selEnd: number }

function transform(text: string, start: number, end: number, fmt: Format): TransformResult {
  const selected = text.slice(start, end);

  // Inline wrap (bold/italic/strike/code).
  const inline = INLINE[fmt];
  if (inline) {
    const { wrap, placeholder } = inline;
    const body = selected || placeholder;
    const insert = `${wrap}${body}${wrap}`;
    const value = text.slice(0, start) + insert + text.slice(end);
    // Select the inner text so the user can overtype the placeholder.
    const innerStart = start + wrap.length;
    return { value, selStart: innerStart, selEnd: innerStart + body.length };
  }

  // Link.
  if (fmt === "link") {
    const label = selected || "link text";
    const insert = `[${label}](url)`;
    const value = text.slice(0, start) + insert + text.slice(end);
    // Select the "url" portion for quick replacement.
    const urlStart = start + 1 + label.length + 2; // [label](
    return { value, selStart: urlStart, selEnd: urlStart + 3 };
  }

  // Line-prefix formats (headings/lists/quote) — apply to each selected line.
  const prefixFn = LINE_PREFIX[fmt];
  if (prefixFn) {
    // Expand selection to whole lines.
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = text.length;
    const block = text.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const newBlock = lines
      .map((ln, i) => {
        const stripped = ln.replace(/^(\s*)(#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s+)/, "$1");
        return prefixFn(i) + stripped;
      })
      .join("\n");
    const value = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
    return { value, selStart: lineStart, selEnd: lineStart + newBlock.length };
  }

  return { value: text, selStart: start, selEnd: end };
}

// Prefer the stored free-form instructions; fall back to rendering any legacy
// instruction blocks into markdown so nothing is lost on first open.
function initialInstructions(agent: InternalAgent): string {
  if (agent.instructions?.trim()) return agent.instructions;
  if (agent.instruction_blocks && agent.instruction_blocks.length > 0) {
    return renderInstructionBlocks(agent.instruction_blocks);
  }
  return "";
}

const PLACEHOLDER = `# Role
You are a senior product analyst for our SaaS.

## Context
- Our ICP is B2B agencies of 5–50 people.
- Key metrics live in the Finance and Analytics modules.

## How you work
1. Always ground answers in real data — call a tool before stating numbers.
2. Be concise and actionable.
3. Ask a clarifying question when the request is ambiguous.

## Constraints
- Never take irreversible actions without explicit confirmation.
- Respect the user's access scope.`;
