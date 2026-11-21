import { createContext, useContext, useMemo, useState, memo, Children, isValidElement, cloneElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon as Check, CopyIcon as Copy, CodeIcon as Code2, CaretUpDownIcon as CaretUpDown, CaretUpIcon as CaretUp, CaretDownIcon as CaretDown, DownloadSimpleIcon as Download } from "@phosphor-icons/react";
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

// ── Inline UI blocks ────────────────────────────────────────────────────────
// A fenced ```ui block holding {"component", "props"} renders as a real
// component (kpi_grid, chart, options, link_card…) where the model wrote it, no
// tool call needed. The renderer comes from the surface (UiBlocks'
// InlineUiProvider): this file can't import UiBlocks, which imports it.
export type InlineUiRenderer = (block: { component: string; props: Record<string, unknown> }) => ReactNode;
export const InlineUiContext = createContext<InlineUiRenderer | null>(null);

function InlineUi({ json }: { json: string }) {
  const render = useContext(InlineUiContext);
  const block = useMemo(() => {
    try {
      const v = JSON.parse(json) as { component?: unknown; props?: unknown };
      return typeof v?.component === "string" && v.props && typeof v.props === "object"
        ? { component: v.component, props: v.props as Record<string, unknown> }
        : null;
    } catch { return null; }
  }, [json]);
  // Still streaming (half a JSON), or no renderer here: never show raw JSON.
  if (!block || !render) return null;
  return <div className="not-prose my-3">{render(block)}</div>;
}

// Distinguish block code (fenced: has a `language-x` class or newlines) from
// inline code, which keeps the caller's prose styling.
function mdCode(props: any) {
  const { className, children } = props;
  const match = /language-([\w-]+)/.exec(className ?? "");
  const text = String(children ?? "").replace(/\n$/, "");
  if (match?.[1] === "ui" || match?.[1] === "ui-block") return <InlineUi json={text} />;
  const isBlock = !!match || text.includes("\n");
  if (!isBlock) return <code className={className}>{children}</code>;
  return <CodeBlock code={text} lang={match?.[1]} />;
}

// ── Tables ──────────────────────────────────────────────────────────────────
// Markdown tables get a frame, horizontal scroll, right-aligned numeric
// columns, click-to-sort headers, and copy / CSV export. Sorting reorders the
// rendered rows, so cell formatting (bold, links, code) is kept.

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };
const hastText = (n?: HastNode): string =>
  !n ? "" : n.type === "text" ? n.value ?? "" : (n.children ?? []).map(hastText).join("");
const elements = (n?: HastNode, tag?: string) =>
  (n?.children ?? []).filter((c) => c.type === "element" && (!tag || c.tagName === tag));

/** « 27,47 $ », « 73 % », « -1.2k » → a number; anything else → null. */
function numericValue(raw: string): number | null {
  const t = raw.replace(/[\s $€£%]/g, "").replace(/(\d),(\d{1,2})$/, "$1.$2").replace(/,/g, "");
  const m = /^([+-]?\d+(?:\.\d+)?)([kKmM])?$/.exec(t);
  if (!m) return null;
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1;
  return Number(m[1]) * mult;
}

const csvCell = (v: string) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function MdTable({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [copied, setCopied] = useState(false);

  const head = elements(node, "thead")[0];
  const body = elements(node, "tbody")[0];
  const headers = elements(elements(head, "tr")[0], "th").map(hastText);
  const rowsText = elements(body, "tr").map((tr) => elements(tr).map(hastText));
  const numericCols = headers.map((_, c) => {
    const vals = rowsText.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    return vals.length > 0 && vals.filter((v) => numericValue(v) != null).length >= Math.ceil(vals.length * 0.8);
  });

  const kids = Children.toArray(children).filter(isValidElement) as ReactElement<{ children?: ReactNode }>[];
  const tbodyEl = kids.find((k) => k.type === "tbody");
  const rowEls = Children.toArray(tbodyEl?.props.children).filter(isValidElement) as ReactElement<{ children?: ReactNode }>[];

  // Without a readable structure (no header, rows out of step), plain table.
  if (!headers.length || rowEls.length !== rowsText.length) {
    return <div className="md-table not-prose"><div className="md-table-scroll"><table>{children}</table></div></div>;
  }

  const order = rowsText.map((_, i) => i);
  if (sort) {
    const { col, dir } = sort;
    order.sort((a, b) => {
      const x = rowsText[a][col] ?? "", y = rowsText[b][col] ?? "";
      const nx = numericValue(x), ny = numericValue(y);
      const d = nx != null && ny != null ? nx - ny : x.localeCompare(y, "fr", { numeric: true, sensitivity: "base" });
      return d * dir;
    });
  }
  const cycle = (col: number) => setSort((s) => (!s || s.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  const tsv = [headers, ...rowsText].map((r) => r.join("\t")).join("\n");
  const copy = async () => {
    try { await navigator.clipboard.writeText(tsv); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ }
  };
  const download = () => {
    const csv = [headers, ...rowsText].map((r) => r.map(csvCell).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "tableau.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="md-table not-prose group/table">
      <div className="md-table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((h, c) => (
                <th key={c} className={cn(numericCols[c] && "num")} aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  <button type="button" onClick={() => cycle(c)} className="md-table-sort" title="Trier">
                    <span>{h}</span>
                    {sort?.col === c
                      ? (sort.dir === 1 ? <CaretUp className="h-3 w-3" /> : <CaretDown className="h-3 w-3" />)
                      : <CaretUpDown className="h-3 w-3 opacity-0 transition-opacity group-hover/table:opacity-60" />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((i) => {
              const tr = rowEls[i];
              const cells = Children.toArray(tr.props.children).filter(isValidElement) as ReactElement<{ className?: string }>[];
              return cloneElement(tr, { key: i }, cells.map((td, c) =>
                cloneElement(td, { key: c, className: cn(td.props.className, numericCols[c] && "num") })));
            })}
          </tbody>
        </table>
      </div>
      <div className="md-table-bar">
        <span>{rowsText.length} ligne{rowsText.length > 1 ? "s" : ""}</span>
        <button type="button" onClick={copy}>{copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}{copied ? "Copié" : "Copier"}</button>
        <button type="button" onClick={download}><Download className="h-3 w-3" />CSV</button>
      </div>
    </div>
  );
}

// Unwrap ReactMarkdown's default <pre> (which prose styles with its own dark
// background) — our CodeBlock brings its own chrome.
const mdPre = (props: any) => <>{props.children}</>;

const MD_COMPONENTS = { code: mdCode, pre: mdPre, table: MdTable } as const;

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
