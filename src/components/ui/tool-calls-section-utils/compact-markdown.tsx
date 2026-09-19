// Renderer for the input/output payloads inside tool-calls-section.tsx.
//
// Two shapes arrive here: an arguments object (render it as readable JSON) and
// a tool's textual result (render it as markdown, because agents write prose,
// tables and fenced code into results). Both are cramped into a small
// disclosure panel, so every block is tightened and long output is scrolled
// rather than allowed to push the conversation down the page.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const MAX_CHARS = 4000;

export function CompactMarkdown({
  content,
  className,
}: {
  content: unknown;
  className?: string;
}) {
  if (content == null) return null;

  if (typeof content !== "string") {
    let json: string;
    try {
      json = JSON.stringify(content, null, 2);
    } catch {
      // Circular or non-serialisable args: show what we can rather than crash
      // the whole timeline over a payload we only meant to preview.
      json = String(content);
    }
    return (
      <pre
        className={cn(
          "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground scrollbar-slim",
          className,
        )}
      >
        {json.slice(0, MAX_CHARS)}
        {json.length > MAX_CHARS ? "\n…" : ""}
      </pre>
    );
  }

  const text = content.slice(0, MAX_CHARS) + (content.length > MAX_CHARS ? "\n…" : "");
  return (
    <div
      className={cn(
        "max-h-56 overflow-auto text-[11px] leading-relaxed text-muted-foreground scrollbar-slim",
        // Tight rhythm: the panel is a preview, not a document.
        "[&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-[11px] [&_:is(h1,h2,h3)]:font-semibold [&_:is(h1,h2,h3)]:text-foreground",
        "[&>*+*]:mt-1.5 [&_ul]:list-disc [&_ol]:list-decimal [&_:is(ul,ol)]:pl-4 [&_li+li]:mt-0.5",
        "[&_a]:underline [&_a]:underline-offset-2 [&_strong]:text-foreground",
        "[&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-background/60 [&_pre]:p-2 [&_pre]:text-[10px]",
        "[&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[10px]",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:w-full [&_table]:border-collapse [&_:is(td,th)]:border [&_:is(td,th)]:border-border/60 [&_:is(td,th)]:px-1.5 [&_:is(td,th)]:py-0.5",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default CompactMarkdown;
