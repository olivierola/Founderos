import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bucket } from "./crmStats";
import { useContextGreys } from "./vizPalette";

const GAP = 2; // the surface gap — white does the separating, never a stroke
const Y_GUTTER = 44;
const X_BAND = 22;
// The topmost tick sits exactly on the top row's edge — without this pad its
// label is half-clipped by the svg box.
const TOP_PAD = 8;
// A waffle square is a small mark; cap it so a wide card doesn't make thick
// saturated blocks. ~28px matches the reference density.
const MAX_CELL = 28;
const MIN_ROWS = 4;
const MAX_ROWS = 14;

/** Measures the plot box. The svg is absolutely positioned inside it, so it can
 *  never feed its own size back in (which would loop the observer). */
function useBox<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setBox({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/**
 * Value one square is worth: the SMALLEST round step that lets the whole series
 * fit in `targetRows` squares (so the axis stays as tight as a round step allows).
 *
 * `integral` matters: record counts can't be split, so a square must be a whole
 * number — otherwise the axis reads "0.8 / 1.6 / 2.4 enregistrements", which is
 * nonsense. Integral steps stay on 1/2/3/4/5 × 10ⁿ (never below 1); rates may
 * also use 2.5 and go under 1.
 */
function pickQuantum(v: number, targetRows: number, integral: boolean): number {
  const bases = integral ? [1, 2, 3, 4, 5] : [1, 2, 2.5, 5];
  const startExp = integral ? 0 : Math.floor(Math.log10(Math.max(v, 1e-6) / targetRows)) - 1;
  for (let e = startExp; e <= 12; e++) {
    for (const b of bases) {
      const q = b * Math.pow(10, e);
      if (integral && (!Number.isInteger(q) || q < 1)) continue;
      if (Math.ceil(v / q) <= targetRows) return q;
    }
  }
  return integral ? Math.ceil(v / targetRows) : v / targetRows;
}

/** Ticks are always r × quantum, so integral data yields integral labels. */
function fmtTick(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(v < 1 ? 2 : 1);
}

interface Props {
  buckets: Bucket[];
  /** Current-period series — the accent (the point of the chart). */
  current: number[];
  /** Comparison series rendered as de-emphasised context; null = compare off. */
  previous?: number[] | null;
  currentLabel?: string;
  previousLabel?: string;
  /** Appended to values in the tooltip / y-axis (e.g. "%"). */
  suffix?: string;
}

/**
 * Dot-matrix (waffle) column chart: one column per time bucket, each column's
 * height quantised into squares. This is an EMPHASIS form — the current period
 * wears the brand accent, the comparison period recedes to grey — so the reader's
 * eye lands on "now" while still seeing the baseline.
 *
 * The accent is --primary (validated ≥3:1 as a mark on both the light #ffffff
 * and dark #1e1d1c card surfaces).
 *
 * Geometry is bounded by the measured box in BOTH axes: deriving the row height
 * from the width alone made the column taller than its card and dropped the
 * month labels on top of the KPI row.
 */
export function WaffleTrend({
  buckets,
  current,
  previous = null,
  currentLabel = "Période actuelle",
  previousLabel = "Période précédente",
  suffix = "",
}: Props) {
  const [ref, box] = useBox<HTMLDivElement>();
  const greys = useContextGreys();
  const [hover, setHover] = useState<number | null>(null);

  const cols = buckets.length;

  const geom = useMemo(() => {
    const all = [...current, ...(previous ?? [])];
    const v = Math.max(1, ...all);
    const integral = all.every((n) => Number.isInteger(n));

    const plotW = Math.max(0, box.w - Y_GUTTER);
    const budgetH = Math.max(0, box.h - TOP_PAD - X_BAND);
    if (cols === 0 || plotW <= 0 || budgetH <= 0) return null;

    const cellFromW = Math.min(MAX_CELL, (plotW - GAP * (cols - 1)) / cols);
    if (cellFromW < 1) return null;

    // Rows come from the HEIGHT the box actually has — deriving them from the
    // value scale is what made the column overflow its card. The grid then fills
    // the plot (empty squares ARE the plot area) and the quantum adapts to it.
    const rows = Math.max(
      MIN_ROWS,
      Math.min(MAX_ROWS, Math.floor((budgetH + GAP) / (cellFromW + GAP))),
    );
    const quantum = pickQuantum(v, rows, integral);
    // Final safety: never exceed the height budget.
    const cell = Math.min(cellFromW, (budgetH - GAP * (rows - 1)) / rows);
    const plotH = rows * cell + GAP * (rows - 1);
    // Anchor the grid to the bottom of the box — a chart grows off its baseline.
    const bottom = TOP_PAD + budgetH;
    return { quantum, rows, cell, plotH, bottom, integral };
  }, [current, previous, box.w, box.h, cols]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Legend — mandatory with two series; identity never rests on color alone. */}
      {previous && (
        <div className="mb-2 flex shrink-0 items-center gap-4">
          <LegendKey color="hsl(var(--primary))" label={currentLabel} />
          <LegendKey color={greys.context} label={previousLabel} />
        </div>
      )}

      <div ref={ref} className="relative min-h-0 w-full flex-1">
        {geom && (
          <svg
            className="absolute inset-0"
            width={box.w}
            height={box.h}
            role="img"
            aria-label="Tendance par période"
          >
            {(() => {
              const { quantum, rows, cell, bottom } = geom;
              const rowTopY = (r: number) => bottom - r * cell - Math.max(0, r - 1) * GAP;
              // Ticks every k rows → always whole squares, so labels are clean
              // numbers AND land on a square boundary.
              const k = Math.max(1, Math.round(rows / 4));
              const ticks: number[] = [];
              for (let r = k; r <= rows; r += k) ticks.push(r);
              const filled = (v: number) => Math.min(rows, Math.round(Math.max(0, v) / quantum));

              return (
                <>
                  {ticks.map((r) => (
                    <text
                      key={r}
                      x={Y_GUTTER - 10}
                      y={rowTopY(r)}
                      textAnchor="end"
                      dominantBaseline="middle"
                      className="fill-muted-foreground"
                      style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                    >
                      {fmtTick(r * quantum)}
                      {suffix}
                    </text>
                  ))}

                  {buckets.map((b, i) => {
                    const x = Y_GUTTER + i * (cell + GAP);
                    const fc = filled(current[i] ?? 0);
                    const fp = previous ? filled(previous[i] ?? 0) : 0;
                    return (
                      <g key={b.start}>
                        {Array.from({ length: rows }).map((_, r) => {
                          const y = bottom - (r + 1) * cell - r * GAP;
                          const fill =
                            r < fc ? "hsl(var(--primary))" : r < fp ? greys.context : greys.empty;
                          // No dim-on-hover: washing the other columns out
                          // destroys the read for a cue the tooltip already gives.
                          return (
                            <rect
                              key={r}
                              x={x}
                              y={y}
                              width={cell}
                              height={cell}
                              rx={Math.min(2, cell / 4)}
                              fill={fill}
                            />
                          );
                        })}
                        {/* Hit target = the whole column, so it clears the ~24px
                            minimum even though a cell is smaller. */}
                        <rect
                          x={x - GAP / 2}
                          y={0}
                          width={cell + GAP}
                          height={bottom}
                          fill="transparent"
                          onMouseEnter={() => setHover(i)}
                          onMouseLeave={() => setHover(null)}
                        />
                        {b.tick && (
                          <text
                            x={x + cell / 2}
                            y={bottom + 15}
                            textAnchor="start"
                            className="fill-muted-foreground"
                            style={{ fontSize: 11 }}
                          >
                            {b.tick}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </>
              );
            })()}
          </svg>
        )}

        {geom && hover != null && buckets[hover] && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
            style={{
              left: Math.min(
                Math.max(Y_GUTTER + hover * (geom.cell + GAP) - 60, 0),
                Math.max(0, box.w - 160),
              ),
              top: 0,
            }}
          >
            <div className="font-medium text-foreground">{buckets[hover].full}</div>
            <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: "hsl(var(--primary))" }} />
              {currentLabel}
              <span className="font-medium text-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                {current[hover] ?? 0}
                {suffix}
              </span>
            </div>
            {previous && (
              <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: greys.context }} />
                {previousLabel}
                <span className="font-medium text-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {previous[hover] ?? 0}
                  {suffix}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}
