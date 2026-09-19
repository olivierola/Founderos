import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  MinusIcon as Minus,
} from "@phosphor-icons/react";
import { formatCompact } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { iconByName } from "../crmIcons";
import type { CrmProperty } from "../objectModel";
import { useCategorical, useDeltaColors, foldToSlots } from "./vizPalette";
import type { DistItem, MetricDef, MetricKey, ObjectStat } from "./crmStats";

// ─────────────────────────────────────────────────────────────── delta

/** Signed delta vs a named period. Colour = direction × whether up is good. */
export function Delta({ pct, upIsGood = true, period = "période préc." }: { pct: number | null; upIsGood?: boolean; period?: string }) {
  const c = useDeltaColors();
  if (pct == null) {
    return <span className="text-xs text-muted-foreground">— vs {period}</span>;
  }
  const flat = Math.abs(pct) < 0.05;
  const good = pct > 0 === upIsGood;
  const Icon = flat ? Minus : pct > 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <Icon className="h-3 w-3 shrink-0" style={{ color: flat ? undefined : good ? c.good : c.bad }} />
      <span style={{ color: flat ? undefined : good ? c.good : c.bad, fontVariantNumeric: "tabular-nums" }}>
        {pct > 0 ? "+" : ""}
        {pct.toFixed(1)}%
      </span>
      <span className="text-muted-foreground">vs {period}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────── KPI row

export interface KpiTile {
  def: MetricDef;
  value: number;
  delta: number | null;
}

/**
 * The KPI row under the trend plot. Tiles are the chart's metric selector — the
 * active one is marked by a top rule + a filled icon tile (not colour alone).
 */
export function KpiRow({
  tiles,
  active,
  onSelect,
}: {
  tiles: KpiTile[];
  active: MetricKey;
  onSelect: (k: MetricKey) => void;
}) {
  return (
    <div className="grid grid-cols-2 border-t border-border lg:grid-cols-4">
      {tiles.map((t, i) => {
        const isActive = t.def.key === active;
        return (
          <button
            key={t.def.key}
            onClick={() => onSelect(t.def.key)}
            aria-pressed={isActive}
            className={cn(
              "flex flex-col items-start gap-2 border-t-2 px-5 py-4 text-left transition-colors",
              i > 0 && "lg:border-l lg:border-l-border",
              isActive ? "border-t-foreground bg-secondary/40" : "border-t-transparent hover:bg-secondary/30",
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  isActive ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
                )}
              >
                <t.def.icon className="h-3.5 w-3.5" />
              </span>
              <span className="text-sm text-muted-foreground">{t.def.label}</span>
            </span>
            {/* Proportional figures — tabular-nums makes a big number look loose. */}
            <span className="text-2xl font-semibold tracking-tight text-foreground">
              {formatCompact(t.value)}
              {t.def.unit ?? ""}
            </span>
            <Delta pct={t.delta} upIsGood={t.def.upIsGood} />
          </button>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────── property breakdown

/**
 * Part-to-whole of the observed property's values: a segmented bar (categorical
 * slots, in fixed order, 2px surface gaps) plus a labelled row per segment.
 *
 * Those rows are not decoration — three light-mode slots sit below 3:1 contrast,
 * and the documented relief for that is exactly this: every segment is also
 * direct-labelled, so no value is ever carried by the fill alone.
 */
export function PropertyBreakdown({
  property,
  items,
  total,
}: {
  property: CrmProperty | null;
  items: DistItem[];
  total: number;
}) {
  const palette = useCategorical();
  const folded = foldToSlots(items);
  const sum = folded.reduce((s, i) => s + i.count, 0);

  if (!property || sum === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {property ? "Aucune valeur sur la période." : "Choisissez une propriété à observer."}
      </p>
    );
  }

  const top = folded.reduce((a, b) => (b.count > a.count ? b : a), folded[0]);

  return (
    <div>
      {/* Hero: the share held by the dominant value. */}
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight text-foreground">
          {Math.round((top.count / sum) * 100)}%
        </span>
        <span className="truncate text-sm text-muted-foreground">{top.label}</span>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {formatCompact(total)} enregistrement{total > 1 ? "s" : ""} · {property.label}
      </p>

      {/* Segmented bar — 2px surface gaps do the separating, no strokes. */}
      <div className="mb-3 flex h-2.5 w-full gap-[2px] overflow-hidden">
        {folded.map((it, i) => (
          <div
            key={it.label}
            className="h-full rounded-[2px]"
            style={{ width: `${(it.count / sum) * 100}%`, background: palette[i % palette.length] }}
            title={`${it.label}: ${it.count}`}
          />
        ))}
      </div>

      {/* Legend + direct labels (the contrast relief channel + the table view). */}
      <ul className="divide-y divide-border/60">
        {folded.map((it, i) => (
          <li key={it.label} className="flex items-center gap-2.5 py-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ background: palette[i % palette.length] }}
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{it.label}</span>
            <span className="shrink-0 text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
              {it.count}
            </span>
            <span
              className="w-12 shrink-0 text-right font-medium text-foreground"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {Math.round((it.count / sum) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ──────────────────────────────────────────────────────── objects card

/** Every CRM object with its volume + growth. Bars are one hue (slot 1 is not
 *  needed here): these are nominal names, so length carries the magnitude and
 *  colour would only re-encode it. */
export function ObjectsBreakdown({
  stats,
  activeObjectId,
  onSelect,
}: {
  stats: ObjectStat[];
  activeObjectId: string | null;
  onSelect: (id: string) => void;
}) {
  const max = Math.max(1, ...stats.map((s) => s.total));

  if (stats.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucun objet CRM.</p>;
  }

  return (
    <ul className="space-y-1">
      {stats.map((s) => {
        const Icon = iconByName(s.object.icon);
        const isActive = s.object.id === activeObjectId;
        return (
          <li key={s.object.id}>
            <button
              onClick={() => onSelect(s.object.id)}
              className={cn(
                "w-full rounded-lg px-2 py-2 text-left transition-colors",
                isActive ? "bg-secondary" : "hover:bg-secondary/50",
              )}
            >
              <div className="flex items-center gap-2.5">
                <Icon className={cn("h-4 w-4 shrink-0", s.object.color || "text-muted-foreground")} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {s.object.label_plural || s.object.label}
                </span>
                <span
                  className="shrink-0 text-sm font-medium text-foreground"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatCompact(s.total)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2 pl-[26px]">
                <div className="h-1.5 flex-1 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(s.total / max) * 100}%`, background: "hsl(var(--primary))" }}
                  />
                </div>
                <Delta pct={s.delta} />
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
