/**
 * What a widget shows, computed from its rows — shared by the widget on screen
 * (WidgetView) and the PDF export (dashboardPdf), so the two can never disagree
 * on a figure.
 */
import { formatCurrency } from "@/lib/utils";
import type { Widget } from "./types";

type Row = Record<string, unknown>;

export function applyFormula(value: number, formula?: string): number {
  if (!formula) return value;
  try {
    // very small safe evaluator: only `value`, numbers and + - * / ( )
    if (!/^[\d\s+\-*/().value]+$/.test(formula)) return value;
    // eslint-disable-next-line no-new-func
    const fn = new Function("value", `return (${formula});`);
    const r = fn(value);
    return typeof r === "number" && isFinite(r) ? r : value;
  } catch {
    return value;
  }
}

export function formatWidgetValue(value: number, cfg: Widget["config"]): string {
  const v = applyFormula(value, cfg.formula);
  if (cfg.format === "currency") return formatCurrency(v, "EUR");
  if (cfg.format === "percent") return `${(v * 100).toFixed(1)}%`;
  const s = Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  return `${cfg.prefix ?? ""}${s}${cfg.suffix ?? ""}`;
}

/** The KPI figure and, when asked for, its move against the previous point. */
export function widgetKpi(rows: Row[], cfg: Widget["config"]): { value: number; delta: number | null } {
  const first = rows[0] as Row | undefined;
  const value = Number(first?.value ?? (first ? Object.values(first)[0] : 0) ?? 0);
  // Delta: compare last vs previous point of a time series (when available)
  let delta: number | null = null;
  if (cfg.showDelta && rows.length >= 2 && "value" in rows[rows.length - 1]) {
    const last = Number(rows[rows.length - 1].value ?? 0);
    const prev = Number(rows[rows.length - 2].value ?? 0);
    if (prev !== 0) delta = ((last - prev) / Math.abs(prev)) * 100;
  }
  // For metrics series, the KPI value should be the latest point, not the first.
  const kpiValue =
    cfg.source?.kind === "metrics" && rows.length > 0
      ? Number(rows[rows.length - 1].value ?? 0)
      : value;
  return { value: kpiValue, delta };
}

/** Which column is the category axis and which the value, for a chart widget. */
export function widgetChartKeys(rows: Row[], cfg: Widget["config"]): { xKey: string; yKey: string } {
  const first = rows[0];
  const xKey = cfg.xKey ?? (first && ("date" in first ? "date" : "label" in first ? "label" : Object.keys(first)[0]!)) ?? "label";
  const yKey = cfg.yKey ?? (first && "value" in first ? "value" : Object.keys(first ?? {})[1] ?? "value");
  return { xKey, yKey };
}
