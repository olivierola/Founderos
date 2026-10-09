import {
  FileTextIcon as FileText,
  QuotesIcon as Quote,
  CursorClickIcon as CursorClick,
  ArrowSquareOutIcon as ExternalLink,
} from "@phosphor-icons/react";
import { chatUserBubble } from "@/lib/chatStyles";
import { cn } from "@/lib/utils";

/**
 * What the browser panel attaches to a message, and how it reads back.
 *
 * The agent receives tagged blocks (`<page_context url title>…</page_context>`)
 * so it knows the provenance of every line; the person, scrolling back through
 * the thread, sees a chip per block instead of twenty thousand characters of
 * someone else's web page in their own bubble. The tags are also what the run
 * engine looks for to keep only the latest page whole (internal-agent-run,
 * collapseStalePageContexts).
 */

export type ContextKind = "page" | "selection" | "element";

export interface ContextBlock {
  kind: ContextKind;
  attrs: Record<string, string>;
  body: string;
}

export interface PageCapture {
  url: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
  offset: number;
  hash: string;
  description?: string;
  site?: string;
  selection?: string;
}

export interface PickedElement {
  tag: string;
  role: string;
  label: string;
  text: string;
  href?: string;
  css?: string;
  heading?: string;
  url: string;
  title: string;
}

const attr = (v: unknown) => String(v ?? "").replace(/["<>\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

/** Block bodies are page text: they must not be able to close their own tag. */
const body = (v: string) => v.replace(/<\/(page|selection|element)_context>/gi, "</$1_ctx>");

export function formatPageBlock(p: PageCapture): string {
  const head = `<page_context url="${attr(p.url)}" title="${attr(p.title)}" site="${attr(p.site)}" chars="${p.chars}"${p.truncated ? ' truncated="true"' : ""}>`;
  const lines = [
    p.description ? `> ${p.description}` : "",
    body(p.text),
    p.truncated
      ? `[page tronquée : ${p.text.length} caractères sur ${p.chars}. page_assist look avec offset=${p.offset + p.text.length} pour la suite]`
      : "",
  ].filter(Boolean);
  return `${head}\n${lines.join("\n\n")}\n</page_context>`;
}

/** Same page as a block already sent in this conversation: a reference only. */
export function formatUnchangedPage(p: Pick<PageCapture, "url" | "title">): string {
  return `<page_context url="${attr(p.url)}" title="${attr(p.title)}" unchanged="true">même page que celle jointe plus haut, inchangée</page_context>`;
}

export function formatSelectionBlock(s: { text: string; url?: string; title?: string }): string {
  return `<selection_context url="${attr(s.url)}" title="${attr(s.title)}">\n${body(s.text)}\n</selection_context>`;
}

export function formatElementBlock(e: PickedElement): string {
  const head = `<element_context url="${attr(e.url)}" title="${attr(e.title)}" tag="${attr(e.tag)}" role="${attr(e.role)}" label="${attr(e.label)}"${e.css ? ` css="${attr(e.css)}"` : ""}>`;
  const lines = [
    e.heading ? `Section : ${e.heading}` : "",
    e.href ? `Lien : ${e.href}` : "",
    body(e.text),
  ].filter(Boolean);
  return `${head}\n${lines.join("\n")}\n</element_context>`;
}

const BLOCK_RE = /<(page|selection|element)_context\b([^>]*)>([\s\S]*?)<\/\1_context>/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export function splitContextBlocks(content: string): { text: string; blocks: ContextBlock[] } {
  if (!content || !content.includes("_context")) return { text: content ?? "", blocks: [] };
  const blocks: ContextBlock[] = [];
  const text = content.replace(BLOCK_RE, (_w, kind: ContextKind, attrs: string, b: string) => {
    blocks.push({ kind, attrs: parseAttrs(attrs), body: b.trim() });
    return "";
  }).trim();
  return { text, blocks };
}

function hostOf(url?: string): string {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
}

/** A short label for a block, used by the chips here and by the panel. */
export function blockLabel(b: ContextBlock): { title: string; sub: string } {
  const host = hostOf(b.attrs.url);
  if (b.kind === "page") {
    const n = Number(b.attrs.chars || b.body.length);
    return {
      title: b.attrs.title || host || "Page",
      sub: b.attrs.unchanged === "true" ? `${host}, inchangée` : `${host}${n ? `, ${n.toLocaleString("fr-FR")} caractères` : ""}`,
    };
  }
  if (b.kind === "selection") {
    return { title: `« ${b.body.replace(/\s+/g, " ").slice(0, 60)}${b.body.length > 60 ? "…" : ""} »`, sub: host || "Sélection" };
  }
  return { title: b.attrs.label || b.attrs.tag || "Élément", sub: `Élément pointé${host ? `, ${host}` : ""}` };
}

const ICONS: Record<ContextKind, typeof FileText> = { page: FileText, selection: Quote, element: CursorClick };

/** The user's turn: what they wrote, under the chips of what they attached. */
export function UserMessageBody({ content }: { content: string }) {
  const { text, blocks } = splitContextBlocks(content);
  if (!blocks.length) return <div className={chatUserBubble}>{content}</div>;
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-1.5">
        {blocks.map((b, i) => {
          const Icon = ICONS[b.kind];
          const { title, sub } = blockLabel(b);
          const href = /^https?:\/\//.test(b.attrs.url ?? "") ? b.attrs.url : undefined;
          const Tag = href ? "a" : "div";
          return (
            <Tag
              key={i}
              {...(href ? { href, target: "_blank", rel: "noreferrer" } : {})}
              title={b.kind === "selection" ? b.body.slice(0, 600) : b.attrs.url}
              className={cn(
                "group flex max-w-[260px] items-center gap-2 rounded-2xl border border-border/70 bg-card/70 py-1.5 pl-2 pr-3 text-left",
                href && "transition-colors hover:border-primary/40 hover:bg-primary/5",
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">{title}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground">{sub}</span>
              </span>
              {href && <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
            </Tag>
          );
        })}
      </div>
      {text && <div className={cn(chatUserBubble, "max-w-full")}>{text}</div>}
    </div>
  );
}
