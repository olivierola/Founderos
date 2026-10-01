/**
 * Existing documents → PdfDoc.
 *
 * Two block vocabularies already exist in the app, both written by agents:
 *   - the artifact format (Editor.js blocks + kpi/chart/comparison/matrix/callout),
 *     see features/artifacts/blocks.ts;
 *   - Le Rédacteur's report document (lead/kpis/chart/banner/figure/sources…),
 *     see supabase/functions/_shared/report-artisan.ts.
 * Each is mapped here, block by block. A block with nothing printable in it is
 * dropped rather than drawn empty — an empty table frame reads as an error.
 */
import type { ArtifactDocument } from "@/features/artifacts/blocks";
import type { PdfBlock, PdfChartVariant, PdfDoc, PdfKpi, PdfListItem, PdfTone } from "@/lib/pdf/types";
import { cellText, htmlToText, toNumber } from "@/lib/pdf/text";

type Data = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Data => (v && typeof v === "object" && !Array.isArray(v) ? (v as Data) : {});
const str = (v: unknown): string => htmlToText(v);

function listItems(items: unknown): PdfListItem[] {
  return arr(items).flatMap((raw): PdfListItem[] => {
    if (typeof raw === "string") return raw.trim() ? [{ text: str(raw) }] : [];
    const it = obj(raw);
    const text = str(it.content ?? it.text ?? "");
    const children = listItems(it.items);
    return text || children.length ? [{ text, children: children.length ? children : undefined }] : [];
  });
}

function tableBlock(d: Data): PdfBlock | null {
  const content = arr(d.content).map((r) => arr(r).map(cellText));
  if (content.length === 0) return null;
  const withHeadings = d.withHeadings !== false;
  const width = Math.max(...content.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
  const columns = withHeadings ? pad(content[0]) : Array.from({ length: width }, () => "");
  const rows = (withHeadings ? content.slice(1) : content).map(pad);
  return rows.length || withHeadings ? { type: "table", columns, rows } : null;
}

const toneOf = (v: unknown): PdfTone => {
  const t = String(v ?? "");
  if (t === "success" || t === "good") return "success";
  if (t === "warning" || t === "warn") return "warning";
  if (t === "danger" || t === "critical" || t === "error") return "error";
  return "info";
};

// ── Artifact documents ─────────────────────────────────────────────────────

function artifactChart(d: Data): PdfBlock | null {
  const rows = arr(d.data).map(obj);
  if (rows.length === 0) return null;
  const x = typeof d.x === "string" ? d.x : Object.keys(rows[0])[0];
  const keys = arr(d.series).map(String).filter(Boolean);
  const seriesKeys = keys.length ? keys : Object.keys(rows[0]).filter((k) => k !== x && typeof rows[0][k] === "number");
  if (seriesKeys.length === 0) return null;
  const t = String(d.chartType ?? "bar");
  const variant: PdfChartVariant = t === "line" ? "line" : t === "area" ? "area" : t === "pie" ? "pie" : t === "donut" ? "donut" : "bar";
  return {
    type: "chart",
    variant,
    title: str(d.title) || undefined,
    categories: rows.map((r) => cellText(r[x])),
    series: seriesKeys.map((k) => ({ name: k, data: rows.map((r) => toNumber(r[k])) })),
    unit: typeof d.unit === "string" ? d.unit : undefined,
  };
}

function artifactBlock(type: string, d: Data): PdfBlock[] {
  switch (type) {
    case "header": {
      const text = str(d.text);
      const level = Number(d.level) || 2;
      return text ? [{ type: "heading", text, level: level <= 1 ? 1 : level === 2 ? 2 : 3 }] : [];
    }
    case "paragraph": {
      const text = str(d.text);
      return text ? [{ type: "paragraph", text }] : [];
    }
    case "list": {
      const items = listItems(d.items);
      return items.length ? [{ type: "list", ordered: d.style === "ordered", items }] : [];
    }
    case "checklist": {
      const items = arr(d.items).map(obj).map((i) => ({ text: str(i.text), checked: !!i.checked })).filter((i) => i.text);
      return items.length ? [{ type: "checklist", items }] : [];
    }
    case "table": {
      const t = tableBlock(d);
      return t ? [t] : [];
    }
    case "quote": {
      const text = str(d.text);
      return text ? [{ type: "quote", text, caption: str(d.caption) || undefined }] : [];
    }
    case "code":
      return d.code ? [{ type: "code", code: String(d.code) }] : [];
    case "raw":
      return d.html ? [{ type: "code", code: String(d.html) }] : [];
    case "delimiter":
      return [{ type: "divider" }];
    case "warning": {
      const text = str(d.message);
      return text || d.title ? [{ type: "callout", tone: "warning", title: str(d.title) || undefined, text }] : [];
    }
    case "callout": {
      const text = str(d.text);
      return text ? [{ type: "callout", tone: toneOf(d.tone), text }] : [];
    }
    case "image": {
      const src = String(obj(d.file).url ?? d.url ?? "");
      return src ? [{ type: "image", src, caption: str(d.caption) || undefined }] : [];
    }
    case "embed": {
      const src = String(d.source ?? d.embed ?? "");
      return src ? [{ type: "sources", items: [{ name: str(d.caption) || String(d.service ?? "Lien"), url: src }] }] : [];
    }
    case "kpi": {
      const items: PdfKpi[] = arr(d.items).map(obj).map((k) => ({
        label: str(k.label),
        value: str(k.value),
        delta: str(k.delta) || undefined,
        trend: k.trend === "up" || k.trend === "down" || k.trend === "flat" ? (k.trend as PdfKpi["trend"]) : undefined,
      })).filter((k) => k.label || k.value);
      return items.length ? [{ type: "kpis", items }] : [];
    }
    case "chart": {
      const c = artifactChart(d);
      return c ? [c] : [];
    }
    case "comparison": {
      const columns = arr(d.columns).map(cellText);
      const rows = arr(d.rows).map(obj).map((r) => [
        str(r.label) + (r.note ? ` (${str(r.note)})` : ""),
        ...columns.map((_, i) => cellText(arr(r.cells)[i])),
      ]);
      const out: PdfBlock[] = [];
      if (d.title) out.push({ type: "heading", text: str(d.title), level: 3 });
      if (rows.length) out.push({ type: "table", columns: ["", ...columns], rows });
      return out;
    }
    case "matrix": {
      // A 2×2 map has no PDF equivalent that keeps its reading; its positions
      // are kept as a table, which keeps its information.
      const items = arr(d.items).map(obj);
      if (items.length === 0) return [];
      const out: PdfBlock[] = [];
      if (d.title) out.push({ type: "heading", text: str(d.title), level: 3 });
      out.push({
        type: "table",
        columns: ["", str(d.xLabel) || "X", str(d.yLabel) || "Y", "Note"],
        rows: items.map((i) => [str(i.label), String(Math.round(toNumber(i.x))), String(Math.round(toNumber(i.y))), str(i.note)]),
      });
      return out;
    }
    case "banner": {
      const out: PdfBlock[] = [];
      if (d.title) out.push({ type: "heading", text: str(d.title), level: 1 });
      if (d.subtitle) out.push({ type: "paragraph", text: str(d.subtitle), lead: true });
      return out;
    }
    case "slide": {
      // A deck printed as a document: each slide starts a page, its title on top.
      const title = str(d.title);
      return title ? [{ type: "pageBreak" }, { type: "heading", text: title, level: 1 }] : [{ type: "pageBreak" }];
    }
    default:
      return [];
  }
}

export function pdfFromArtifact(doc: ArtifactDocument, meta: { title: string; subtitle?: string; eyebrow?: string; deck?: boolean }): PdfDoc {
  let blocks = doc.blocks.flatMap((b) => artifactBlock(b.type, obj(b.data)));
  // Neither a leading break nor two in a row prints anything but a blank page.
  blocks = blocks.filter((b, i) => b.type !== "pageBreak" || (i > 0 && blocks[i - 1].type !== "pageBreak"));
  return {
    title: meta.title,
    subtitle: meta.subtitle,
    eyebrow: meta.eyebrow ?? (meta.deck ? "Présentation" : "Rapport"),
    meta: [{ label: "Exporté le", value: new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) }],
    blocks,
  };
}

// ── Le Rédacteur's reports ─────────────────────────────────────────────────

export interface ReportArtisanDoc {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  footer?: string;
  meta?: Record<string, string>;
  heroBanner?: Data;
  sources?: Array<{ name: string; url?: string }>;
  blocks?: Array<{ type: string; data: Data }>;
}

function reportChart(d: Data): PdfBlock | null {
  const type = String(d.type ?? "bar");
  const suffix = obj(d.valueFormat).suffix;
  const unit = typeof suffix === "string" ? suffix : undefined;
  const common = { title: str(d.title) || undefined, subtitle: str(d.subtitle) || undefined, caption: str(d.caption) || undefined, unit };
  if (type === "donut") {
    const items = arr(d.items).map(obj);
    if (items.length === 0) return null;
    return {
      type: "chart", variant: "donut", ...common,
      categories: items.map((i) => str(i.name)),
      series: [{ name: common.title ?? "", data: items.map((i) => toNumber(i.value)) }],
    };
  }
  const categories = arr(d.categories).map(cellText);
  const series = arr(d.series).map(obj).map((s) => ({ name: str(s.name), data: arr(s.data).map(toNumber) }));
  if (categories.length === 0 || series.length === 0) return null;
  const variant: PdfChartVariant = type === "hbar" ? "horizontal-bar" : type === "line" ? "line" : type === "area" ? "area" : "bar";
  return { type: "chart", variant, ...common, categories, series };
}

function reportKpi(k: Data): PdfKpi {
  const unit = k.unit ? String(k.unit) : "";
  const delta = k.deltaLabel
    ? str(k.deltaLabel)
    : typeof k.delta === "number"
      ? `${k.delta > 0 ? "+" : ""}${k.delta.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`
      : undefined;
  const direction = k.direction === "up" || k.direction === "down" || k.direction === "flat"
    ? k.direction
    : typeof k.delta === "number" ? (k.delta > 0 ? "up" : k.delta < 0 ? "down" : "flat") : undefined;
  return {
    label: str(k.label),
    value: `${str(k.value)}${unit ? (unit === "%" ? " %" : ` ${unit}`) : ""}`,
    delta: delta ? [delta, k.deltaNote ? str(k.deltaNote) : ""].filter(Boolean).join(" ") : undefined,
    trend: direction,
    good: typeof k.good === "boolean" ? k.good : undefined,
    note: str(k.note) || undefined,
  };
}

function reportBlock(type: string, d: Data, sources: Map<string, string | undefined>): PdfBlock[] {
  switch (type) {
    case "lead": {
      const text = str(d.text);
      return text ? [{ type: "paragraph", text, lead: true }] : [];
    }
    case "kpis": {
      const items = arr(d.items).map(obj).map(reportKpi).filter((k) => k.label || k.value);
      // Tiles go four to a row; a fifth starts a new one instead of being cut.
      const rows: PdfBlock[] = [];
      for (let i = 0; i < items.length; i += 4) rows.push({ type: "kpis", items: items.slice(i, i + 4) });
      return rows;
    }
    case "chart": {
      const c = reportChart(d);
      return c ? [c] : [];
    }
    case "callout": {
      const text = str(d.text);
      return text ? [{ type: "callout", tone: toneOf(d.tone), title: str(d.title) || undefined, text }] : [];
    }
    case "figure": {
      const src = typeof d.src === "string" ? d.src : "";
      if (src) return [{ type: "image", src, caption: str(d.caption) || undefined }];
      return d.alt ? [{ type: "callout", tone: "info", text: `Illustration : ${str(d.alt)}` }] : [];
    }
    case "sources": {
      const items = arr(d.items).map((it) => {
        if (typeof it === "string") return { name: it, url: sources.get(it) };
        const o = obj(it);
        return { name: str(o.name), url: typeof o.url === "string" ? o.url : sources.get(str(o.name)) };
      }).filter((s) => s.name);
      return items.length ? [{ type: "sources", items }] : [];
    }
    case "banner": {
      const out: PdfBlock[] = [];
      if (d.eyebrow || d.title) out.push({ type: "heading", text: str(d.title || d.eyebrow), level: 1 });
      if (d.subtitle) out.push({ type: "paragraph", text: str(d.subtitle), lead: true });
      return out;
    }
    default:
      // paragraph, header, list, checklist, table, quote, delimiter: same shapes
      // as the artifact format.
      return artifactBlock(type, d);
  }
}

export function pdfFromReportArtisan(doc: ReportArtisanDoc, fallbackTitle: string): PdfDoc {
  const sources = new Map((doc.sources ?? []).map((s) => [s.name, s.url] as const));
  const hero = obj(doc.heroBanner);
  const blocks: PdfBlock[] = [];
  // The banner carries the report's conclusion (the title only names it), so it
  // opens the body rather than being lost with the artwork.
  if (hero.title) blocks.push({ type: "callout", tone: "info", title: str(hero.title), text: str(hero.subtitle) });
  blocks.push(...(doc.blocks ?? []).flatMap((b) => reportBlock(String(b?.type ?? ""), obj(b?.data), sources)));
  return {
    title: str(doc.title) || fallbackTitle,
    subtitle: str(doc.subtitle) || undefined,
    eyebrow: str(doc.eyebrow) || "Rapport",
    meta: Object.entries(doc.meta ?? {}).map(([label, value]) => ({ label, value: str(value) })),
    footer: str(doc.footer) || undefined,
    blocks,
  };
}
