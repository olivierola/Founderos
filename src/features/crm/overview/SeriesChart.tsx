import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bucket } from "./crmStats";
import { niceScale, fmtAxis } from "./chartScale";
import { useContextGreys } from "./vizPalette";

const Y_GUTTER = 44;
const X_BAND = 22;
const TOP_PAD = 10;
const RIGHT_PAD = 12;
const MAX_BAR = 24; // skill: bars capped so a wide card doesn't make thick blocks

export type SeriesVariant = "bars" | "line" | "area";

function useBox<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setBox({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** Rounded-TOP-only rect path (square at the baseline — the skill's bar spec). */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

interface Props {
  variant: SeriesVariant;
  buckets: Bucket[];
  current: number[];
  previous?: number[] | null;
  currentLabel?: string;
  previousLabel?: string;
  suffix?: string;
}

/**
 * Continuous time-series view of the trend metric — line, area, or bars. The
 * current period wears the brand accent (--primary, validated ≥3:1 as a mark on
 * both card surfaces); the comparison period is always drawn as a de-emphasised
 * grey LINE regardless of the current form, so the two never fight and 52 weekly
 * buckets don't become 104 hair-thin bars.
 */
export function SeriesChart({
  variant,
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
  const accent = "hsl(var(--primary))";
  const cols = buckets.length;

  const geom = useMemo(() => {
    const all = [...current, ...(previous ?? [])];
    const maxV = Math.max(1, ...all);
    const integral = all.every((n) => Number.isInteger(n));
    const scale = niceScale(maxV, integral);

    const plotW = Math.max(0, box.w - Y_GUTTER - RIGHT_PAD);
    const plotH = Math.max(0, box.h - TOP_PAD - X_BAND);
    if (cols === 0 || plotW <= 0 || plotH <= 0) return null;

    const band = plotW / cols;
    const x0 = Y_GUTTER;
    const baseY = TOP_PAD + plotH;
    const cx = (i: number) => x0 + band * (i + 0.5);
    const y = (v: number) => TOP_PAD + plotH - (Math.max(0, v) / scale.max) * plotH;
    return { scale, plotW, plotH, band, x0, baseY, cx, y, integral };
  }, [current, previous, box.w, box.h, cols]);

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    if (!geom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left - geom.x0;
    const i = Math.round(rel / geom.band - 0.5);
    setHover(Math.max(0, Math.min(cols - 1, i)));
  }

  const linePath = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? "M" : "L"}${geom!.cx(i).toFixed(1)},${geom!.y(v).toFixed(1)}`).join(" ");

  const lastIdx = cols - 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {previous && (
        <div className="mb-2 flex shrink-0 items-center gap-4">
          <LegendKey color={accent} label={currentLabel} />
          <LegendKey color={greys.context} label={previousLabel} dashed={false} />
        </div>
      )}

      <div ref={ref} className="relative min-h-0 w-full flex-1">
        {geom && (
          <svg className="absolute inset-0" width={box.w} height={box.h} role="img" aria-label="Tendance par période">
            {/* Gridlines + y ticks — solid hairlines, text tokens. */}
            {geom.scale.ticks.map((t) => {
              const yy = geom.y(t);
              return (
                <g key={t}>
                  <line x1={Y_GUTTER} y1={yy} x2={box.w - RIGHT_PAD} y2={yy} className="stroke-border" strokeWidth={1} />
                  <text x={Y_GUTTER - 10} y={yy} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                    {fmtAxis(t, geom.integral)}{suffix}
                  </text>
                </g>
              );
            })}
            {/* Baseline */}
            <line x1={Y_GUTTER} y1={geom.baseY} x2={box.w - RIGHT_PAD} y2={geom.baseY} className="stroke-border" strokeWidth={1} />

            {/* Current period — the accent form. */}
            {variant === "bars" && current.map((v, i) => {
              const bw = Math.min(MAX_BAR, geom.band * 0.62);
              const h = geom.baseY - geom.y(v);
              if (h <= 0) return null;
              return <path key={i} d={barPath(geom.cx(i) - bw / 2, geom.y(v), bw, h, 4)} fill={accent} opacity={hover == null || hover === i ? 1 : 0.85} />;
            })}
            {variant === "area" && (
              <path
                d={`${linePath(current)} L${geom.cx(lastIdx).toFixed(1)},${geom.baseY} L${geom.cx(0).toFixed(1)},${geom.baseY} Z`}
                fill={accent}
                fillOpacity={0.1}
              />
            )}
            {(variant === "line" || variant === "area") && (
              <path d={linePath(current)} fill="none" stroke={accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            )}

            {/* Comparison period — always a recessive grey line (never dashed). */}
            {previous && <path d={linePath(previous)} fill="none" stroke={greys.context} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

            {/* Endpoint direct label (line/area) — the one value worth labelling. */}
            {(variant === "line" || variant === "area") && cols > 0 && (
              <>
                <circle cx={geom.cx(lastIdx)} cy={geom.y(current[lastIdx] ?? 0)} r={4} fill={accent} className="stroke-background" strokeWidth={2} />
                <text x={geom.cx(lastIdx)} y={geom.y(current[lastIdx] ?? 0) - 10} textAnchor="end" className="fill-foreground" style={{ fontSize: 11, fontWeight: 600 }}>
                  {current[lastIdx] ?? 0}{suffix}
                </text>
              </>
            )}

            {/* Crosshair on hover */}
            {hover != null && (
              <line x1={geom.cx(hover)} y1={TOP_PAD} x2={geom.cx(hover)} y2={geom.baseY} className="stroke-muted-foreground" strokeWidth={1} strokeOpacity={0.4} />
            )}

            {/* x ticks */}
            {buckets.map((b, i) => b.tick ? (
              <text key={b.start} x={geom.cx(i)} y={geom.baseY + 15} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 11 }}>{b.tick}</text>
            ) : null)}

            {/* One overlay owns hover for the whole plot (clears the 24px min target). */}
            <rect x={Y_GUTTER} y={0} width={Math.max(0, box.w - Y_GUTTER - RIGHT_PAD)} height={geom.baseY} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>
        )}

        {geom && hover != null && buckets[hover] && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
            style={{ left: Math.min(Math.max(geom.cx(hover) - 60, 0), Math.max(0, box.w - 160)), top: 0 }}
          >
            <div className="font-medium text-foreground">{buckets[hover].full}</div>
            <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: accent }} />
              {currentLabel}
              <span className="font-medium text-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>{current[hover] ?? 0}{suffix}</span>
            </div>
            {previous && (
              <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: greys.context }} />
                {previousLabel}
                <span className="font-medium text-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>{previous[hover] ?? 0}{suffix}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}
