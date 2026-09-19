/**
 * The artifact contract — one JSON shape for everything an agent produces.
 *
 * This replaces the previous mess entirely: markdown deliverables, Plate
 * documents, CSV spreadsheets, "Title | body" slide lines, and the bespoke
 * `{title, summary, sections[]}` report schema are all gone. There is now ONE
 * document format, Editor.js's, and two things an agent can produce with it:
 *
 *   report        a scrolling document
 *   presentation  the same blocks, cut into slides by `slide` blocks
 *
 * Editor.js emits `{ time, version, blocks: [{ id, type, data }] }`. Reading it
 * back needs no editor runtime — the renderer walks `blocks` and draws each
 * type; the runtime is only loaded when a human edits. That split is what keeps
 * a report cheap to display and still editable in place.
 *
 * Editor.js ships no chart, KPI or banner tool — those do not exist in its
 * ecosystem. They are declared here as custom types carried in the same array,
 * which is exactly what its block architecture is for.
 */

export type ArtifactTarget = "report" | "presentation";

/** A block as Editor.js stores it. `data` is typed per `type` below. */
export interface ArtifactBlock<T = Record<string, unknown>> {
  id?: string;
  type: string;
  data: T;
}

/** The whole document. Exactly what Editor.js `save()` returns. */
export interface ArtifactDocument {
  time?: number;
  version?: string;
  /** Cover art key for the system header. Absent means "derive one from the id". */
  cover?: string;
  blocks: ArtifactBlock[];
}

// ── Official Editor.js block data ───────────────────────────────────────────

export interface HeaderData { text: string; level: 1 | 2 | 3 | 4 }
export interface ParagraphData { text: string }
export interface ListData { style: "ordered" | "unordered"; items: string[] }
export interface ChecklistData { items: Array<{ text: string; checked: boolean }> }
export interface ImageData {
  file: { url: string };
  caption?: string;
  withBorder?: boolean;
  withBackground?: boolean;
  stretched?: boolean;
}
export interface TableData { withHeadings?: boolean; content: string[][] }
export interface QuoteData { text: string; caption?: string; alignment?: "left" | "center" }
export interface CodeData { code: string }
export type DelimiterData = Record<string, never>;

// ── Custom blocks (no Editor.js equivalent exists) ──────────────────────────

/** The figures a reader must leave with. Rendered as a row of tiles. */
export interface KpiData {
  items: Array<{ label: string; value: string; delta?: string; trend?: "up" | "down" | "flat" }>;
}

/** Recharts-backed. `series` names the numeric keys inside `data`. */
export interface ChartData {
  chartType: "bar" | "line" | "area" | "pie" | "donut" | "radar" | "scatter";
  title?: string;
  x?: string;
  series?: string[];
  data: Array<Record<string, string | number>>;
  stacked?: boolean;
  unit?: string;
}

/** A full-width titled band — the cover of a report, the title card of a deck. */
export interface BannerData {
  title: string;
  subtitle?: string;
  author?: string;
  tone?: "default" | "info" | "success" | "warning" | "danger";
  imageUrl?: string;
}

/** X versus Y versus Z. Booleans render as ✓/✕; `highlight` marks our column. */
export interface ComparisonData {
  title?: string;
  columns: string[];
  highlight?: number;
  rows: Array<{ label: string; note?: string; cells: Array<string | boolean | null> }>;
}

/** A 2×2 positioning map. Coordinates are 0-100, origin bottom-left. */
export interface MatrixData {
  title?: string;
  xLabel: string; yLabel: string;
  xLow?: string; xHigh?: string; yLow?: string; yHigh?: string;
  quadrants?: string[];
  items: Array<{ label: string; x: number; y: number; note?: string; highlight?: boolean }>;
}

/** Pull-out note: the headline risk or win. */
export interface CalloutData {
  tone: "info" | "success" | "warning" | "danger";
  text: string;
}

/**
 * Slide boundary. A presentation is not a different document — it is the same
 * block array where every `slide` block opens a new page. A report that gains
 * slide blocks becomes a deck without being rewritten.
 */
export interface SlideData { title?: string; layout?: "title" | "content" | "split" | "full" }

/** Every type the renderer knows. Anything else degrades to nothing. */
export const BLOCK_TYPES = [
  "header", "paragraph", "list", "checklist", "image", "table", "quote", "code", "delimiter", "warning", "embed", "raw",
  "kpi", "chart", "banner", "comparison", "matrix", "callout", "slide",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const isKnownBlock = (t: string): t is BlockType =>
  (BLOCK_TYPES as readonly string[]).includes(t);

/** An empty document — what a new artifact starts from. */
export const emptyDocument = (): ArtifactDocument => ({ blocks: [] });

/**
 * Coerce whatever is in the database into a document.
 *
 * Stored content is a JSON string (what the agent wrote) or already an object.
 * Anything unparseable yields an empty document rather than throwing: a broken
 * artifact must render as empty, never take the page down with it.
 */
export function parseDocument(content: unknown): ArtifactDocument {
  const raw = typeof content === "string"
    ? (() => { try { return JSON.parse(content); } catch { return null; } })()
    : content;
  if (!raw || typeof raw !== "object") return emptyDocument();
  const blocks = (raw as ArtifactDocument).blocks;
  if (!Array.isArray(blocks)) return emptyDocument();
  return {
    time: (raw as ArtifactDocument).time,
    version: (raw as ArtifactDocument).version,
    cover: (raw as ArtifactDocument).cover,
    blocks: blocks.filter((b): b is ArtifactBlock => !!b && typeof b === "object" && typeof b.type === "string"),
  };
}

/**
 * Cut a document into slides on `slide` boundaries.
 *
 * Blocks before the first boundary form the opening slide, so a deck whose
 * author forgot the first `slide` block still renders instead of losing its
 * cover.
 */
export function toSlides(doc: ArtifactDocument): Array<{ slide: SlideData; blocks: ArtifactBlock[] }> {
  const out: Array<{ slide: SlideData; blocks: ArtifactBlock[] }> = [];
  let current: { slide: SlideData; blocks: ArtifactBlock[] } = { slide: {}, blocks: [] };
  for (const b of doc.blocks) {
    if (b.type === "slide") {
      if (current.blocks.length > 0 || current.slide.title) out.push(current);
      current = { slide: (b.data ?? {}) as SlideData, blocks: [] };
      continue;
    }
    current.blocks.push(b);
  }
  if (current.blocks.length > 0 || current.slide.title) out.push(current);
  // No boundaries at all: the whole document is one page, which is the wall of
  // text a deck exists to avoid. Cut it where its own structure says a new idea
  // starts. The authoring tools now refuse a slideless deck, but documents
  // written before that guard are already stored — they get paginated here.
  return out.length === 1 && !out[0].slide.title ? autoPaginate(out[0].blocks) : out;
}

/** How much room a block asks for, in "lines". A slide holds about seven. */
function weigh(b: ArtifactBlock): number {
  const d = (b.data ?? {}) as { items?: unknown[]; content?: unknown[]; rows?: unknown[]; text?: string };
  switch (b.type) {
    case "table": return 2 + (Array.isArray(d.content) ? d.content.length : 0);
    case "chart": case "matrix": case "image": return 6;
    case "comparison": return 3 + (Array.isArray(d.rows) ? d.rows.length : 0);
    case "kpi": return 3;
    case "list": case "checklist": return 1 + (Array.isArray(d.items) ? d.items.length : 0);
    case "code": case "quote": return 3;
    case "callout": return 2;
    case "header": return 1;
    default: return Math.max(1, Math.ceil(String(d.text ?? "").length / 90));
  }
}

const SLIDE_CAPACITY = 7;
/** A little overshoot is allowed before cutting: a page that ends on its own
 *  callout reads better than a page holding nothing but that callout. */
const SLIDE_TOLERANCE = 2;

/** Split a flat document into pages: a new page at every heading, and again
 *  whenever one gets too full to be read from across a room. */
function autoPaginate(blocks: ArtifactBlock[]): Array<{ slide: SlideData; blocks: ArtifactBlock[] }> {
  const pages: Array<{ slide: SlideData; blocks: ArtifactBlock[] }> = [];
  let page: { slide: SlideData; blocks: ArtifactBlock[] } = { slide: {}, blocks: [] };
  let load = 0;
  const flush = () => {
    if (page.blocks.length > 0 || page.slide.title) pages.push(page);
    page = { slide: {}, blocks: [] };
    load = 0;
  };
  for (const b of blocks) {
    const w = weigh(b);
    if (b.type === "header") {
      // The heading becomes the page's title rather than a block inside it —
      // the slide draws its own title.
      flush();
      page.slide = { title: String(((b.data ?? {}) as { text?: string }).text ?? "").trim() || undefined };
      continue;
    }
    if (load > 0 && load + w > SLIDE_CAPACITY + SLIDE_TOLERANCE) {
      const carried = page.slide.title;
      flush();
      // A section that spills keeps its title, so the reader does not lose the
      // thread halfway through it.
      page.slide = carried ? { title: `${carried} (suite)` } : {};
    }
    page.blocks.push(b);
    load += w;
  }
  flush();
  return pages.length > 0 ? pages : [{ slide: {}, blocks }];
}
