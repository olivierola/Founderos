// Shared types + helpers for the Office (Bureautique) module.
// One polymorphic record type backs documents, spreadsheets and presentations.

import { supabase } from "@/lib/supabase";
import { FileText, Table as TableIcon, Presentation } from "lucide-react";

export type OfficeKind = "document" | "spreadsheet" | "presentation";

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

export interface OfficeDoc {
  id: string;
  workspace_id: string;
  project_id: string;
  kind: OfficeKind;
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

export const KIND_META: Record<
  OfficeKind,
  { label: string; plural: string; icon: any; emoji: string; accent: string }
> = {
  document: { label: "Document", plural: "Documents", icon: FileText, emoji: "📝", accent: "text-sky-500" },
  spreadsheet: { label: "Spreadsheet", plural: "Spreadsheets", icon: TableIcon, emoji: "📊", accent: "text-emerald-500" },
  presentation: { label: "Presentation", plural: "Presentations", icon: Presentation, emoji: "🖼️", accent: "text-amber-500" },
};

// --- default empty content per kind ----------------------------------------

export function emptyContent(kind: OfficeKind): OfficeDoc["content"] {
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

export function extractPreview(kind: OfficeKind, content: OfficeDoc["content"]): string {
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
export function markdownToSlate(md: string): any[] {
  const out: any[] = [];
  const lines = (md ?? "").split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push({ type: `h${h[1].length}`, children: [{ text: h[2] }] }); continue; }
    if (/^>\s+/.test(line)) { out.push({ type: "blockquote", children: [{ text: line.replace(/^>\s+/, "") }] }); continue; }
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

// --- data access -----------------------------------------------------------

export async function loadOfficeDocs(projectId: string, kind?: OfficeKind): Promise<OfficeDoc[]> {
  let q = supabase
    .from("office_documents")
    .select("*")
    .eq("project_id", projectId)
    .eq("is_archived", false)
    .order("updated_at", { ascending: false });
  if (kind) q = q.eq("kind", kind);
  const { data } = await q;
  return (data ?? []) as OfficeDoc[];
}

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
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
