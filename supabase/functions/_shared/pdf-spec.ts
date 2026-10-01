// PDF specs written by agents (the `generate_pdf` tool).
//
// An agent never produces PDF bytes: it writes a PdfSpec — a document (title +
// blocks) or an invoice — and the app renders it with pdfcn on Takumi when the
// deliverable is opened (src/features/pdf). Keeping the JSON rather than a file
// is what lets the user re-theme or re-export it without asking the model again.
//
// This file is the server half of src/lib/pdf/types.ts. The two must describe
// the same shape: a block accepted here that the renderer does not know is a
// block that silently disappears from the user's PDF.
//
// Normalisation is tolerant on FORM (a string list item, a number as a string,
// a missing level) and strict on SUBSTANCE (an empty table, a chart with no
// data, an invoice with no line are errors, returned to the agent to fix).

export const PDF_THEMES = ["professional", "modern", "corporate", "minimal", "executive", "elegant", "forest"] as const;
export type PdfThemeName = (typeof PDF_THEMES)[number];

type Tone = "info" | "success" | "warning" | "error";
type ChartVariant = "bar" | "horizontal-bar" | "line" | "area" | "pie" | "donut";

export interface PdfListItem { text: string; children?: PdfListItem[] }
export interface PdfKpi { label: string; value: string; delta?: string; trend?: "up" | "down" | "flat"; good?: boolean; note?: string }
export type PdfBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string; lead?: boolean }
  | { type: "list"; ordered?: boolean; items: PdfListItem[] }
  | { type: "checklist"; items: Array<{ text: string; checked?: boolean }> }
  | { type: "table"; columns: string[]; rows: string[][]; caption?: string }
  | { type: "kpis"; items: PdfKpi[] }
  | { type: "chart"; variant: ChartVariant; title?: string; subtitle?: string; categories: string[]; series: Array<{ name: string; data: number[] }>; unit?: string; caption?: string }
  | { type: "callout"; tone?: Tone; title?: string; text: string }
  | { type: "quote"; text: string; caption?: string }
  | { type: "code"; code: string }
  | { type: "image"; src: string; caption?: string }
  | { type: "keyValue"; items: Array<{ key: string; value: string }> }
  | { type: "sources"; items: Array<{ name: string; url?: string }> }
  | { type: "divider" }
  | { type: "pageBreak" };

export interface PdfDoc {
  title: string; subtitle?: string; eyebrow?: string;
  meta?: Array<{ label: string; value: string }>; footer?: string;
  blocks: PdfBlock[];
}
export interface PdfInvoice {
  number: string; issueDate: string; dueDate?: string; currency?: string;
  seller: { name: string; tagline?: string; address?: string; email?: string; taxId?: string };
  buyer: { name: string; address?: string; email?: string; phone?: string };
  lines: Array<{ description: string; quantity: number; unitPrice: number }>;
  taxRate?: number; paymentMethod?: string; paymentDetails?: string; notes?: string;
}
export type PdfSpec = { kind: "document"; doc: PdfDoc } | { kind: "invoice"; invoice: PdfInvoice };

export const PDF_BLOCK_CATALOGUE =
  "BLOCS (block.type → champs) : "
  + 'heading {text, level:1|2|3} · paragraph {text, lead?:true pour le chapô} · '
  + 'list {ordered?:bool, items:["texte", {text, children:[…]}]} · checklist {items:[{text, checked}]} · '
  + 'table {columns:["A","B"], rows:[["a1","b1"]], caption?} (cellules = chaînes, autant que de colonnes) · '
  + 'kpis {items:[{label, value:"1 240", delta?:"+12 %", trend?:"up"|"down"|"flat", good?:bool, note?}]} (1 à 4) · '
  + 'chart {variant:"bar"|"horizontal-bar"|"line"|"area"|"pie"|"donut", title, categories:["Jan","Fév"], series:[{name, data:[12,15]}], unit?:" €", caption?} '
  + '(data = autant de nombres que de categories ; pie/donut = une seule série) · '
  + 'callout {tone:"info"|"success"|"warning"|"error", title?, text} · quote {text, caption?} · code {code} · '
  + 'image {src:"https://…", caption?} · keyValue {items:[{key, value}]} · sources {items:[{name, url?}]} · divider {} · pageBreak {}. '
  + "Texte brut uniquement : ni markdown ni HTML (ils seraient imprimés tels quels).";

const MAX_BLOCKS = 200;
const MAX_JSON = 250_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Plain text: markup is stripped, because the PDF prints strings verbatim. */
const txt = (v: unknown, max = 4000): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim().slice(0, max);
};
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    // \s covers the no-break spaces fr-FR puts between thousands.
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const opt = (v: unknown, max?: number): string | undefined => txt(v, max) || undefined;

function listItems(v: unknown, depth = 0): PdfListItem[] {
  return arr(v).flatMap((raw): PdfListItem[] => {
    if (typeof raw === "string" || typeof raw === "number") return txt(raw) ? [{ text: txt(raw) }] : [];
    if (!isObj(raw)) return [];
    const text = txt(raw.text ?? raw.content);
    const children = depth < 3 ? listItems(raw.children ?? raw.items, depth + 1) : [];
    return text ? [{ text, ...(children.length ? { children } : {}) }] : [];
  });
}

function block(raw: unknown, i: number, errors: string[]): PdfBlock | null {
  if (!isObj(raw)) { errors.push(`bloc ${i + 1} : ce n'est pas un objet {type, …}.`); return null; }
  // Accept both {type, …fields} and the add_block shape {type, data:{…}}.
  const d = isObj(raw.data) ? { ...raw.data, type: raw.type } : raw;
  const type = String(d.type ?? "");
  const where = `bloc ${i + 1} (${type || "sans type"})`;
  switch (type) {
    case "heading": case "header": {
      const text = txt(d.text, 300);
      if (!text) { errors.push(`${where} : text vide.`); return null; }
      const l = Number(d.level) || 2;
      return { type: "heading", text, level: l <= 1 ? 1 : l === 2 ? 2 : 3 };
    }
    case "paragraph": case "lead": {
      const text = txt(d.text, 6000);
      if (!text) { errors.push(`${where} : text vide.`); return null; }
      return { type: "paragraph", text, ...(d.lead || type === "lead" ? { lead: true } : {}) };
    }
    case "list": {
      const items = listItems(d.items);
      if (!items.length) { errors.push(`${where} : items vide.`); return null; }
      return { type: "list", ordered: d.ordered === true || d.style === "ordered", items };
    }
    case "checklist": {
      const items = arr(d.items).flatMap((it) => {
        const text = txt(isObj(it) ? it.text : it, 500);
        return text ? [{ text, checked: isObj(it) && it.checked === true }] : [];
      });
      if (!items.length) { errors.push(`${where} : items vide.`); return null; }
      return { type: "checklist", items };
    }
    case "table": {
      let columns = arr(d.columns).map((c) => txt(c, 120));
      let rows = arr(d.rows).map((r) => arr(r).map((c) => txt(c, 400)));
      // The artifact shape {content:[[header…],[row…]]} is accepted too.
      if (!columns.length && Array.isArray(d.content)) {
        const content = arr(d.content).map((r) => arr(r).map((c) => txt(c, 400)));
        columns = content[0] ?? [];
        rows = content.slice(1);
      }
      if (!columns.length) { errors.push(`${where} : columns vide.`); return null; }
      if (!rows.length) { errors.push(`${where} : aucune ligne (rows).`); return null; }
      if (columns.length > 8) { errors.push(`${where} : ${columns.length} colonnes — 8 au plus tiennent sur une page A4.`); return null; }
      const bad = rows.findIndex((r) => r.length !== columns.length);
      if (bad >= 0) { errors.push(`${where} : la ligne ${bad + 1} a ${rows[bad].length} cellules pour ${columns.length} colonnes.`); return null; }
      return { type: "table", columns, rows: rows.slice(0, 300), ...(opt(d.caption, 300) ? { caption: opt(d.caption, 300) } : {}) };
    }
    case "kpis": case "kpi": {
      const items: PdfKpi[] = arr(d.items).flatMap((k): PdfKpi[] => {
        if (!isObj(k)) return [];
        const label = txt(k.label, 60);
        const value = txt(k.value, 40);
        if (!label || !value) return [];
        const trend = k.trend === "up" || k.trend === "down" || k.trend === "flat" ? k.trend : undefined;
        return [{
          label, value,
          ...(opt(k.delta, 30) ? { delta: opt(k.delta, 30) } : {}),
          ...(trend ? { trend } : {}),
          ...(typeof k.good === "boolean" ? { good: k.good } : {}),
          ...(opt(k.note, 60) ? { note: opt(k.note, 60) } : {}),
        }];
      });
      if (!items.length) { errors.push(`${where} : aucun indicateur avec label ET value.`); return null; }
      if (items.length > 4) { errors.push(`${where} : ${items.length} indicateurs — 4 au plus par rangée, fais deux blocs kpis.`); return null; }
      return { type: "kpis", items };
    }
    case "chart": {
      const variants: ChartVariant[] = ["bar", "horizontal-bar", "line", "area", "pie", "donut"];
      const v = String(d.variant ?? d.chartType ?? "bar").replace(/^hbar$/, "horizontal-bar");
      const variant = (variants as string[]).includes(v) ? v as ChartVariant : null;
      if (!variant) { errors.push(`${where} : variant « ${v} » inconnu (${variants.join(", ")}).`); return null; }
      const categories = arr(d.categories).map((c) => txt(c, 60));
      const series = arr(d.series).flatMap((s) => {
        if (!isObj(s)) return [];
        const data = arr(s.data).map(num);
        return [{ name: txt(s.name, 60) || "Série", data: data.map((n) => n ?? 0), bad: data.some((n) => n === null) }];
      });
      if (!categories.length) { errors.push(`${where} : categories vide.`); return null; }
      if (!series.length) { errors.push(`${where} : series vide.`); return null; }
      const off = series.find((s) => s.data.length !== categories.length);
      if (off) { errors.push(`${where} : la série « ${off.name} » a ${off.data.length} valeurs pour ${categories.length} catégories.`); return null; }
      if (series.some((s) => s.bad)) { errors.push(`${where} : des valeurs de series ne sont pas des nombres.`); return null; }
      if ((variant === "pie" || variant === "donut") && series.length > 1) { errors.push(`${where} : un ${variant} ne prend qu'une série.`); return null; }
      if (categories.length > 60) { errors.push(`${where} : ${categories.length} catégories — agrège (60 au plus).`); return null; }
      return {
        type: "chart", variant, categories,
        series: series.map(({ name, data }) => ({ name, data })),
        ...(opt(d.title, 120) ? { title: opt(d.title, 120) } : {}),
        ...(opt(d.subtitle, 200) ? { subtitle: opt(d.subtitle, 200) } : {}),
        ...(opt(d.unit, 8) ? { unit: opt(d.unit, 8) } : {}),
        ...(opt(d.caption, 300) ? { caption: opt(d.caption, 300) } : {}),
      };
    }
    case "callout": case "warning": {
      const text = txt(d.text ?? d.message, 2000);
      if (!text) { errors.push(`${where} : text vide.`); return null; }
      const t = String(d.tone ?? (type === "warning" ? "warning" : "info"));
      const tone: Tone = t === "success" || t === "warning" || t === "error" ? t : t === "danger" ? "error" : "info";
      return { type: "callout", tone, text, ...(opt(d.title, 120) ? { title: opt(d.title, 120) } : {}) };
    }
    case "quote": {
      const text = txt(d.text, 1500);
      if (!text) { errors.push(`${where} : text vide.`); return null; }
      return { type: "quote", text, ...(opt(d.caption, 200) ? { caption: opt(d.caption, 200) } : {}) };
    }
    case "code": {
      const code = typeof d.code === "string" ? d.code.slice(0, 8000) : "";
      if (!code.trim()) { errors.push(`${where} : code vide.`); return null; }
      return { type: "code", code };
    }
    case "image": {
      const src = typeof d.src === "string" ? d.src : typeof d.url === "string" ? d.url : "";
      if (!/^https:\/\//.test(src)) { errors.push(`${where} : src doit être une URL https.`); return null; }
      return { type: "image", src, ...(opt(d.caption, 300) ? { caption: opt(d.caption, 300) } : {}) };
    }
    case "keyValue": case "key_value": {
      const items = arr(d.items).flatMap((it) => {
        if (!isObj(it)) return [];
        const key = txt(it.key ?? it.label, 80);
        const value = txt(it.value, 300);
        return key ? [{ key, value }] : [];
      });
      if (!items.length) { errors.push(`${where} : items vide.`); return null; }
      return { type: "keyValue", items };
    }
    case "sources": {
      const items = arr(d.items).flatMap((it) => {
        const name = txt(isObj(it) ? it.name : it, 120);
        const url = isObj(it) && typeof it.url === "string" && /^https?:\/\//.test(it.url) ? it.url : undefined;
        return name ? [{ name, ...(url ? { url } : {}) }] : [];
      });
      if (!items.length) { errors.push(`${where} : items vide.`); return null; }
      return { type: "sources", items };
    }
    case "divider": case "delimiter":
      return { type: "divider" };
    case "pageBreak": case "page_break":
      return { type: "pageBreak" };
    default:
      errors.push(`${where} : type inconnu.`);
      return null;
  }
}

function invoice(raw: unknown, errors: string[]): PdfInvoice | null {
  if (!isObj(raw)) { errors.push("invoice est requis pour kind=\"invoice\" (un objet)."); return null; }
  const seller = isObj(raw.seller) ? raw.seller : {};
  const buyer = isObj(raw.buyer) ? raw.buyer : {};
  const lines = arr(raw.lines).flatMap((l, i) => {
    if (!isObj(l)) return [];
    const description = txt(l.description, 300);
    const quantity = num(l.quantity) ?? 1;
    const unitPrice = num(l.unitPrice ?? l.unit_price ?? l.price);
    if (!description || unitPrice === null) { errors.push(`ligne ${i + 1} : description et unitPrice (nombre) sont requis.`); return []; }
    return [{ description, quantity, unitPrice }];
  });
  const number = txt(raw.number, 60);
  const issueDate = txt(raw.issueDate ?? raw.issue_date, 40);
  if (!number) errors.push("invoice.number est requis.");
  if (!issueDate) errors.push("invoice.issueDate est requis (AAAA-MM-JJ).");
  if (!txt(seller.name)) errors.push("invoice.seller.name est requis.");
  if (!txt(buyer.name)) errors.push("invoice.buyer.name est requis.");
  if (!lines.length) errors.push("invoice.lines doit contenir au moins une ligne.");
  const currency = txt(raw.currency, 20).toUpperCase() || "EUR";
  if (!/^[A-Z]{3}$/.test(currency)) errors.push(`invoice.currency « ${currency} » n'est pas un code ISO 4217 (EUR, USD…).`);
  const taxRate = raw.taxRate === undefined && raw.tax_rate === undefined ? undefined : num(raw.taxRate ?? raw.tax_rate);
  if (taxRate !== undefined && (taxRate === null || taxRate < 0 || taxRate > 100)) errors.push("invoice.taxRate est un pourcentage entre 0 et 100 (20 pour 20 %).");
  if (errors.length) return null;
  return {
    number, issueDate, currency, lines,
    ...(opt(raw.dueDate ?? raw.due_date, 40) ? { dueDate: opt(raw.dueDate ?? raw.due_date, 40) } : {}),
    seller: {
      name: txt(seller.name, 120),
      ...(opt(seller.tagline, 120) ? { tagline: opt(seller.tagline, 120) } : {}),
      ...(opt(seller.address, 200) ? { address: opt(seller.address, 200) } : {}),
      ...(opt(seller.email, 120) ? { email: opt(seller.email, 120) } : {}),
      ...(opt(seller.taxId ?? seller.tax_id, 80) ? { taxId: opt(seller.taxId ?? seller.tax_id, 80) } : {}),
    },
    buyer: {
      name: txt(buyer.name, 120),
      ...(opt(buyer.address, 200) ? { address: opt(buyer.address, 200) } : {}),
      ...(opt(buyer.email, 120) ? { email: opt(buyer.email, 120) } : {}),
      ...(opt(buyer.phone, 40) ? { phone: opt(buyer.phone, 40) } : {}),
    },
    ...(taxRate ? { taxRate } : {}),
    ...(opt(raw.paymentMethod ?? raw.payment_method, 120) ? { paymentMethod: opt(raw.paymentMethod ?? raw.payment_method, 120) } : {}),
    ...(opt(raw.paymentDetails ?? raw.payment_details, 300) ? { paymentDetails: opt(raw.paymentDetails ?? raw.payment_details, 300) } : {}),
    ...(opt(raw.notes, 1000) ? { notes: opt(raw.notes, 1000) } : {}),
  };
}

/** Totals as the PDF will print them (cents, rounded the same way). */
export function invoiceTotal(inv: PdfInvoice): { subtotal: number; tax: number; total: number } {
  const subtotal = inv.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPrice * 100), 0) / 100;
  const tax = inv.taxRate ? Math.round(subtotal * inv.taxRate) / 100 : 0;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

export interface NormalizedPdf { spec: PdfSpec | null; errors: string[] }

export function normalizePdfSpec(args: Record<string, unknown>): NormalizedPdf {
  const errors: string[] = [];
  const kind = args.kind === "invoice" ? "invoice" : "document";
  if (kind === "invoice") {
    const inv = invoice(args.invoice, errors);
    return { spec: inv ? { kind: "invoice", invoice: inv } : null, errors };
  }
  const title = txt(args.title, 160);
  if (!title) errors.push("title est requis.");
  const rawBlocks = arr(args.blocks);
  if (!rawBlocks.length) errors.push(`blocks est vide — un document a au moins un bloc. ${PDF_BLOCK_CATALOGUE}`);
  if (rawBlocks.length > MAX_BLOCKS) errors.push(`${rawBlocks.length} blocs — ${MAX_BLOCKS} au plus.`);
  const blocks = rawBlocks.slice(0, MAX_BLOCKS).map((b, i) => block(b, i, errors)).filter((b): b is PdfBlock => !!b);
  const meta = arr(args.meta).flatMap((m) => {
    if (!isObj(m)) return [];
    const label = txt(m.label, 40);
    const value = txt(m.value, 120);
    return label && value ? [{ label, value }] : [];
  }).slice(0, 6);
  if (errors.length) return { spec: null, errors };
  const doc: PdfDoc = {
    title, blocks,
    ...(opt(args.subtitle, 300) ? { subtitle: opt(args.subtitle, 300) } : {}),
    ...(opt(args.eyebrow, 60) ? { eyebrow: opt(args.eyebrow, 60) } : {}),
    ...(meta.length ? { meta } : {}),
    ...(opt(args.footer, 120) ? { footer: opt(args.footer, 120) } : {}),
  };
  if (JSON.stringify(doc).length > MAX_JSON) {
    return { spec: null, errors: ["le document dépasse 250 Ko de contenu — raccourcis ou agrège les tableaux."] };
  }
  return { spec: { kind: "document", doc }, errors };
}
