// Artifact content — the single place that knows how an agent's plain-text
// output becomes a real document / spreadsheet / presentation, and how it
// reads back.
//
// An agent writes markdown, CSV or "Title | body" lines because that is what a
// language model is good at. The editors (src/features/artifacts) store Plate
// nodes, {columns, rows} and {slides}. This module is the translation layer in
// BOTH directions:
//
//   parse*  — agent text → the stored shape (what create_artifact / update_artifact write)
//   render* — the stored shape → agent text (what read_artifact returns)
//
// The round trip is what makes an artifact MANIPULABLE rather than write-once:
// an agent can read back what it (or a teammate) produced, edit it, and save it
// again without ever seeing the storage format.
//
// Edge functions don't share a bundle with the frontend, so the shapes are
// mirrored here rather than imported — keep them in step with
// src/features/artifacts/shared.ts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Admin = SupabaseClient;

/** The three kinds that get a row in `office_documents`. `image` lives in
 *  `office_media`, `text` is inline-only — neither is a document. */
export type DocKind = "document" | "spreadsheet" | "presentation";
export const DOC_KINDS: DocKind[] = ["document", "spreadsheet", "presentation"];
export const isDocKind = (k: string): k is DocKind => (DOC_KINDS as string[]).includes(k);

export interface SpreadsheetContent { columns: string[]; rows: (string | null)[][] }
export interface SlideContent { title: string; body: string; layout: string }

// ---------------------------------------------------------------------------
// Agent text → stored shape
// ---------------------------------------------------------------------------

/**
 * Inline markdown → Slate leaves.
 *
 * Without this every mark reached the editor as literal punctuation: a report
 * opened showing `**Nombre d'employés**` and `*août 2026*` exactly as typed,
 * because the whole line was pushed as one raw text leaf.
 */
function parseInline(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // Ordered: code first (its content must not be re-parsed), then link, bold,
  // italic, strikethrough. `**` before `*` or the bold delimiters split wrong.
  const re = /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)[^)]*\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(~~[^~]+~~)/;
  let rest = text;
  let guard = 0;
  while (rest && guard++ < 500) {
    const m = re.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) out.push({ text: rest.slice(0, m.index) });
    const tok = m[0];
    if (m[1]) out.push({ text: tok.slice(1, -1), code: true });
    else if (m[2]) out.push({ type: "a", url: m[4], children: [{ text: m[3] }] } as Record<string, unknown>);
    else if (m[5]) out.push({ text: tok.slice(2, -2), bold: true });
    else if (m[6]) out.push({ text: tok.slice(2, -2), bold: true });
    else if (m[7]) out.push({ text: tok.slice(1, -1), italic: true });
    else if (m[8]) out.push({ text: tok.slice(2, -2), strikethrough: true });
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) out.push({ text: rest });
  return out.length ? out : [{ text: "" }];
}

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Markdown → Plate/Slate nodes: headings, quotes, lists, GFM tables, fenced
 *  code, paragraphs — with inline marks parsed inside each of them. */
export function parseMarkdownToSlateNodes(md: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = (md ?? "").split("\n").map((l) => l.replace(/\r$/, ""));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code — kept verbatim, never inline-parsed.
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      out.push({
        type: "code_block", lang: fence[1] || undefined,
        children: body.map((b) => ({ type: "code_line", children: [{ text: b }] })),
      });
      continue;
    }

    // GFM table: a header row followed by the |---|---| separator. Rendered as
    // paragraphs of pipes before — the single most visible formatting failure
    // in a comparison report.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(cells(lines[i])); i++; }
      i--; // the outer loop re-increments
      const cell = (t: string, head: boolean) => ({
        type: head ? "th" : "td",
        children: [{ type: "p", children: parseInline(t) }],
      });
      out.push({
        type: "table",
        children: [
          { type: "tr", children: header.map((h) => cell(h, true)) },
          ...rows.map((r) => ({
            type: "tr",
            children: header.map((_, ci) => cell(r[ci] ?? "", false)),
          })),
        ],
      });
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push({ type: `h${h[1].length}`, children: parseInline(h[2]) }); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out.push({ type: "hr", children: [{ text: "" }] }); continue; }
    if (/^>\s?/.test(line)) { out.push({ type: "blockquote", children: parseInline(line.replace(/^>\s?/, "")) }); continue; }
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) { out.push({ type: "p", listStyleType: "disc", indent: Math.floor(ul[1].length / 2) + 1, children: parseInline(ul[2]) }); continue; }
    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ol) { out.push({ type: "p", listStyleType: "decimal", indent: Math.floor(ol[1].length / 2) + 1, children: parseInline(ol[2]) }); continue; }
    if (line.trim() === "") continue;
    out.push({ type: "p", children: parseInline(line) });
  }
  return out.length ? out : [{ type: "p", children: [{ text: "" }] }];
}

/** "Title | body" lines → slides. */
export function parseSlideLines(text: string): SlideContent[] {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const slides = lines.map((line) => {
    const idx = line.indexOf("|");
    const title = idx === -1 ? line : line.slice(0, idx).trim();
    const body = idx === -1 ? "" : line.slice(idx + 1).trim();
    return { title: title || "Untitled slide", body, layout: "title-content" };
  });
  return slides.length ? slides : [{ title: "Untitled presentation", body: "", layout: "title" }];
}

/** CSV → {columns, rows}. Handles quoted cells containing commas, which a model
 *  produces constantly the moment a value has a comma in it. */
export function parseCsvToSpreadsheet(csv: string): SpreadsheetContent {
  const lines = (csv ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
  const columns = lines.length ? splitCsvLine(lines[0]) : ["A", "B", "C", "D"];
  const rows = lines.slice(1).map((l) => {
    const cells: (string | null)[] = splitCsvLine(l);
    while (cells.length < columns.length) cells.push("");
    return cells;
  });
  return { columns, rows: rows.length ? rows : Array.from({ length: 8 }, () => columns.map(() => "")) };
}

/** One CSV line → cells, honouring "quoted, cells" and doubled "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Agent text → the jsonb payload stored for this kind. */
export function contentForKind(kind: DocKind, text: string): Record<string, unknown> {
  if (kind === "document") return { nodes: parseMarkdownToSlateNodes(text) };
  if (kind === "presentation") return { slides: parseSlideLines(text) };
  return parseCsvToSpreadsheet(text) as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stored shape → agent text
// ---------------------------------------------------------------------------

/** Slate nodes → markdown. The inverse of parseMarkdownToSlateNodes, close
 *  enough that read → edit → update round-trips without degrading. */
export function slateNodesToMarkdown(nodes: unknown): string {
  const list = Array.isArray(nodes) ? nodes : [];
  const out: string[] = [];
  for (const n of list) {
    const node = (n ?? {}) as Record<string, unknown>;
    const text = childText(node.children);
    const type = String(node.type ?? "p");
    if (/^h[1-6]$/.test(type)) { out.push(`${"#".repeat(Number(type.slice(1)))} ${text}`); continue; }
    if (type === "blockquote") { out.push(`> ${text}`); continue; }
    if (type === "code_block") { out.push("```", text, "```"); continue; }
    const style = String(node.listStyleType ?? "");
    if (style === "disc" || style === "circle" || style === "square") { out.push(`- ${text}`); continue; }
    if (style === "decimal") { out.push(`1. ${text}`); continue; }
    out.push(text);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function childText(children: unknown): string {
  if (!Array.isArray(children)) return "";
  return children.map((c) => {
    const child = (c ?? {}) as Record<string, unknown>;
    if (typeof child.text === "string") return child.text;
    if (Array.isArray(child.children)) return childText(child.children);
    return "";
  }).join("");
}

/** {columns, rows} → CSV, quoting any cell that needs it. */
export function spreadsheetToCsv(content: unknown): string {
  const c = (content ?? {}) as Partial<SpreadsheetContent>;
  const columns = Array.isArray(c.columns) ? c.columns.map((x) => String(x ?? "")) : [];
  const rows = Array.isArray(c.rows) ? c.rows : [];
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) {
    const cells = Array.isArray(r) ? r : [];
    // Trailing empty rows are editor padding, not data — they only add noise.
    if (cells.every((x) => x == null || String(x).trim() === "")) continue;
    lines.push(cells.map(cell).join(","));
  }
  return lines.join("\n");
}

/** {slides} → the "Title | body" lines an agent writes. */
export function slidesToText(content: unknown): string {
  const slides = ((content ?? {}) as { slides?: unknown }).slides;
  if (!Array.isArray(slides)) return "";
  return slides.map((s) => {
    const slide = (s ?? {}) as Record<string, unknown>;
    const title = String(slide.title ?? "").trim();
    const body = String(slide.body ?? "").replace(/\n/g, " ").trim();
    return body ? `${title} | ${body}` : title;
  }).join("\n");
}

/** The stored payload of any kind → the text format the agent writes in. */
export function renderContent(kind: string, content: unknown): string {
  if (kind === "spreadsheet") return spreadsheetToCsv(content);
  if (kind === "presentation") return slidesToText(content);
  return slateNodesToMarkdown(((content ?? {}) as { nodes?: unknown }).nodes);
}

/** One line describing what the agent must write for this kind — reused across
 *  every artifact tool description so they can never drift apart. */
export const CONTENT_FORMAT_HELP =
  'document: markdown (# headings, - bullets, paragraphs) · spreadsheet: CSV, first line = header row ' +
  '(quote any cell containing a comma) · presentation: one slide per line, "Title | body text".';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ArtifactScope {
  workspaceId: string | null;
  projectId: string | null;
  /** Set when the artifact belongs to a room's Artifacts tab. */
  roomId?: string | null;
  createdBy?: string | null;
  agentId?: string | null;
}

/** Insert a document/spreadsheet/presentation from the agent's text. Returns the
 *  new row id, or null when the insert failed. */
export async function insertArtifact(
  admin: Admin, kind: DocKind, title: string, text: string, scope: ArtifactScope,
): Promise<string | null> {
  const { data, error } = await admin.from("office_documents").insert({
    workspace_id: scope.workspaceId,
    project_id: scope.projectId,
    service_room_id: scope.roomId ?? null,
    kind,
    title: title.slice(0, 200),
    content: contentForKind(kind, text),
    created_by: scope.createdBy ?? null,
  }).select("id").single();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/** Generate an image through office-ai (the media pipeline the studios used to
 *  drive) and return its `office_media` row id. Null when unavailable. */
export async function generateArtifactImage(
  admin: Admin, prompt: string, scope: ArtifactScope,
): Promise<string | null> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key || !scope.workspaceId || !scope.projectId) return null;
  try {
    const res = await fetch(`${base}/functions/v1/office-ai`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "media.generate", workspace_id: scope.workspaceId, project_id: scope.projectId,
        kind: "image", prompt,
      }),
    });
    const json = await res.json().catch(() => ({} as Record<string, unknown>));
    const id = (json as { media?: { id?: string } }).media?.id;
    if (!res.ok || !id) return null;
    if (scope.roomId) {
      await admin.from("office_media").update({ service_room_id: scope.roomId }).eq("id", id);
    }
    return id;
  } catch {
    return null;
  }
}
