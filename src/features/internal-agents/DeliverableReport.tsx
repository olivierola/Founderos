import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter, ZAxis,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, Info, CheckCircle2, AlertTriangle, AlertOctagon, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

// ---- structured report types ----------------------------------------------

interface Kpi { label: string; value: string | number; delta?: string; trend?: "up" | "down" | "flat" }
interface ChartSpec {
  type: "bar" | "line" | "area" | "pie" | "donut" | "radar" | "scatter";
  title?: string;
  x?: string;
  series?: string[];
  data: Array<Record<string, any>>;
  stacked?: boolean;
  unit?: string;
}
interface TableSpec { columns: string[]; rows: (string | number | null)[][]; title?: string }
interface Callout { tone?: "info" | "success" | "warning" | "danger"; text: string }
// A gauge (0-100 progress ring) for scores / completion.
interface Gauge { label: string; value: number; max?: number; tone?: "good" | "bad" | "neutral" }
// A vertical timeline of events.
interface TimelineItem { date?: string; title: string; detail?: string; tone?: "info" | "success" | "warning" | "danger" }
interface Section {
  heading?: string;
  body?: string;
  kpis?: Kpi[];
  chart?: ChartSpec;
  charts?: ChartSpec[];          // allow several charts per section
  table?: TableSpec;
  gauges?: Gauge[];
  timeline?: TimelineItem[];
  callout?: Callout;
}
export interface ReportDoc {
  title?: string;
  summary?: string;
  subtitle?: string;
  author?: string;
  sections?: Section[];
}

const CHART_COLORS = ["#3b5bdb", "#4dabf7", "#15aabf", "#0c8599", "#9775fa", "#f783ac", "#ffa94d", "#94d82d"];

// KPI card palette cycles through these gradients (à la executive dashboard).
const KPI_GRADIENTS = [
  "from-indigo-500 to-indigo-600",
  "from-indigo-900 to-indigo-950",
  "from-cyan-500 to-cyan-600",
  "from-slate-700 to-slate-900",
];

export function tryParseReport(content: string | null | undefined): ReportDoc | null {
  if (!content) return null;
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === "object" && (Array.isArray(obj.sections) || obj.title)) return obj as ReportDoc;
  } catch { /* not a report */ }
  return null;
}

// ===========================================================================

export function DeliverableReport({ report }: { report: ReportDoc }) {
  if (!report) return null;
  const sections = Array.isArray(report.sections) ? report.sections : [];
  const toc = sections.map((s, i) => ({ i, heading: s.heading })).filter((t) => t.heading);
  return (
    <div className="report-root mx-auto max-w-4xl">
      {/* Export toolbar (hidden when printing). */}
      <div className="no-print mb-3 flex justify-end">
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="Print or save as PDF"
        >
          <Printer className="h-3.5 w-3.5" /> Print / PDF
        </button>
      </div>
      {/* Pro cover header */}
      {(report.title || report.summary) && (
        <header className="mb-8 rounded-2xl border border-border bg-gradient-to-br from-indigo-600 to-indigo-800 p-6 text-white shadow-sm">
          {report.subtitle && <div className="mb-1 text-[11px] font-medium uppercase tracking-widest text-white/70">{report.subtitle}</div>}
          {report.title && <h1 className="text-2xl font-bold tracking-tight">{report.title}</h1>}
          {report.summary && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/85">{report.summary}</p>}
          <div className="mt-3 flex items-center gap-3 text-[11px] text-white/70">
            {report.author && <span>{report.author}</span>}
            <span>{new Date().toLocaleDateString()}</span>
          </div>
        </header>
      )}

      {/* Table of contents for longer reports */}
      {toc.length > 2 && (
        <nav className="mb-6 rounded-xl border border-border bg-card/40 p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Contents</div>
          <ol className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {toc.map((t) => (
              <li key={t.i}>
                <a href={`#sec-${t.i}`} className="text-sm text-primary hover:underline">{t.i + 1}. {t.heading}</a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="space-y-10">
        {sections.map((s, i) => <SectionView key={i} section={s} index={i} />)}
      </div>
    </div>
  );
}

function SectionView({ section, index }: { section: Section; index: number }) {
  const charts = section.charts ?? (section.chart ? [section.chart] : []);
  return (
    <section id={`sec-${index}`} className="space-y-4 scroll-mt-4">
      {section.heading && (
        <h2 className="border-b border-border pb-1.5 text-lg font-semibold tracking-tight">{section.heading}</h2>
      )}
      {section.kpis && section.kpis.length > 0 && <KpiRow kpis={section.kpis} />}
      {section.gauges && section.gauges.length > 0 && <GaugeRow gauges={section.gauges} />}
      {section.callout && <CalloutView callout={section.callout} />}
      {section.body && (
        <div className="prose prose-sm max-w-none leading-relaxed dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body}</ReactMarkdown>
        </div>
      )}
      {charts.length > 0 && (
        <div className={cn("grid gap-4", charts.length > 1 ? "md:grid-cols-2" : "grid-cols-1")}>
          {charts.map((c, ci) => (
            <figure key={ci} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              {c.title && <figcaption className="mb-2 text-xs font-medium text-muted-foreground">{c.title}</figcaption>}
              <ChartView chart={c} />
            </figure>
          ))}
        </div>
      )}
      {section.table && <TableView table={section.table} />}
      {section.timeline && section.timeline.length > 0 && <TimelineView items={section.timeline} />}
    </section>
  );
}

// ── Gauges (score / progress rings) ─────────────────────────────────────────
function GaugeRow({ gauges }: { gauges: Gauge[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {gauges.map((g, i) => {
        const max = g.max ?? 100;
        const pct = Math.max(0, Math.min(100, (g.value / max) * 100));
        const color = g.tone === "good" ? "#10b981" : g.tone === "bad" ? "#ef4444" : "#6366f1";
        return (
          <div key={i} className="flex flex-col items-center rounded-xl border border-border bg-card p-4">
            <div className="relative h-20 w-20">
              <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="hsl(var(--border))" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9" fill="none" stroke={color} strokeWidth="3"
                  strokeDasharray={`${pct} 100`} strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-sm font-bold">{Math.round(pct)}%</div>
            </div>
            <div className="mt-1.5 text-center text-xs text-muted-foreground">{g.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────
const TL_TONE: Record<string, string> = {
  info: "bg-sky-500", success: "bg-emerald-500", warning: "bg-amber-500", danger: "bg-destructive",
};
function TimelineView({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative ml-2 space-y-4 border-l border-border pl-5">
      {items.map((it, i) => (
        <li key={i} className="relative">
          <span className={cn("absolute -left-[1.45rem] top-1 h-2.5 w-2.5 rounded-full", TL_TONE[it.tone ?? "info"])} />
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{it.title}</span>
            {it.date && <span className="text-[11px] text-muted-foreground">{it.date}</span>}
          </div>
          {it.detail && <p className="text-xs text-muted-foreground">{it.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {kpis.map((k, i) => {
        const Trend = k.trend === "up" ? TrendingUp : k.trend === "down" ? TrendingDown : Minus;
        return (
          <div key={i} className={cn("rounded-xl bg-gradient-to-br p-4 text-white shadow-sm", KPI_GRADIENTS[i % KPI_GRADIENTS.length])}>
            <div className="text-2xl font-bold leading-tight">{k.value}</div>
            <div className="mt-1 text-xs text-white/80">{k.label}</div>
            {k.delta && (
              <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-white/90">
                <Trend className="h-3 w-3" /> {k.delta}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const CALLOUT_META = {
  info: { icon: Info, cls: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  success: { icon: CheckCircle2, cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  warning: { icon: AlertTriangle, cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  danger: { icon: AlertOctagon, cls: "border-destructive/30 bg-destructive/10 text-destructive" },
};

function CalloutView({ callout }: { callout: Callout }) {
  const meta = CALLOUT_META[callout.tone ?? "info"] ?? CALLOUT_META.info;
  const Icon = meta.icon;
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm", meta.cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{callout.text}</span>
    </div>
  );
}

export function ChartView({ chart }: { chart: ChartSpec }) {
  const x = chart.x ?? "name";
  const series = useMemo(() => {
    if (chart.series && chart.series.length) return chart.series;
    // Infer numeric series keys from the first data row (excluding x).
    const first = chart.data?.[0] ?? {};
    return Object.keys(first).filter((k) => k !== x && typeof first[k] === "number");
  }, [chart, x]);

  const data = chart.data ?? [];
  if (data.length === 0) return <p className="text-xs text-muted-foreground">No data.</p>;

  if (chart.type === "pie" || chart.type === "donut") {
    const valueKey = series[0] ?? "value";
    return (
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={data} dataKey={valueKey} nameKey={x} cx="50%" cy="50%"
            innerRadius={chart.type === "donut" ? 55 : 0} outerRadius={90} paddingAngle={chart.type === "donut" ? 2 : 0} label>
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chart.type === "radar") {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={data}>
          <PolarGrid stroke="hsl(var(--border))" />
          <PolarAngleAxis dataKey={x} tick={{ fontSize: 11 }} />
          <PolarRadiusAxis tick={{ fontSize: 10 }} />
          {series.map((s, i) => (
            <Radar key={s} name={s} dataKey={s} stroke={CHART_COLORS[i % CHART_COLORS.length]}
              fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.3} />
          ))}
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        </RadarChart>
      </ResponsiveContainer>
    );
  }

  if (chart.type === "scatter") {
    const yKey = series[0] ?? "y";
    return (
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey={x} tick={{ fontSize: 11 }} name={x} />
          <YAxis dataKey={yKey} tick={{ fontSize: 11 }} name={yKey} width={48} />
          <ZAxis range={[60, 60]} />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Scatter data={data} fill={CHART_COLORS[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
      <XAxis dataKey={x} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={48} />
      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--border))" }} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    </>
  );

  return (
    <ResponsiveContainer width="100%" height={280}>
      {chart.type === "line" ? (
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {axes}
          {series.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={false} />)}
        </LineChart>
      ) : chart.type === "area" ? (
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {axes}
          {series.map((s, i) => (
            <Area key={s} type="monotone" dataKey={s} stackId={chart.stacked ? "1" : undefined}
              stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.25} />
          ))}
        </AreaChart>
      ) : (
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {axes}
          {series.map((s, i) => (
            <Bar key={s} dataKey={s} stackId={chart.stacked ? "1" : undefined}
              fill={CHART_COLORS[i % CHART_COLORS.length]} radius={chart.stacked ? 0 : [3, 3, 0, 0]} />
          ))}
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}

function TableView({ table }: { table: TableSpec }) {
  if (!Array.isArray(table?.columns) || !Array.isArray(table?.rows)) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} className={cn("px-3 py-2 font-medium text-muted-foreground", i === 0 ? "text-left" : "text-right")}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, ri) => (
            <tr key={ri} className="border-t border-border/60">
              {(Array.isArray(r) ? r : []).map((cell, ci) => (
                <td key={ci} className={cn("px-3 py-2", ci === 0 ? "text-left font-medium" : "text-right tabular-nums")}>
                  {cell == null ? "" : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- markdown with embedded ```chart blocks --------------------------------

// Renders markdown, replacing ```chart fenced blocks with real charts.
export function RichMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props: any) {
            const { className, children } = props;
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            if (lang === "chart") {
              try {
                const spec = JSON.parse(String(children).trim()) as ChartSpec;
                return (
                  <div className="not-prose my-3 rounded-lg border border-border bg-card p-4">
                    <ChartView chart={spec} />
                  </div>
                );
              } catch {
                return <code className={className}>{children}</code>;
              }
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
