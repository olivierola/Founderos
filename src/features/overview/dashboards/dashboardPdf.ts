/**
 * A dashboard as a vector PDF document.
 *
 * The figures are the ones ON SCREEN: rows are read from the react-query cache
 * each WidgetView filled (same key, so same filters and refresh), and computed
 * with the same helpers (widgetData.ts). Nothing is fetched again — an export
 * that queried afresh could print a number the user never saw.
 *
 * Module widgets render a whole module component with data of their own; there
 * is nothing to read back from them, so they are listed as left out instead of
 * silently missing.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { PdfBlock, PdfDoc } from "@/lib/pdf/types";
import { cellText, markdownToText, toNumber } from "@/lib/pdf/text";
import type { Widget } from "./types";
import { formatWidgetValue, widgetChartKeys, widgetKpi } from "./widgetData";

type Row = Record<string, unknown>;

export interface DashboardPdfResult { doc: PdfDoc; skipped: string[] }

/** The freshest rows cached for a widget, whatever its filters were. */
function cachedRows(qc: QueryClient, widgetId: string): Row[] | undefined {
  const hits = qc.getQueryCache().findAll({ queryKey: ["widget-data", widgetId] })
    .filter((q) => Array.isArray(q.state.data))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  return hits[0]?.state.data as Row[] | undefined;
}

const MAX_TABLE_ROWS = 60;

export function buildDashboardPdf(
  qc: QueryClient,
  dashboard: { name?: string | null; description?: string | null },
  widgets: Widget[],
  filter?: { column: string; value: string } | null,
): DashboardPdfResult {
  // Reading order = the grid's: top to bottom, then left to right.
  const ordered = [...widgets].sort((a, b) =>
    (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0));
  const blocks: PdfBlock[] = [];
  const skipped: string[] = [];
  const label = (w: Widget) => w.title || w.type;
  let kpiRowY: number | null = null;

  for (const w of ordered) {
    const cfg = w.config ?? {};
    if (w.type === "module") { skipped.push(label(w)); continue; }
    if (w.type === "markdown") {
      const text = (cfg.text ?? "").trim();
      if (!text) continue;
      if (cfg.headingLevel) blocks.push({ type: "heading", text, level: cfg.headingLevel <= 2 ? 2 : 3 });
      else {
        if (w.title) blocks.push({ type: "heading", text: w.title, level: 3 });
        for (const para of markdownToText(text).split(/\n{2,}/)) if (para.trim()) blocks.push({ type: "paragraph", text: para.trim() });
      }
      continue;
    }
    const rows = cachedRows(qc, w.id);
    if (!rows) { skipped.push(`${label(w)} (données non chargées)`); continue; }

    if (w.type === "kpi") {
      const { value, delta } = widgetKpi(rows, cfg);
      const item = {
        label: label(w),
        value: formatWidgetValue(value, cfg),
        delta: delta === null ? undefined : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} % vs période préc.`,
        trend: delta === null ? undefined : delta > 0 ? "up" as const : delta < 0 ? "down" as const : "flat" as const,
      };
      // KPI widgets side by side on the grid share one row of tiles, four at most.
      const y = w.position?.y ?? 0;
      const last = blocks[blocks.length - 1];
      if (last?.type === "kpis" && last.items.length < 4 && kpiRowY === y) last.items.push(item);
      else blocks.push({ type: "kpis", items: [item] });
      kpiRowY = y;
      continue;
    }

    if (rows.length === 0) { skipped.push(`${label(w)} (aucune donnée)`); continue; }

    if (w.type === "table") {
      const cols = Object.keys(rows[0]);
      blocks.push({ type: "heading", text: label(w), level: 3 });
      blocks.push({
        type: "table",
        columns: cols,
        rows: rows.slice(0, MAX_TABLE_ROWS).map((r) => cols.map((c) => cellText(r[c]).slice(0, 80))),
        caption: rows.length > MAX_TABLE_ROWS ? `${MAX_TABLE_ROWS} premières lignes sur ${rows.length}.` : undefined,
      });
      continue;
    }

    const { xKey, yKey } = widgetChartKeys(rows, cfg);
    const variant = w.type === "pie" ? "pie" : w.type === "line" ? "line" : w.type === "area" ? "area" : "bar";
    blocks.push({
      type: "chart",
      variant,
      title: label(w),
      categories: rows.map((r) => {
        const v = r[xKey];
        // Time buckets arrive as ISO timestamps; a day is all a chart axis needs.
        return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : cellText(v);
      }),
      series: [{ name: yKey, data: rows.map((r) => toNumber(r[yKey])) }],
    });
  }

  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  return {
    doc: {
      title: dashboard.name || "Dashboard",
      subtitle: dashboard.description || undefined,
      eyebrow: "Dashboard",
      meta: [
        { label: "Exporté le", value: today },
        { label: "Widgets", value: String(widgets.length) },
        ...(filter ? [{ label: "Filtre", value: `${filter.column} = ${filter.value}` }] : []),
      ],
      footer: dashboard.name ? `${dashboard.name} · ${today}` : undefined,
      blocks,
    },
    skipped,
  };
}
