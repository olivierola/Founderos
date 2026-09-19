// Derivations that turn raw CRM records into the overview's series & breakdowns.
// Everything is computed client-side from one records fetch so the object /
// property / range selectors re-render without new round-trips.
import {
  PlusCircleIcon as PlusCircle,
  ArrowsClockwiseIcon as RefreshCw,
  DatabaseIcon as Database,
  GaugeIcon as Gauge,
  type Icon as LucideIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import type { CrmObject, CrmProperty } from "../objectModel";

export interface OverviewRecord {
  id: string;
  object_id: string;
  created_at: string;
  updated_at: string;
  data: Record<string, unknown>;
}

export async function fetchOverviewRecords(projectId: string): Promise<OverviewRecord[]> {
  const { data } = await supabase
    .from("crm_records")
    .select("id, object_id, created_at, updated_at, data")
    .eq("project_id", projectId);
  return (data ?? []) as OverviewRecord[];
}

// ───────────────────────────────────────────────────────────── time buckets

export type RangeKey = "30d" | "90d" | "12m";

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "30d", label: "30 derniers jours" },
  { key: "90d", label: "90 derniers jours" },
  { key: "12m", label: "12 derniers mois" },
];

export interface Bucket {
  start: number;
  end: number;
  /** Tick label rendered under the column; empty for unlabelled columns. */
  tick: string;
  /** Full label used by the tooltip. */
  full: string;
}

const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Aoû", "Sep", "Oct", "Nov", "Déc"];

function dayStart(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtDay(d: Date) {
  return `${d.getDate()} ${MONTHS_FR[d.getMonth()]}`;
}

/**
 * Buckets for a range, oldest → newest. 12m uses weekly columns labelled by
 * month (so the axis reads Jan…Déc like a calendar year); 90d weekly; 30d daily.
 */
export function makeBuckets(range: RangeKey, now: Date = new Date()): Bucket[] {
  const end = dayStart(now);
  end.setDate(end.getDate() + 1); // include today
  const out: Bucket[] = [];

  if (range === "30d") {
    for (let i = 29; i >= 0; i--) {
      const s = new Date(end);
      s.setDate(s.getDate() - i - 1);
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      // Label roughly every 5th day to keep the axis readable.
      const tick = i % 5 === 0 ? fmtDay(s) : "";
      out.push({ start: +s, end: +e, tick, full: fmtDay(s) });
    }
    return out;
  }

  const weeks = range === "90d" ? 13 : 52;
  let lastMonth = -1;
  for (let i = weeks - 1; i >= 0; i--) {
    const s = new Date(end);
    s.setDate(s.getDate() - (i + 1) * 7);
    const e = new Date(s);
    e.setDate(e.getDate() + 7);
    // First column of each month carries the month tick.
    const m = s.getMonth();
    const tick = m !== lastMonth ? MONTHS_FR[m] : "";
    lastMonth = m;
    out.push({ start: +s, end: +e, tick, full: `Semaine du ${fmtDay(s)}` });
  }
  return out;
}

/** The equivalent window immediately before `buckets` (same length & shape). */
export function previousBuckets(buckets: Bucket[]): Bucket[] {
  if (buckets.length === 0) return [];
  const span = buckets[buckets.length - 1].end - buckets[0].start;
  return buckets.map((b) => ({ ...b, start: b.start - span, end: b.end - span }));
}

// ───────────────────────────────────────────────────────────── metrics

export type MetricKey = "created" | "updated" | "total" | "fill";

export interface MetricDef {
  key: MetricKey;
  label: string;
  icon: LucideIcon;
  /** Suffix appended to the tile value. */
  unit?: string;
  /** True when a rising value is the good direction. */
  upIsGood: boolean;
  /** Says exactly what is measured — shown under the plot. */
  hint: string;
}

export const METRICS: MetricDef[] = [
  { key: "created", label: "Créés", icon: PlusCircle, upIsGood: true, hint: "Enregistrements créés par période" },
  { key: "updated", label: "Mis à jour", icon: RefreshCw, upIsGood: true, hint: "Enregistrements modifiés par période" },
  { key: "total", label: "Total", icon: Database, upIsGood: true, hint: "Total cumulé en fin de période" },
  {
    key: "fill",
    label: "Complétude",
    icon: Gauge,
    unit: "%",
    upIsGood: true,
    hint: "Part des enregistrements créés sur la période dont la propriété observée est renseignée",
  },
];

function isFilled(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "boolean") return true;
  return true;
}

/**
 * The value of `metric` for each bucket.
 *  - created / updated: events whose timestamp lands in the bucket
 *  - total:  cumulative records in existence at the bucket's end (running total)
 *  - fill:   % of the records CREATED in the bucket that currently have
 *            `propKey` filled (see the tile hint — it names exactly this)
 */
export function seriesFor(
  metric: MetricKey,
  records: OverviewRecord[],
  buckets: Bucket[],
  propKey: string | null,
): number[] {
  return buckets.map((b) => {
    if (metric === "total") {
      return records.filter((r) => +new Date(r.created_at) < b.end).length;
    }
    if (metric === "updated") {
      return records.filter((r) => {
        const t = +new Date(r.updated_at);
        return t >= b.start && t < b.end;
      }).length;
    }
    const born = records.filter((r) => {
      const t = +new Date(r.created_at);
      return t >= b.start && t < b.end;
    });
    if (metric === "created") return born.length;
    // fill
    if (!propKey || born.length === 0) return 0;
    const filled = born.filter((r) => isFilled(r.data?.[propKey])).length;
    return Math.round((filled / born.length) * 100);
  });
}

/** Headline value of a metric over a whole window (not per bucket). */
export function totalFor(metric: MetricKey, series: number[]): number {
  if (series.length === 0) return 0;
  // "total" is a running total → the window's value is its last point.
  if (metric === "total") return series[series.length - 1];
  // "fill" is a rate → average the buckets that carry records.
  if (metric === "fill") {
    const nz = series.filter((v) => v > 0);
    if (nz.length === 0) return 0;
    return Math.round(nz.reduce((s, v) => s + v, 0) / nz.length);
  }
  return series.reduce((s, v) => s + v, 0);
}

/** Signed percent change vs the comparison window; null when there's no base. */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

// ───────────────────────────────────────────────────────── distributions

export interface DistItem {
  label: string;
  count: number;
}

function numericBins(values: number[]): DistItem[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ label: String(min), count: values.length }];
  const binCount = Math.min(6, values.length);
  const step = (max - min) / binCount;
  const bins: DistItem[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = min + i * step;
    const hi = i === binCount - 1 ? max : lo + step;
    const count = values.filter((v) => (i === binCount - 1 ? v >= lo && v <= hi : v >= lo && v < hi)).length;
    bins.push({ label: `${Math.round(lo)} – ${Math.round(hi)}`, count });
  }
  return bins.filter((b) => b.count > 0);
}

/**
 * Distribution of `property` across `records`, shaped by the property's type.
 * Ordered categories (select options, months, numeric bins) keep their natural
 * order — the caller must not re-sort them, since slot order carries meaning.
 */
export function distributionFor(records: OverviewRecord[], property: CrmProperty | null): DistItem[] {
  if (!property) return [];
  const key = property.key;
  const vals = records.map((r) => r.data?.[key]);

  switch (property.type) {
    case "select": {
      const counts = new Map<string, number>();
      for (const opt of property.options ?? []) counts.set(opt.value, 0);
      let empty = 0;
      for (const v of vals) {
        if (!isFilled(v)) { empty++; continue; }
        const k = String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const out = [...counts.entries()]
        .map(([value, count]) => ({
          label: (property.options ?? []).find((o) => o.value === value)?.label ?? value,
          count,
        }))
        .filter((i) => i.count > 0);
      if (empty > 0) out.push({ label: "Vide", count: empty });
      return out;
    }
    case "multi_select": {
      const counts = new Map<string, number>();
      for (const v of vals) {
        if (!Array.isArray(v)) continue;
        for (const item of v) {
          const k = String(item);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      return [...counts.entries()].map(([value, count]) => ({
        label: (property.options ?? []).find((o) => o.value === value)?.label ?? value,
        count,
      }));
    }
    case "checkbox": {
      const yes = vals.filter((v) => v === true).length;
      return [
        { label: "Coché", count: yes },
        { label: "Non coché", count: vals.length - yes },
      ].filter((i) => i.count > 0);
    }
    case "number":
    case "currency":
    case "percent":
    case "rating": {
      const nums = vals.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      return numericBins(nums);
    }
    case "date":
    case "datetime": {
      const counts = new Map<string, number>();
      for (const v of vals) {
        if (!isFilled(v)) continue;
        const d = new Date(String(v));
        if (Number.isNaN(+d)) continue;
        const k = `${MONTHS_FR[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.entries()].map(([label, count]) => ({ label, count }));
    }
    default: {
      // Free-text-ish types: the honest breakdown is filled vs empty.
      const filled = vals.filter(isFilled).length;
      return [
        { label: "Renseigné", count: filled },
        { label: "Vide", count: vals.length - filled },
      ].filter((i) => i.count > 0);
    }
  }
}

/** Properties worth offering in the "observe" picker (skips long free text). */
export function observableProperties(props: CrmProperty[]): CrmProperty[] {
  return props.filter((p) => p.type !== "long_text");
}

// ───────────────────────────────────────────────────────── per-object stats

export interface ObjectStat {
  object: CrmObject;
  total: number;
  created: number;
  createdPrev: number;
  delta: number | null;
}

export function objectStats(
  objects: CrmObject[],
  records: OverviewRecord[],
  buckets: Bucket[],
): ObjectStat[] {
  if (buckets.length === 0) return [];
  const from = buckets[0].start;
  const to = buckets[buckets.length - 1].end;
  const span = to - from;

  return objects.map((object) => {
    const mine = records.filter((r) => r.object_id === object.id);
    const created = mine.filter((r) => {
      const t = +new Date(r.created_at);
      return t >= from && t < to;
    }).length;
    const createdPrev = mine.filter((r) => {
      const t = +new Date(r.created_at);
      return t >= from - span && t < from;
    }).length;
    return {
      object,
      total: mine.length,
      created,
      createdPrev,
      delta: deltaPct(created, createdPrev),
    };
  });
}
