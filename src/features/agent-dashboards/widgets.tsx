import { useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ArrowDownIcon, ArrowUpIcon, CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, WarningIcon, WarningOctagonIcon, InfoIcon,
  CheckCircleIcon,
} from "@phosphor-icons/react";
import { AgentMarkdown } from "@/components/AgentMarkdown";
import { useThemeMode } from "@/lib/theme-context";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import {
  statusOf,
  type AlertsData, type DonutData, type GaugeData, type KpiData, type SeriesData, type Status, type TableData, type TextData,
  type WidgetConfig, type WidgetKind,
} from "./api";

/**
 * Le rendu des composants d'un dashboard.
 *
 * Les règles de lecture (skill dataviz) : une série seule prend l'accent du
 * thème ; plusieurs séries prennent la palette catégorielle dans un ordre fixe,
 * validée pour les daltonismes sur les fonds clair et sombre, avec une légende
 * dès deux séries. Traits de 2 px, barres de 24 px au plus, bouts arrondis
 * côté valeur. Chaque graphique s'ouvre aussi en tableau (« Données »). Le
 * vert, l'ambre et le rouge ne disent que l'état, toujours avec son libellé.
 */

const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function useIsDark(): boolean {
  useThemeMode(); // re-rend au changement de thème
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function useSeriesColors(n: number): string[] {
  const dark = useIsDark();
  if (n <= 1) return ["hsl(var(--primary))"];
  return (dark ? SERIES_DARK : SERIES_LIGHT).slice(0, n);
}

export const STATUS_META: Record<Status, { label: string; dot: string; text: string; bar: string }> = {
  ok: { label: "Normal", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400", bar: "bg-primary" },
  warn: { label: "Attention", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", bar: "bg-amber-500" },
  critical: { label: "Critique", dot: "bg-red-500", text: "text-red-700 dark:text-red-400", bar: "bg-red-500" },
};

export function fmtNumber(v: number, config?: WidgetConfig): string {
  const decimals = config?.decimals ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k`;
  return v.toLocaleString("fr-FR", { maximumFractionDigits: decimals });
}

const AXIS = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };

function ChartTooltip({ active, payload, label, unit }: {
  active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string | number; unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          <span className="h-0.5 w-3 rounded-full" style={{ background: p.color }} />
          <span className="font-semibold tabular-nums">{typeof p.value === "number" ? fmtNumber(p.value) : p.value}{unit ? ` ${unit}` : ""}</span>
          {payload.length > 1 && <span className="text-muted-foreground">{p.name}</span>}
        </div>
      ))}
    </div>
  );
}

// ── KPI ──────────────────────────────────────────────────────────────────────

export function KpiWidget({ data, config }: { data: KpiData; config: WidgetConfig }) {
  const n = typeof data.value === "number" ? data.value : null;
  const st = statusOf(n, config, data.status);
  const unit = data.unit ?? config.unit;
  // La variation est verte quand elle va dans le bon sens : vers le haut si le
  // seuil est « en dessous de », vers le bas s'il est « au-dessus de ».
  const goodUp = config.thresholds ? config.thresholds.direction === "below" : null;
  const deltaTone = data.delta == null || data.delta === 0 || goodUp == null
    ? "text-muted-foreground"
    : (data.delta > 0) === goodUp ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400";
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[34px] font-semibold leading-none tracking-tight">{n != null ? fmtNumber(n, config) : String(data.value)}</span>
        {unit && <span className="text-[15px] text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {data.delta != null && (
          <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", deltaTone)}>
            {data.delta > 0 ? <ArrowUpIcon className="h-3 w-3" /> : data.delta < 0 ? <ArrowDownIcon className="h-3 w-3" /> : null}
            {data.delta > 0 ? "+" : ""}{fmtNumber(data.delta, { decimals: 1 })} %
            {data.delta_label && <span className="ml-1 font-normal text-muted-foreground">{data.delta_label}</span>}
          </span>
        )}
        {st && <StatusLabel status={st} />}
      </div>
      {data.caption && <div className="mt-1 truncate text-[12px] text-muted-foreground">{data.caption}</div>}
      {data.trend && data.trend.length > 1 && <Sparkline values={data.trend} unit={unit} />}
    </div>
  );
}

export function StatusLabel({ status }: { status: Status }) {
  const m = STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", m.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} /> {m.label}
    </span>
  );
}

function Sparkline({ values, unit }: { values: number[]; unit?: string }) {
  const points = values.map((v, i) => ({ i, v }));
  return (
    <div className="mt-auto h-12 min-h-0 pt-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <Tooltip content={<ChartTooltip unit={unit} />} labelFormatter={() => ""} cursor={{ stroke: "hsl(var(--border))" }} />
          <Area type="monotone" dataKey="v" name="Valeur" stroke="hsl(var(--primary))" strokeWidth={2} fill="hsl(var(--primary))" fillOpacity={0.1} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Jauge ────────────────────────────────────────────────────────────────────

export function GaugeWidget({ data, config }: { data: GaugeData; config: WidgetConfig }) {
  const max = data.max || config.max || 100;
  const pct = Math.max(0, Math.min(1, data.value / max));
  const st = statusOf(data.value, config, data.status);
  const unit = data.unit ?? config.unit;
  const R = 70, C = Math.PI * R;
  const stroke = st === "critical" ? "#e34948" : st === "warn" ? "#eda100" : "hsl(var(--primary))";
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <svg viewBox="0 0 180 104" className="w-full max-w-[220px]" role="img" aria-label={`${fmtNumber(data.value, config)} sur ${fmtNumber(max)}`}>
        <path d="M 20 94 A 70 70 0 0 1 160 94" fill="none" stroke="hsl(var(--primary) / 0.14)" strokeWidth={14} strokeLinecap="round" />
        <path d="M 20 94 A 70 70 0 0 1 160 94" fill="none" stroke={stroke} strokeWidth={14} strokeLinecap="round"
          strokeDasharray={`${C * pct} ${C}`} />
        <text x="90" y="82" textAnchor="middle" className="fill-foreground" style={{ fontSize: 26, fontWeight: 600 }}>
          {fmtNumber(data.value, config)}{unit ? <tspan style={{ fontSize: 14, fontWeight: 400 }} className="fill-muted-foreground"> {unit}</tspan> : null}
        </text>
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[12px]">
        <span className="text-muted-foreground">sur {fmtNumber(max)}{unit ? ` ${unit}` : ""}</span>
        {st && <StatusLabel status={st} />}
      </div>
      {data.caption && <div className="mt-1 max-w-full truncate text-[12px] text-muted-foreground">{data.caption}</div>}
    </div>
  );
}

// ── Séries : courbe, aire, barres ────────────────────────────────────────────

export function SeriesWidget({ kind, data, config }: { kind: "line" | "area" | "bar"; data: SeriesData; config: WidgetConfig }) {
  const colors = useSeriesColors(data.series.length);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const rows = useMemo(() => data.labels.map((label, i) => {
    const r: Record<string, string | number> = { label };
    data.series.forEach((s, k) => { r[`s${k}`] = s.data[i] ?? 0; });
    return r;
  }), [data]);
  const unit = data.unit ?? config.unit;
  const multi = data.series.length > 1;
  const toggle = (name: string) => setHidden((h) => { const n = new Set(h); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const common = { data: rows, margin: { top: 8, right: 8, bottom: 0, left: -12 } };
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeWidth={1} />
      <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} minTickGap={16} />
      <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => fmtNumber(v)} />
      <Tooltip content={<ChartTooltip unit={unit} />} cursor={kind === "bar" ? { fill: "hsl(var(--muted) / 0.5)" } : { stroke: "hsl(var(--border))" }} />
      {multi && (
        <Legend
          verticalAlign="top" align="right" height={24} iconSize={8}
          onClick={(e: { value?: string }) => e.value && toggle(e.value)}
          formatter={(v: string) => <span className={cn("text-[11px]", hidden.has(v) ? "text-muted-foreground/50 line-through" : "text-muted-foreground")}>{v}</span>}
          wrapperStyle={{ cursor: "pointer", fontSize: 11 }}
        />
      )}
    </>
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
      {kind === "bar" ? (
        <BarChart {...common} barGap={2}>
          {axes}
          {data.series.map((s, k) => (
            <Bar key={k} dataKey={`s${k}`} name={s.name} fill={colors[k]} maxBarSize={24} radius={[4, 4, 0, 0]}
              stackId={config.stacked ? "a" : undefined} hide={hidden.has(s.name)} isAnimationActive={false} />
          ))}
        </BarChart>
      ) : kind === "area" ? (
        <AreaChart {...common}>
          {axes}
          {data.series.map((s, k) => (
            <Area key={k} type="monotone" dataKey={`s${k}`} name={s.name} stroke={colors[k]} strokeWidth={2} fill={colors[k]} fillOpacity={0.1}
              dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} hide={hidden.has(s.name)} isAnimationActive={false} />
          ))}
        </AreaChart>
      ) : (
        <LineChart {...common}>
          {axes}
          {data.series.map((s, k) => (
            <Line key={k} type="monotone" dataKey={`s${k}`} name={s.name} stroke={colors[k]} strokeWidth={2}
              dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} hide={hidden.has(s.name)} isAnimationActive={false} />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

// ── Anneau ───────────────────────────────────────────────────────────────────

export function DonutWidget({ data, config }: { data: DonutData; config: WidgetConfig }) {
  const colors = useSeriesColors(Math.max(2, data.items.length));
  const total = data.items.reduce((s, it) => s + it.value, 0);
  const unit = data.unit ?? config.unit;
  const [active, setActive] = useState<number | null>(null);
  return (
    <div className="flex h-full items-center gap-4">
      <div className="relative h-full min-h-[120px] w-1/2 min-w-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<ChartTooltip unit={unit} />} />
            <Pie data={data.items} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="92%" paddingAngle={0}
              stroke="hsl(var(--card))" strokeWidth={2} isAnimationActive={false}
              onMouseEnter={(_: unknown, i: number) => setActive(i)} onMouseLeave={() => setActive(null)}>
              {data.items.map((_, i) => <Cell key={i} fill={colors[i]} opacity={active == null || active === i ? 1 : 0.45} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[20px] font-semibold leading-none">{fmtNumber(active != null ? data.items[active].value : total)}</span>
          <span className="mt-1 text-[11px] text-muted-foreground">{active != null ? data.items[active].label : "au total"}</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {data.items.map((it, i) => (
          <li key={i} className={cn("flex items-center gap-2 text-[12px]", active != null && active !== i && "opacity-50")}
            onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colors[i] }} />
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            <span className="tabular-nums text-muted-foreground">{total ? Math.round((it.value / total) * 100) : 0} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Tableau ──────────────────────────────────────────────────────────────────

export function TableWidget({ data }: { data: TableData }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    let r = data.rows;
    const needle = q.trim().toLowerCase();
    if (needle) r = r.filter((row) => Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(needle)));
    if (sort) {
      r = [...r].sort((a, b) => {
        const x = a[sort.key], y = b[sort.key];
        if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
        return String(x ?? "").localeCompare(String(y ?? ""), "fr", { numeric: true }) * sort.dir;
      });
    }
    return r;
  }, [data.rows, sort, q]);
  const hasStatus = data.rows.some((r) => r._status);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {data.rows.length > 8 && (
        <label className="mb-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 text-[12px]">
          <MagnifyingGlassIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-hide">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border text-left text-muted-foreground">
              {hasStatus && <th className="w-6" />}
              {data.columns.map((c) => (
                <th key={c.key} className="px-2 py-2 font-medium">
                  <button onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                    className="inline-flex items-center gap-1 hover:text-foreground">
                    {c.label}
                    {sort?.key === c.key && (sort.dir === 1 ? <CaretUpIcon className="h-3 w-3" /> : <CaretDownIcon className="h-3 w-3" />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const st = r._status === "ok" || r._status === "warn" || r._status === "critical" ? r._status as Status : null;
              return (
                <tr key={i} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  {hasStatus && (
                    <td className="px-2" title={st ? STATUS_META[st].label : undefined}>
                      {st && <span className={cn("block h-2 w-2 rounded-full", STATUS_META[st].dot)} />}
                    </td>
                  )}
                  {data.columns.map((c) => (
                    <td key={c.key} className={cn("px-2 py-2", typeof r[c.key] === "number" && "text-right tabular-nums")}>
                      {typeof r[c.key] === "number" ? fmtNumber(r[c.key] as number) : String(r[c.key] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="py-6 text-center text-[12px] text-muted-foreground">Aucune ligne.</p>}
      </div>
    </div>
  );
}

// ── Alertes ──────────────────────────────────────────────────────────────────

const SEVERITY = {
  critical: { label: "Critique", icon: WarningOctagonIcon, cls: "bg-red-500/10 text-red-700 dark:text-red-400" },
  warn: { label: "Attention", icon: WarningIcon, cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  info: { label: "Info", icon: InfoIcon, cls: "bg-muted text-muted-foreground" },
} as const;

export function AlertsWidget({ data }: { data: AlertsData }) {
  const [filter, setFilter] = useState<"all" | "critical" | "warn" | "info">("all");
  const [open, setOpen] = useState<number | null>(null);
  const count = (s: string) => data.items.filter((i) => i.severity === s).length;
  const items = data.items.filter((i) => filter === "all" || i.severity === filter);
  if (!data.items.length) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <CheckCircleIcon className="h-4 w-4 text-emerald-600" /> Aucune alerte active
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 flex-wrap gap-1">
        {(["all", "critical", "warn", "info"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn("rounded-full px-2.5 py-0.5 text-[11px] transition-colors", filter === f ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground")}>
            {f === "all" ? `Toutes ${data.items.length}` : `${SEVERITY[f].label} ${count(f)}`}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto scrollbar-hide">
        {items.map((a, i) => {
          const S = SEVERITY[a.severity];
          return (
            <li key={i}>
              <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-start gap-2.5 py-2 text-left">
                <span className={cn("mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium", S.cls)}>
                  <S.icon className="h-3 w-3" /> {S.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium">{a.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[a.source, a.time ? formatRelative(a.time) || a.time : null].filter(Boolean).join(" · ")}
                  </span>
                  {open === i && a.detail && <span className="mt-1 block text-[12px] text-foreground/80">{a.detail}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Texte ────────────────────────────────────────────────────────────────────

export function TextWidget({ data }: { data: TextData }) {
  return (
    <div className="h-full overflow-auto text-[13px] leading-relaxed scrollbar-hide">
      <AgentMarkdown content={data.markdown} />
    </div>
  );
}

// ── La vue « Données » d'un graphique ────────────────────────────────────────

export function DataTable({ kind, data }: { kind: WidgetKind; data: unknown }) {
  if (kind === "line" || kind === "area" || kind === "bar") {
    const d = data as SeriesData;
    return (
      <TableWidget data={{
        columns: [{ key: "label", label: "" }, ...d.series.map((s, k) => ({ key: `s${k}`, label: s.name }))],
        rows: d.labels.map((l, i) => Object.fromEntries([["label", l], ...d.series.map((s, k) => [`s${k}`, s.data[i] ?? null])])),
      }} />
    );
  }
  if (kind === "donut") {
    const d = data as DonutData;
    return <TableWidget data={{ columns: [{ key: "label", label: "Part" }, { key: "value", label: "Valeur" }], rows: d.items.map((it) => ({ label: it.label, value: it.value })) }} />;
  }
  return <pre className="h-full overflow-auto text-[11px] scrollbar-hide">{JSON.stringify(data, null, 2)}</pre>;
}

export function WidgetBody({ kind, data, config }: { kind: WidgetKind; data: unknown; config: WidgetConfig }) {
  switch (kind) {
    case "kpi": return <KpiWidget data={data as KpiData} config={config} />;
    case "gauge": return <GaugeWidget data={data as GaugeData} config={config} />;
    case "line": case "area": case "bar": return <SeriesWidget kind={kind} data={data as SeriesData} config={config} />;
    case "donut": return <DonutWidget data={data as DonutData} config={config} />;
    case "table": return <TableWidget data={data as TableData} />;
    case "alerts": return <AlertsWidget data={data as AlertsData} />;
    case "text": return <TextWidget data={data as TextData} />;
  }
}
