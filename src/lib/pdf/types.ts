/**
 * The PDF contract — one neutral document shape for everything the app turns
 * into a PDF.
 *
 * Three producers feed it: a dashboard (its widgets, with the data already on
 * screen), a block artifact written by an agent, and a report written by Le
 * Rédacteur. Each has its own block vocabulary; each is mapped ONCE, by an
 * adapter, into this one. The renderer (pdfcn components on Takumi) therefore
 * knows a single format, and a fourth producer costs an adapter, not a renderer.
 *
 * It is also what the `generate_pdf` agent tool stores: an agent never writes
 * PDF bytes, it writes this JSON, and the app renders it on open — so the
 * document can be re-themed or re-exported without asking the model again.
 * Keep `supabase/functions/_shared/pdf-spec.ts` in step with this file.
 */

export const PDF_THEMES = [
  "professional", "modern", "corporate", "minimal", "executive", "elegant", "forest",
] as const;
export type PdfThemeName = (typeof PDF_THEMES)[number];

export type PdfTone = "info" | "success" | "warning" | "error";
export type PdfTrend = "up" | "down" | "flat";
export type PdfChartVariant = "bar" | "horizontal-bar" | "line" | "area" | "pie" | "donut";

export interface PdfListItem { text: string; children?: PdfListItem[] }

export interface PdfKpi {
  label: string;
  value: string;
  /** Free text, already formatted: "+12 %", "−37 pts". */
  delta?: string;
  trend?: PdfTrend;
  /** Whether the move is good news. Decides the colour, not the arrow. */
  good?: boolean;
  note?: string;
}

export interface PdfSeries { name: string; data: number[] }

export type PdfBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string; lead?: boolean }
  | { type: "list"; ordered?: boolean; items: PdfListItem[] }
  | { type: "checklist"; items: Array<{ text: string; checked?: boolean }> }
  | { type: "table"; columns: string[]; rows: string[][]; caption?: string }
  | { type: "kpis"; items: PdfKpi[] }
  | {
    type: "chart";
    variant: PdfChartVariant;
    title?: string;
    subtitle?: string;
    categories: string[];
    series: PdfSeries[];
    /** Appended to the values drawn on the chart ("%", " €"). */
    unit?: string;
    caption?: string;
  }
  | { type: "callout"; tone?: PdfTone; title?: string; text: string }
  | { type: "quote"; text: string; caption?: string }
  | { type: "code"; code: string }
  | { type: "image"; src: string; caption?: string }
  | { type: "keyValue"; items: Array<{ key: string; value: string }> }
  | { type: "sources"; items: Array<{ name: string; url?: string }> }
  | { type: "divider" }
  | { type: "pageBreak" };

export type PdfBlockType = PdfBlock["type"];

export interface PdfDoc {
  title: string;
  subtitle?: string;
  /** Small caps line above the title ("Rapport de mission"). */
  eyebrow?: string;
  /** Shown under the title, in order: client, period, author… */
  meta?: Array<{ label: string; value: string }>;
  /** Repeated at the bottom of every page, left of the page number. */
  footer?: string;
  blocks: PdfBlock[];
}

export interface PdfInvoiceLine { description: string; quantity: number; unitPrice: number }

export interface PdfInvoice {
  number: string;
  /** ISO dates (YYYY-MM-DD) or already-formatted text. */
  issueDate: string;
  dueDate?: string;
  /** ISO 4217. Defaults to EUR. */
  currency?: string;
  seller: { name: string; tagline?: string; address?: string; email?: string; taxId?: string };
  buyer: { name: string; address?: string; email?: string; phone?: string };
  lines: PdfInvoiceLine[];
  /** Percent, e.g. 20 for 20 %. Omitted = no tax line. */
  taxRate?: number;
  paymentMethod?: string;
  /** IBAN, bank details, payment reference. */
  paymentDetails?: string;
  notes?: string;
}

export type PdfSpec =
  | { kind: "document"; doc: PdfDoc }
  | { kind: "invoice"; invoice: PdfInvoice };

export interface PdfRenderOptions {
  theme?: PdfThemeName;
  landscape?: boolean;
  /** BCP-47, for number and date formatting. Defaults to fr-FR. */
  locale?: string;
}

/** What a `generate_pdf` deliverable stores in its `content` column. */
export interface PdfDeliverablePayload {
  format: "pdfcn";
  version: 1;
  spec: PdfSpec;
  options?: PdfRenderOptions;
}

/** Recognise a PDF deliverable from its stored content; null for every other
 *  shape, so callers can fall through to their other renderers. */
export function parsePdfDeliverable(content: unknown): PdfDeliverablePayload | null {
  if (!content) return null;
  let raw: unknown = content;
  if (typeof content === "string") {
    const s = content.trim();
    if (!s.startsWith("{") || !s.includes("pdfcn")) return null;
    try { raw = JSON.parse(s); } catch { return null; }
  }
  const p = raw as Partial<PdfDeliverablePayload> | null;
  if (!p || p.format !== "pdfcn" || !p.spec || typeof p.spec !== "object") return null;
  const kind = (p.spec as { kind?: string }).kind;
  if (kind !== "document" && kind !== "invoice") return null;
  return p as PdfDeliverablePayload;
}

export const isPdfTheme = (v: unknown): v is PdfThemeName =>
  typeof v === "string" && (PDF_THEMES as readonly string[]).includes(v);
