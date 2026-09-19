// Shared chart & card primitives for the AI HQ cockpit (and the per-service
// dashboard tab, which renders the exact same components on a narrower scope).
//
// Colour rules enforced here, once, so no consumer has to remember them:
//  · series identity  → the validated categorical slots, IN ORDER, never cycled
//    (a 9th category folds into "Autres" via foldToSlots).
//  · run state        → the reserved STATUS scale, always with a legend/label.
//  · magnitude        → ONE hue, light→dark (the heat grid).
//  · deltas           → the validated text-contrast delta colours.
// Numbers and labels always wear text tokens; the colour lives in the mark.
import { useId, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";
import {
  XIcon as X,
  ArrowsOutSimpleIcon as Maximize2,
  TrendUpIcon as TrendingUp,
  TrendDownIcon as TrendingDown,
  MinusIcon as Minus,
  type Icon as LucideIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatisticsCard7 } from "@/components/ui/statistics-card-7";
import {
  useCategorical, useDeltaColors, useContextGreys, STATUS,
} from "@/features/crm/overview/vizPalette";
import { RANGES, type RangeKey } from "../hqStats";

// ───────────────────────────────────────────────────────────────── palette

/** Every colour the HQ charts are allowed to use, resolved for the theme. */
export function useHqPalette() {
  const cat = useCategorical();
  const delta = useDeltaColors();
  const greys = useContextGreys();
  return {
    cat,
    delta,
    greys,
    status: STATUS,
    /** Accent for a KPI tile — a categorical slot, so tiles and charts agree. */
    slot: (i: number) => cat[Math.min(i, cat.length - 1)],
  };
}

export const chartAxis = {
  tick: { fontSize: 11, fill: "hsl(var(--muted-foreground))" },
  stroke: "hsl(var(--border))",
  tickLine: false,
  axisLine: false,
} as const;

export const chartTooltip = {
  contentStyle: {
    background: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: 12,
    fontSize: 12,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.10)",
    color: "hsl(var(--foreground))",
  },
  labelStyle: { color: "hsl(var(--muted-foreground))", fontSize: 11, marginBottom: 2 },
  cursor: { fill: "hsl(var(--muted) / 0.4)" },
} as const;

export const fmtCompact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });

// ───────────────────────────────────────────────────────────────── chrome

export function SectionCard({ title, subtitle, icon, right, children, className, bodyClassName }: {
  title: string; subtitle?: string; icon?: ReactNode; right?: ReactNode;
  children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <Card className={cn("relative flex flex-col overflow-hidden rounded-2xl border-border/70 bg-card p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">{icon}</span>}
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
            {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </Card>
  );
}

export function Empty({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex h-24 items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-xs text-muted-foreground", className)}>
      {label}
    </div>
  );
}

export function LegendDot({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      {label}
      {value != null && <span className="font-medium tabular-nums text-foreground">{value}</span>}
    </span>
  );
}

/** Legend row for a chart with ≥ 2 series — identity is never colour-alone. */
export function Legend({ items }: { items: { color: string; label: string; value?: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => <LegendDot key={i.label} {...i} />)}
    </div>
  );
}

export function Pill({ children, tone = "muted", className }: {
  children: ReactNode; tone?: "muted" | "good" | "warn" | "bad" | "accent"; className?: string;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bad: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    accent: "bg-primary/10 text-primary",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium", tones[tone], className)}>{children}</span>;
}

// ───────────────────────────────────────────────────────────────── sparkline

/** Animated draw-in sparkline. Decorative scale (no axis) — always paired with
 *  the tile's own value, never read on its own. */
export function Sparkline({ data, width = 300, height = 40, strokeWidth = 1.8, color, className }: {
  data: number[]; width?: number; height?: number; strokeWidth?: number; color: string; className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min === 0 ? 1 : max - min;
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d - min) / range) * (height - strokeWidth * 2) + strokeWidth;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(" L")}`;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("h-full w-full", className)} aria-hidden="true">
      <defs>
        <linearGradient id={`sg-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1, ease: "easeInOut" }} />
      <motion.path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#sg-${uid})`}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.12 }} />
    </svg>
  );
}

/** Period-over-period badge. `good` says which direction is the good one. */
export function TrendBadge({ value, good = "up", suffix = "%" }: {
  value: number | null; good?: "up" | "down" | "none"; suffix?: string;
}) {
  const colors = useDeltaColors();
  if (value == null) return null;
  const flat = value === 0;
  const positive = value > 0;
  const isGood = good === "none" ? null : good === "up" ? positive : !positive;
  const color = flat || isGood == null ? "hsl(var(--muted-foreground))" : isGood ? colors.good : colors.bad;
  const Icon = flat ? Minus : positive ? TrendingUp : TrendingDown;
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums" style={{ color }}
      title="Variation par rapport à la période précédente">
      <Icon className="h-3 w-3" />
      {positive && !flat ? "+" : ""}{value}{suffix}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── KPI tiles

export interface CurveDef {
  name: string;
  data: number[];
  labels: string[];
  fullLabels?: string[];
  fmt?: (v: number) => string;
}

export interface KpiCardDef {
  key: string;
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  accent: string;
  tone?: string;
  /** Period-over-period variation, in %. */
  delta?: number | null;
  deltaGood?: "up" | "down" | "none";
  /** " pts" when the delta is a difference of percentages, not a variation. */
  deltaSuffix?: string;
  curve?: CurveDef;
}

export function StatTile({
  label, value, sub, icon, accent, spark, tone, delta, deltaGood, deltaSuffix, onClick, expanded, hint, compact,
}: {
  label: string; value: string; sub?: ReactNode; icon: LucideIcon; accent: string;
  spark?: number[]; tone?: string; delta?: number | null; deltaGood?: "up" | "down" | "none";
  deltaSuffix?: string;
  onClick?: () => void; expanded?: boolean; hint?: boolean; compact?: boolean;
}) {
  const Icon = icon;
  const interactive = !!onClick;
  return (
    <motion.div
      whileHover={{ y: interactive ? -2 : 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 22 }}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-card shadow-sm transition-colors",
        compact ? "p-3" : "p-4",
        interactive && "cursor-pointer hover:border-border",
        expanded ? "border-primary/60 ring-2 ring-primary/20" : "border-border/70",
      )}
    >
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full opacity-[0.16] blur-2xl" style={{ background: accent }} />
      {hint && (
        <div aria-hidden className="pointer-events-none absolute right-2.5 top-2.5 rounded-md bg-muted/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <Maximize2 className="h-3 w-3" />
        </div>
      )}
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
          <div className="mt-1 flex items-baseline gap-1.5">
            <motion.p
              key={value}
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
              className={cn("truncate font-bold tabular-nums", compact ? "text-lg" : "text-2xl", tone)}
            >
              {value}
            </motion.p>
            {delta !== undefined && <TrendBadge value={delta ?? null} good={deltaGood} suffix={deltaSuffix} />}
          </div>
          {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        <div className={cn("flex shrink-0 items-center justify-center rounded-xl", compact ? "h-8 w-8" : "h-9 w-9")}
          style={{ background: `${accent}1f`, color: accent }}>
          <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </div>
      </div>
      {spark && spark.length >= 2 && (
        <div className="relative mt-3 h-10"><Sparkline data={spark} color={accent} /></div>
      )}
    </motion.div>
  );
}

/** Grid of KPI tiles; a tile carrying a curve expands full-width on click.
 *
 *  Rendered as one segmented strip rather than as floating tiles — a row of
 *  related numbers is a single instrument, and the hairlines say so. The
 *  sparkline, the delta pill and the click-to-expand curve are unchanged; only
 *  the surface they sit on is. */
export function KpiGrid({ cards, gridClass }: { cards: KpiCardDef[]; gridClass?: string }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expanded = cards.find((c) => c.key === expandedKey);

  return (
    <div className="space-y-3">
      <StatisticsCard7
        size="compact"
        columnsClassName={cn("grid-cols-2 md:grid-cols-3 xl:grid-cols-6", gridClass)}
        cards={cards.map((c) => ({
          key: c.key,
          title: c.label,
          value: c.value,
          subtext: c.sub,
          valueClassName: c.tone,
          icon: c.icon,
          accent: c.accent,
          badgeNode: c.delta !== undefined
            ? <TrendBadge value={c.delta ?? null} good={c.deltaGood} suffix={c.deltaSuffix} />
            : undefined,
          sparkline: c.curve && c.curve.data.length >= 2
            ? <Sparkline data={c.curve.data} color={c.accent} />
            : undefined,
          hint: !!c.curve,
          expanded: expandedKey === c.key,
          onClick: c.curve ? () => setExpandedKey(expandedKey === c.key ? null : c.key) : undefined,
        }))}
      />
      <AnimatePresence mode="wait">
        {expanded?.curve && (
          <motion.div key={expanded.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}>
            <CurvePanel curve={expanded.curve} accent={expanded.accent} onClose={() => setExpandedKey(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Full-width curve for the expanded metric — one series, so no legend box:
 *  the panel title names it. */
export function CurvePanel({ curve, accent, onClose }: { curve: CurveDef; accent: string; onClose: () => void }) {
  const uid = useId().replace(/:/g, "");
  const rows = curve.data.map((v, i) => ({
    label: curve.labels[i] ?? "",
    full: curve.fullLabels?.[i] ?? curve.labels[i] ?? "",
    value: v,
  }));
  const fmt = curve.fmt ?? ((v: number) => String(v));

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-md" style={{ borderColor: `${accent}55` }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{curve.name}</span>
        <button onClick={onClose} aria-label="Fermer la courbe"
          className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
            <defs>
              <linearGradient id={`cv-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.28} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
            <XAxis dataKey="label" {...chartAxis} minTickGap={24} />
            <YAxis width={48} {...chartAxis} tickFormatter={(v: number) => fmt(v)} />
            <Tooltip {...chartTooltip}
              formatter={(v) => [fmt(Number(v) || 0), curve.name]}
              labelFormatter={(_, p) => (p?.[0]?.payload as { full?: string } | undefined)?.full ?? ""} />
            <Area type="monotone" dataKey="value" name={curve.name} stroke={accent} strokeWidth={2}
              fill={`url(#cv-${uid})`} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── bar list

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** Right-hand caption (always present — the fill never carries the number). */
  caption?: string;
  color?: string;
  /** Secondary segment drawn on top of the bar (e.g. the error share). */
  overlay?: { value: number; color: string; label: string };
  onClick?: () => void;
  icon?: ReactNode;
}

/** Ranked horizontal bars. Every row is direct-labelled, so a low-contrast
 *  fill never carries meaning on its own. */
export function BarList({ rows, max, labelWidth = "w-32", emptyLabel = "Aucune donnée." }: {
  rows: BarRow[]; max?: number; labelWidth?: string; emptyLabel?: string;
}) {
  const { cat } = useHqPalette();
  const peak = Math.max(1, max ?? Math.max(...rows.map((r) => r.value), 0));
  if (rows.length === 0) return <Empty label={emptyLabel} />;
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const width = (r.value / peak) * 100;
        const overlayWidth = r.overlay ? (r.overlay.value / peak) * 100 : 0;
        const body = (
          <>
            <span className={cn("flex shrink-0 items-center gap-1.5 truncate text-xs text-muted-foreground", labelWidth)} title={r.label}>
              {r.icon}<span className="truncate">{r.label}</span>
            </span>
            <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
              <motion.span className="absolute inset-y-0 left-0 rounded-full"
                style={{ background: r.color ?? cat[0] }}
                initial={{ width: 0 }} animate={{ width: `${width}%` }} transition={{ duration: 0.5, ease: "easeOut" }} />
              {r.overlay && r.overlay.value > 0 && (
                <span className="absolute inset-y-0 left-0 rounded-full ring-2 ring-card"
                  style={{ width: `${overlayWidth}%`, background: r.overlay.color }}
                  title={`${r.overlay.label} : ${r.overlay.value}`} />
              )}
            </span>
            <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {r.caption ?? r.value}
            </span>
          </>
        );
        return r.onClick ? (
          <button key={r.key} onClick={r.onClick} className="flex w-full items-center gap-3 rounded-lg py-0.5 text-left transition-colors hover:bg-muted/40">
            {body}
          </button>
        ) : (
          <div key={r.key} className="flex items-center gap-3">{body}</div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── donut

/** Donut + direct-labelled rows. Caller folds to ≤ 8 slices before passing. */
export function Donut({ slices, total, unit, colors }: {
  slices: { label: string; value: number }[]; total: number; unit: string; colors?: string[];
}) {
  const { cat } = useHqPalette();
  const palette = colors ?? cat;
  if (total === 0) return <Empty label={`Aucun ${unit} sur la période.`} />;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative h-40 w-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="label" innerRadius={48} outerRadius={72} paddingAngle={2} stroke="hsl(var(--card))" strokeWidth={2}>
              {slices.map((s, i) => <Cell key={s.label} fill={palette[Math.min(i, palette.length - 1)]} />)}
            </Pie>
            <Tooltip {...chartTooltip} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold tabular-nums">{fmtCompact.format(total)}</span>
          <span className="text-[10px] text-muted-foreground">{unit}</span>
        </div>
      </div>
      <ul className="min-w-[150px] flex-1 space-y-1.5 text-xs">
        {slices.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: palette[Math.min(i, palette.length - 1)] }} />
            <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
            <span className="font-medium tabular-nums text-foreground">{s.value}</span>
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {Math.round((s.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── heat grid

/** Magnitude matrix — ONE hue, light→dark, with the count written in each cell
 *  so the value never depends on reading the shade. */
export function HeatGrid({ rows, cols, valueOf, rowLabel, colLabel, hue, emptyLabel }: {
  rows: { key: string; label: string; node?: ReactNode }[];
  cols: { key: string; label: string }[];
  valueOf: (rowKey: string, colKey: string) => number;
  rowLabel?: string;
  colLabel?: (key: string) => string;
  hue?: string;
  emptyLabel?: string;
}) {
  const { cat } = useHqPalette();
  const color = hue ?? cat[0];
  const peak = Math.max(1, ...rows.flatMap((r) => cols.map((c) => valueOf(r.key, c.key))));
  if (rows.length === 0 || cols.length === 0) return <Empty label={emptyLabel ?? "Aucune donnée."} />;

  return (
    <div className="scrollbar-slim overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-[11px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-1 pb-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {rowLabel ?? ""}
            </th>
            {cols.map((c) => (
              <th key={c.key} className="px-1 pb-1.5 text-[10px] font-medium text-muted-foreground" title={c.label}>
                <span className="block max-w-[74px] truncate">{colLabel?.(c.key) ?? c.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="sticky left-0 z-10 max-w-[160px] truncate bg-card pr-2 text-xs text-muted-foreground" title={r.label}>
                {r.node ?? r.label}
              </td>
              {cols.map((c) => {
                const v = valueOf(r.key, c.key);
                const intensity = v === 0 ? 0 : 0.14 + (v / peak) * 0.72;
                return (
                  <td key={c.key} className="p-0">
                    <div
                      title={`${r.label} · ${c.label} : ${v}`}
                      className={cn(
                        "flex h-8 min-w-[46px] items-center justify-center rounded-md tabular-nums transition-transform hover:scale-[1.06]",
                        v === 0 ? "text-muted-foreground/40" : "font-medium text-foreground",
                      )}
                      style={{ background: v === 0 ? "hsl(var(--muted) / 0.4)" : `color-mix(in srgb, ${color} ${Math.round(intensity * 100)}%, transparent)` }}
                    >
                      {v === 0 ? "·" : v}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── controls

export function RangePicker({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-border bg-muted/40 p-0.5">
      {RANGES.map((r) => (
        <button key={r.key} onClick={() => onChange(r.key)} aria-pressed={value === r.key}
          className={cn(
            "rounded-lg px-2.5 py-1 text-xs transition-colors",
            value === r.key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Segmented switch with an animated active pill. `layoutId` must be unique per
 *  mounted instance, or two switches animate into each other. */
export function Segmented<K extends string>({ items, value, onChange, layoutId, className }: {
  items: { key: K; label: string; icon?: LucideIcon; badge?: number }[];
  value: K; onChange: (k: K) => void; layoutId: string; className?: string;
}) {
  return (
    <div className={cn("scrollbar-slim flex w-full gap-1 overflow-x-auto rounded-2xl border border-border bg-muted/40 p-1 lg:w-fit", className)}>
      {items.map((t) => {
        const active = value === t.key;
        return (
          <button key={t.key} onClick={() => onChange(t.key)} aria-pressed={active}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}>
            {active && (
              <motion.span layoutId={layoutId} className="absolute inset-0 rounded-xl bg-card shadow-sm ring-1 ring-border"
                transition={{ type: "spring", bounce: 0.2, duration: 0.5 }} />
            )}
            {t.icon && <t.icon className="relative z-10 h-3.5 w-3.5" />}
            <span className="relative z-10 whitespace-nowrap">{t.label}</span>
            {t.badge != null && t.badge > 0 && (
              <span className="relative z-10 rounded-full bg-destructive/15 px-1.5 text-[10px] font-bold text-destructive">{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── misc

/** Success bar + value, the shape used in every per-entity table. */
export function RateBar({ value }: { value: number | null }) {
  const { status, greys } = useHqPalette();
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const color = value >= 70 ? status.good : value >= 40 ? status.warning : status.critical;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full" style={{ background: greys.empty }}>
        <span className="block h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </span>
      <span className="w-9 font-medium tabular-nums" style={{ color }}>{value}%</span>
    </span>
  );
}

export function rateTone(v: number | null): string | undefined {
  if (v == null) return undefined;
  return v >= 70 ? "text-emerald-600 dark:text-emerald-400"
    : v >= 40 ? "text-amber-600 dark:text-amber-400"
    : "text-rose-600 dark:text-rose-400";
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "à l'instant";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h`;
  return `${Math.floor(d / 86_400_000)} j`;
}
