import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SparkPoint {
  /** Domain value on the X axis — Date object or a number/string used only for tooltip display. */
  x: Date | number | string;
  /** Numeric value to plot. */
  y: number;
}

interface Props {
  title: string;
  /** A small label shown above the total ("Invocations", "Total"). */
  subtitle?: string;
  /** Total / latest value displayed prominently. Defaults to the sum of `data`. */
  total?: number | string;
  data: SparkPoint[];
  /** Optional click handler — when set, renders a chevron on the right of the title row. */
  onClick?: () => void;
  /** Override the line color (CSS color). Defaults to a Vercel-like blue. */
  color?: string;
  /** Format ticks on the Y axis (e.g. compact numbers, kB). */
  formatY?: (value: number) => string;
  /** Custom label for the left and right ends of the X axis (e.g. "12h ago" / "Just now"). */
  xLabels?: { start: string; end: string };
  /** Chart height in pixels. Default 180. */
  height?: number;
  className?: string;
}

const DEFAULT_COLOR = "hsl(var(--primary-soft))";

function niceTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(range / count)));
  const err = (count * step) / range;
  const stepMult = err >= 7.5 ? 0.1 : err >= 3 ? 0.2 : err >= 1.5 ? 0.5 : 1;
  const niceStep = stepMult * step;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9; v += niceStep) ticks.push(v);
  return ticks;
}

export function SparkChart({
  title,
  subtitle,
  total,
  data,
  onClick,
  color = DEFAULT_COLOR,
  formatY,
  xLabels,
  height = 180,
  className,
}: Props) {
  const PAD_L = 32;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 22;
  const W = 600; // virtual width — SVG scales via viewBox
  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const { min, max, points, ticks, totalDisplay } = useMemo(() => {
    const ys = data.map((d) => d.y);
    const mx = ys.length ? Math.max(...ys, 1) : 1;
    const mn = 0;
    const tk = niceTicks(mn, mx, 3);
    const px = (i: number) =>
      data.length <= 1 ? PAD_L + innerW / 2 : PAD_L + (i / (data.length - 1)) * innerW;
    const py = (v: number) =>
      PAD_T + innerH - ((v - mn) / Math.max(1, mx - mn)) * innerH;
    const pts = data.map((d, i) => ({ x: px(i), y: py(d.y), raw: d }));
    const computedTotal =
      total != null ? total : ys.reduce((a, b) => a + b, 0);
    return { min: mn, max: mx, points: pts, ticks: tk, totalDisplay: computedTotal };
  }, [data, total, innerW, innerH]);

  const linePath = useMemo(() => {
    if (points.length === 0) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  }, [points]);

  const areaPath = useMemo(() => {
    if (points.length === 0) return "";
    const baseY = PAD_T + innerH;
    return (
      `M${points[0].x.toFixed(1)},${baseY} ` +
      points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
      ` L${points[points.length - 1].x.toFixed(1)},${baseY} Z`
    );
  }, [points, innerH]);

  const [hover, setHover] = useState<{ x: number; y: number; index: number } | null>(null);
  const gradId = useMemo(() => "sg-" + Math.random().toString(36).slice(2, 9), []);

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    if (points.length === 0) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const ratio = W / rect.width;
    const xSvg = (e.clientX - rect.left) * ratio;
    let nearest = 0;
    let minD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - xSvg);
      if (d < minD) { minD = d; nearest = i; }
    });
    setHover({ x: points[nearest].x, y: points[nearest].y, index: nearest });
  }

  function fmtY(v: number): string {
    if (formatY) return formatY(v);
    if (v >= 1000) return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  const totalNode =
    typeof totalDisplay === "number" ? fmtY(totalDisplay) : (totalDisplay ?? "");

  return (
    <div
      className={cn(
        "group rounded-lg border border-border bg-card p-4 transition-colors",
        onClick && "cursor-pointer hover:border-border/80",
        className,
      )}
      onClick={onClick}
    >
      <div className="mb-1 flex items-start justify-between">
        <div className="text-sm font-medium">{title}</div>
        {onClick && (
          <ChevronRight className="h-4 w-4 text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100" />
        )}
      </div>
      {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      <div className="mt-1 text-2xl font-semibold tabular-nums">{totalNode}</div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 w-full"
        style={{ height }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Y-axis gridlines + labels */}
        {ticks.map((t) => {
          const y = PAD_T + innerH - ((t - min) / Math.max(1, max - min)) * innerH;
          return (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
                strokeDasharray="2 3"
                opacity={0.6}
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[9px]"
              >
                {fmtY(t)}
              </text>
            </g>
          );
        })}

        {/* Area + line */}
        {points.length > 0 && (
          <>
            <path d={areaPath} fill={`url(#${gradId})`} />
            <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
          </>
        )}

        {/* Hover indicator */}
        {hover && (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD_T}
              y2={PAD_T + innerH}
              stroke={color}
              strokeWidth={0.5}
              strokeDasharray="2 2"
              opacity={0.5}
            />
            <circle cx={hover.x} cy={hover.y} r={3} fill={color} />
          </g>
        )}

        {/* X-axis end labels */}
        {xLabels && (
          <>
            <text
              x={PAD_L}
              y={H - 6}
              className="fill-muted-foreground text-[10px]"
              textAnchor="start"
            >
              {xLabels.start}
            </text>
            <text
              x={W - PAD_R}
              y={H - 6}
              className="fill-muted-foreground text-[10px]"
              textAnchor="end"
            >
              {xLabels.end}
            </text>
          </>
        )}
      </svg>

      {hover && data[hover.index] && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{fmtY(data[hover.index].y)}</span>{" "}
          <span className="opacity-70">
            ·{" "}
            {data[hover.index].x instanceof Date
              ? (data[hover.index].x as Date).toLocaleString()
              : String(data[hover.index].x)}
          </span>
        </div>
      )}
    </div>
  );
}
