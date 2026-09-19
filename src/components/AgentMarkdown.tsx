import { createContext, useContext, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon as Check, CopyIcon as Copy, CodeIcon as Code2 } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { CodeBlock as ShikiCodeBlock, CodeBlockCode, CodeBlockGroup } from "@/components/ui/code-block";

// When present, large code blocks render as a compact card that opens the code
// in the surface's right zone (rooms provide this; the full-bleed agent chat
// doesn't, so its large code stays inline-collapsible).
export type OpenCodeFn = (code: string, lang?: string, title?: string) => void;
export const CodeArtifactContext = createContext<OpenCodeFn | null>(null);

function useCopy(code: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked */ }
  };
  return { copied, copy };
}

// Inline Shiki code block — language label, copy, and (for long code) a
// collapse/expand with a fade so it never floods the chat column.
function InlineCode({ code, lang, large }: { code: string; lang?: string; large?: boolean }) {
  const { copied, copy } = useCopy(code);
  const [expanded, setExpanded] = useState(!large);
  return (
    <ShikiCodeBlock className="my-3">
      <CodeBlockGroup className="border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{lang || "code"}</span>
        <div className="flex items-center gap-0.5">
          {large && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {expanded ? "Réduire" : "Afficher tout"}
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            title="Copier le code"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copié" : "Copier"}
          </button>
        </div>
      </CodeBlockGroup>
      <div className={cn("relative", !expanded && "max-h-[260px] overflow-hidden")}>
        <CodeBlockCode code={code} language={lang || "text"} />
        {!expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card to-transparent" />}
      </div>
    </ShikiCodeBlock>
  );
}

// Compact card for a large code block — opens the code as an artifact in the
// right zone (Shiki-rendered there too).
function CodeArtifactCard({ code, lang, title, lines, onOpen }: {
  code: string; lang?: string; title?: string; lines: number; onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="not-prose my-3 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left transition-colors hover:bg-accent/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Code2 className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title || `Code${lang ? " · " + lang : ""}`}</span>
        <span className="block text-xs text-muted-foreground">{lines} lignes · cliquez pour ouvrir</span>
      </span>
      <span className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground">Ouvrir</span>
    </button>
  );
}

/**
 * A block of code produced by an agent. Small code renders inline (Shiki
 * highlighted); large code either collapses inline or — when a right zone is
 * available (rooms) — becomes a compact card opening the code there.
 */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  const openCode = useContext(CodeArtifactContext);
  const lines = code.split("\n").length;
  const large = lines > 14 || code.length > 900;
  if (large && openCode) {
    return <CodeArtifactCard code={code} lang={lang} title={title} lines={lines} onOpen={() => openCode(code, lang, title)} />;
  }
  return <InlineCode code={code} lang={lang} large={large} />;
}

// Distinguish block code (fenced — has a `language-x` class or newlines) from
// inline code, which keeps the caller's prose styling.
function mdCode(props: any) {
  const { className, children } = props;
  const match = /language-(\w+)/.exec(className ?? "");
  const text = String(children ?? "").replace(/\n$/, "");
  const isBlock = !!match || text.includes("\n");
  if (!isBlock) return <code className={className}>{children}</code>;
  return <CodeBlock code={text} lang={match?.[1]} />;
}

// Unwrap ReactMarkdown's default <pre> (which prose styles with its own dark
// background) — our CodeBlock brings its own chrome.
const mdPre = (props: any) => <>{props.children}</>;

const MD_COMPONENTS = { code: mdCode, pre: mdPre } as const;

// [[ui:N]] are interleaving markers (see InterleavedMessage) — never visible
// text. Strip any that reach a plain markdown render so they don't leak as
// literal "[[ui:1]]" on surfaces that don't weave blocks.
const UI_TAG = /\[\[ui:\d+\]\]/g;
export const stripUiTags = (s?: string | null) => (s ?? "").replace(UI_TAG, "");

/**
 * Shared markdown renderer for agent output: GFM + a real {@link CodeBlock} for
 * fenced code. Callers keep their own prose wrapper (`chat-prose`, `prose`, …).
 */
export const AgentMarkdown = memo(function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS as any}>
      {(content ?? "").replace(UI_TAG, "").trim()}
    </ReactMarkdown>
  );
});

export default AgentMarkdown;
