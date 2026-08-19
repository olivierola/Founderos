import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The one markdown surface of the product. Extracted from SkillEditor so a
// skill, a workflow playbook and a written procedure are authored in the same
// place with the same behaviour — three near-identical textareas would have
// drifted on tab handling alone.
//
// Deliberately a plain textarea, not a rich editor: what is written here is
// read by an AGENT, so the source must be exactly what ships. A WYSIWYG layer
// would put a rendering between the author and the thing that gets executed.

export interface MarkdownEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  /** Rendered above the surface, inside the same frame (a filename, a hint). */
  toolbar?: ReactNode;
  /** Rendered below the surface, inside the same frame. */
  footer?: ReactNode;
  /** Framed card (workflow, procedures) vs flush fill (skill editor). */
  variant?: "framed" | "flush";
  className?: string;
  /** Minimum height when the editor is not filling a flex parent. */
  minHeight?: number | string;
  autoFocus?: boolean;
}

export function MarkdownEditor({
  value, onChange, placeholder, readOnly, toolbar, footer,
  variant = "framed", className, minHeight, autoFocus,
}: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Tab indents instead of leaving the field. In a document whose nested lists
  // and fenced blocks carry meaning, losing focus on Tab makes the editor
  // unusable for exactly the content it exists for.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab" || readOnly) return;
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: end } = el;
    const before = value.slice(0, s);
    const after = value.slice(end);

    if (e.shiftKey) {
      // Outdent the current line.
      const lineStart = before.lastIndexOf("\n") + 1;
      const line = value.slice(lineStart, end);
      const trimmed = line.replace(/^ {1,2}/, "");
      const removed = line.length - trimmed.length;
      if (!removed) return;
      onChange(value.slice(0, lineStart) + trimmed + after);
      queueMicrotask(() => el.setSelectionRange(Math.max(lineStart, s - removed), Math.max(lineStart, end - removed)));
      return;
    }
    onChange(`${before}  ${after}`);
    queueMicrotask(() => el.setSelectionRange(s + 2, s + 2));
  }

  const framed = variant === "framed";
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        framed && "overflow-hidden rounded-xl border border-border/60 bg-card focus-within:border-primary/50",
        className,
      )}
    >
      {toolbar && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          {toolbar}
        </div>
      )}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={readOnly}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        style={minHeight ? { minHeight } : undefined}
        className={cn(
          "min-h-0 flex-1 resize-none bg-transparent font-mono text-[13px] leading-relaxed text-foreground",
          "placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-70",
          framed ? "px-5 py-4" : "px-5 py-4",
        )}
      />
      {footer && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}
