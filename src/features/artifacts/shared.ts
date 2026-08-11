// Shared types + helpers for AGENT ARTIFACTS — the documents, spreadsheets and
// presentations agents produce with create_artifact (they land in
// `office_documents`, the table name kept for compatibility). One polymorphic
// record type backs all three kinds; the editors under this folder are the
// surface a human opens them in, from a room's Artifacts tab or a CRM record.

export type ArtifactKind = "document" | "spreadsheet" | "presentation";

// --- content payloads (per kind) -------------------------------------------

// Plate/Slate value is an array of nodes. We store it wrapped so the column is
// always an object (jsonb default '{}').
export interface DocumentContent {
  nodes: any[];
}

export interface SpreadsheetContent {
  columns: string[];
  rows: (string | number | null)[][];
}

export interface Slide {
  title: string;
  body: string; // markdown-ish bullet text
  layout: "title" | "title-content" | "section" | "blank";
  notes?: string;
}
export interface PresentationContent {
  slides: Slide[];
}

export interface ArtifactDoc {
  id: string;
  workspace_id: string;
  project_id: string;
  kind: ArtifactKind;
  title: string;
  content: DocumentContent | SpreadsheetContent | PresentationContent | Record<string, unknown>;
  preview_text: string | null;
  emoji: string | null;
  tags: string[];
  is_archived: boolean;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

// --- default empty content per kind ----------------------------------------

export function emptyContent(kind: ArtifactKind): ArtifactDoc["content"] {
  if (kind === "document") {
    return { nodes: [{ type: "p", children: [{ text: "" }] }] } as DocumentContent;
  }
  if (kind === "spreadsheet") {
    return {
      columns: ["A", "B", "C", "D"],
      rows: Array.from({ length: 12 }, () => ["", "", "", ""]),
    } as SpreadsheetContent;
  }
  return {
    slides: [{ title: "Untitled presentation", body: "", layout: "title" }],
  } as PresentationContent;
}

// --- plain-text extraction for preview/search ------------------------------

export function extractPreview(kind: ArtifactKind, content: ArtifactDoc["content"]): string {
  try {
    if (kind === "document") {
      return slateToText((content as DocumentContent).nodes ?? []).slice(0, 400);
    }
    if (kind === "spreadsheet") {
      const c = content as SpreadsheetContent;
      return (c.rows ?? [])
        .flat()
        .filter((v) => v !== "" && v != null)
        .slice(0, 40)
        .join(" · ")
        .slice(0, 400);
    }
    const c = content as PresentationContent;
    return (c.slides ?? []).map((s) => `${s.title} ${s.body}`).join(" ").slice(0, 400);
  } catch {
    return "";
  }
}

export function slateToText(nodes: any[]): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (typeof n?.text === "string") out.push(n.text);
    if (Array.isArray(n?.children)) n.children.forEach(walk);
  };
  (nodes ?? []).forEach(walk);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Cells / slide bodies may hold either legacy plain text (string) or a Plate
// value (array of nodes). These helpers normalise both directions so the rich
// editor always works on a Plate value while staying backward-compatible.
export function toRichValue(v: unknown): any[] {
  if (Array.isArray(v)) return v.length ? v : [{ type: "p", children: [{ text: "" }] }];
  const text = v == null ? "" : String(v);
  // Treat existing markdown-ish bullet text as markdown so lists survive.
  return text.trim() ? markdownToSlate(text) : [{ type: "p", children: [{ text: "" }] }];
}

// A compact text rendering for previews/CSV/PDF of a rich value (or string).
export function richValueToText(v: unknown): string {
  if (Array.isArray(v)) return slateToText(v);
  return v == null ? "" : String(v);
}

// Convert a Plate/Slate value to markdown (small subset: headings, lists, quote,
// code, marks). Good enough for export + AI round-trips.
export function slateToMarkdown(nodes: any[]): string {
  const inline = (children: any[]): string =>
    (children ?? [])
      .map((c) => {
        let t = c.text ?? "";
        if (!t && c.children) return inline(c.children);
        if (c.code) t = "`" + t + "`";
        if (c.bold) t = "**" + t + "**";
        if (c.italic) t = "*" + t + "*";
        return t;
      })
      .join("");

  const lines: string[] = [];
  let olCount = 0;
  for (const n of nodes ?? []) {
    const text = inline(n.children ?? []);
    // Plate v53 lists are paragraphs carrying listStyleType + indent.
    if (n.listStyleType) {
      const ordered = n.listStyleType === "decimal";
      const pad = "  ".repeat(Math.max(0, (n.indent ?? 1) - 1));
      if (ordered) { olCount += 1; lines.push(`${pad}${olCount}. ${text}`); }
      else { olCount = 0; lines.push(`${pad}- ${text}`); }
      continue;
    }
    olCount = 0;
    switch (n.type) {
      case "h1": lines.push(`# ${text}`); break;
      case "h2": lines.push(`## ${text}`); break;
      case "h3": lines.push(`### ${text}`); break;
      case "blockquote": lines.push(`> ${text}`); break;
      case "code_block": lines.push("```\n" + text + "\n```"); break;
      default: lines.push(text);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// Convert a markdown string (subset) into a Plate/Slate value. Used when the AI
// returns markdown that we insert into a document.
const tableCells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

const isTableSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Header row + rows → a Plate table node. */
function buildTable(header: string[], rows: string[][]): any {
  const cell = (t: string, head: boolean) => ({
    type: head ? "th" : "td",
    children: [{ type: "p", children: parseInlineMarks(t) }],
  });
  // Without explicit column sizes Plate falls back to a narrow default, so a
  // three-column comparison rendered as a thin strip with every header wrapped
  // over three lines. Spread the usable width evenly instead.
  const width = Math.max(120, Math.round(760 / Math.max(1, header.length)));
  return {
    type: "table",
    colSizes: header.map(() => width),
    children: [
      { type: "tr", children: header.map((h) => cell(h, true)) },
      ...rows.map((r) => ({ type: "tr", children: header.map((_, i) => cell(r[i] ?? "", false)) })),
    ],
  };
}

/**
 * Repair a document whose markdown was flattened when it was written.
 *
 * Documents created before the converter understood tables and inline marks are
 * already stored as paragraphs of raw text — `**gras**` with its asterisks, and
 * a comparison table as a stack of `| a | b |` lines. Reparsing at write time
 * cannot fix what is already in the database, so we heal on load: only the
 * nodes that still carry literal markdown are touched, everything else is
 * passed through untouched.
 */
export function healFlatMarkdown(nodes: any[]): any[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes;
  const textOf = (n: any): string =>
    Array.isArray(n?.children) ? n.children.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
  const isPlainP = (n: any) => n?.type === "p" && !n.listStyleType && (n.children ?? []).every((c: any) => typeof c?.text === "string");

  const out: any[] = [];
  let changed = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const text = textOf(n);

    // A table: this paragraph is a pipe row and the next is the |---|---| rule.
    if (isPlainP(n) && text.includes("|") && i + 1 < nodes.length && isTableSeparator(textOf(nodes[i + 1]))) {
      const header = tableCells(text);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < nodes.length && isPlainP(nodes[j]) && textOf(nodes[j]).includes("|")) { rows.push(tableCells(textOf(nodes[j]))); j++; }
      out.push(buildTable(header, rows));
      i = j - 1;
      changed = true;
      continue;
    }

    // Literal inline markers left in a text leaf. Single-asterisk italic is in
    // the list too — `*août 2026*` survived the first pass because only the
    // double-marker forms were detected.
    if (Array.isArray(n?.children)
      && /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|~~[^~]+~~|(^|[^*])\*[^*\n]+\*([^*]|$))/.test(text)) {
      out.push({ ...n, children: parseInlineMarks(text) });
      changed = true;
      continue;
    }
    out.push(n);
  }
  return changed ? out : nodes;
}

export function markdownToSlate(md: string): any[] {
  const out: any[] = [];
  const lines = (md ?? "").split("\n");
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\r$/, "");
    // GFM table
    if (line.includes("|") && li + 1 < lines.length && isTableSeparator(lines[li + 1])) {
      const header = tableCells(line);
      const rows: string[][] = [];
      li += 2;
      while (li < lines.length && lines[li].includes("|") && lines[li].trim() !== "") { rows.push(tableCells(lines[li])); li++; }
      li--;
      out.push(buildTable(header, rows));
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push({ type: `h${h[1].length}`, children: parseInlineMarks(h[2]) }); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out.push({ type: "hr", children: [{ text: "" }] }); continue; }
    if (/^>\s+/.test(line)) { out.push({ type: "blockquote", children: parseInlineMarks(line.replace(/^>\s+/, "")) }); continue; }
    // Bulleted / numbered lists → Plate v53 indent-based list paragraphs.
    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ol) {
      const indent = Math.floor(ol[1].length / 2) + 1;
      out.push({ type: "p", indent, listStyleType: "decimal", children: parseInlineMarks(ol[2]) });
      continue;
    }
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      const indent = Math.floor(ul[1].length / 2) + 1;
      out.push({ type: "p", indent, listStyleType: "disc", children: parseInlineMarks(ul[2]) });
      continue;
    }
    if (line.trim() === "") continue;
    out.push({ type: "p", children: parseInlineMarks(line) });
  }
  return out.length ? out : [{ type: "p", children: [{ text: "" }] }];
}

// Parse a subset of inline markdown (**bold**, *italic*, `code`) into Slate text runs.
function parseInlineMarks(text: string): any[] {
  const runs: any[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith("**")) runs.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith("`")) runs.push({ text: t.slice(1, -1), code: true });
    else runs.push({ text: t.slice(1, -1), italic: true });
    last = m.index + t.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

export function downloadBlob(filename: string, content: string | Blob, mime = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function sanitizeFilename(s: string): string {
  return (s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)) || "document";
}
