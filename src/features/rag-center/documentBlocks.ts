// Heuristic block segmentation of extracted document text → typed blocks, so we
// can render a "Visuel" view that labels each block (title / text / code /
// caption / table / list / footer), similar to a Document-AI layout result.
// Our extractor returns plain merged text (no layout coordinates), so this is a
// best-effort structural reconstruction, not pixel-accurate layout analysis.

export type BlockType = "title" | "text" | "code" | "caption" | "table" | "list" | "footer";

export interface DocBlock { type: BlockType; content: string }

export const BLOCK_META: Record<BlockType, { label: string; chip: string }> = {
  title: { label: "titre", chip: "bg-blue-600" },
  text: { label: "texte", chip: "bg-sky-500" },
  code: { label: "code", chip: "bg-emerald-600" },
  caption: { label: "légende", chip: "bg-amber-500" },
  table: { label: "tableau", chip: "bg-violet-600" },
  list: { label: "liste", chip: "bg-cyan-600" },
  footer: { label: "pied de page", chip: "bg-pink-600" },
};

const FENCE = /^\s*```/;
const HEADING_MD = /^\s{0,3}#{1,6}\s+/;
const NUM_HEADING = /^\s*\d+(\.\d+)*[.)]?\s+\S/;                 // "1. Introduction", "2.1 Foo"
const CAPTION_RE = /^\s*(figure|fig\.?|tableau|table|listing|sch[ée]ma|image|photo|capture)\s*\d/i;
const LIST_RE = /^\s*([-*•]|\d+[.)])\s+/;
const CODEISH = /(^|\s)(sudo |\$ ?|#!\/|apt |apt-get |systemctl |service |nmcli |ip |iface |auto |chmod |chown |mkdir |cd |cat |echo |curl |wget |docker |git |npm |yarn |pip )/i;

const isFooter = (l: string) => /^\s*(page\s*)?\d+(\s*\/\s*\d+)?\s*$/i.test(l) && l.trim().length <= 14;
const looksCode = (l: string) => CODEISH.test(l) || /[{};]\s*$/.test(l) || /^\s{4,}\S/.test(l) || /=[^=]/.test(l) && /[_\-/]/.test(l);

/** Split extracted text into typed blocks. */
export function segmentBlocks(raw: string): DocBlock[] {
  const lines = (raw ?? "").replace(/\r/g, "").split("\n");
  const blocks: DocBlock[] = [];
  const push = (type: BlockType, content: string) => { const c = content.trim(); if (c) blocks.push({ type, content: c }); };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code block.
    if (FENCE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      push("code", buf.join("\n"));
      continue;
    }
    // Markdown/pipe table (≥2 consecutive lines with pipes).
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].includes("|")) { buf.push(lines[i]); i++; }
      push("table", buf.join("\n"));
      continue;
    }
    // Caption.
    if (CAPTION_RE.test(line)) { push("caption", line); i++; continue; }
    // Footer (standalone page number).
    if (isFooter(line)) { push("footer", line); i++; continue; }
    // Heading.
    if (HEADING_MD.test(line) || NUM_HEADING.test(line)) { push("title", line.replace(HEADING_MD, "")); i++; continue; }
    // List group.
    if (LIST_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && (LIST_RE.test(lines[i]) || lines[i].startsWith("  "))) { buf.push(lines[i]); i++; }
      push("list", buf.join("\n"));
      continue;
    }
    // Code-ish run (shell / config lines).
    if (looksCode(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !CAPTION_RE.test(lines[i]) && !HEADING_MD.test(lines[i]) && looksCode(lines[i])) { buf.push(lines[i]); i++; }
      if (buf.length >= 1) { push("code", buf.join("\n")); continue; }
    }
    // Paragraph run (until a blank line or a structural line).
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !HEADING_MD.test(lines[i]) && !NUM_HEADING.test(lines[i]) && !CAPTION_RE.test(lines[i])
      && !FENCE.test(lines[i]) && !LIST_RE.test(lines[i]) && !isFooter(lines[i])) {
      buf.push(lines[i]); i++;
    }
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    // A lone short line with no terminal punctuation reads as a title.
    if (buf.length === 1 && text.length <= 64 && !/[.:;,]$/.test(text)) push("title", text);
    else push("text", text);
  }
  return blocks;
}
