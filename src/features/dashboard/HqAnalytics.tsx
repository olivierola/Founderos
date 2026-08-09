// AI HQ analytics — advanced stats for the headquarters dashboard, presented in
// premium tabbed views (Performance, Sources, Productivité, Gouvernance, Loop)
// with a segmented switch. Charts reuse the validated dataviz palette
// (features/crm/overview/vizPalette) and framer-motion for the animated chrome.
import { useMemo, useState, useId, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from "recharts";
import {
  Loader2, Activity, DollarSign, Gauge, ShieldCheck, Zap, RefreshCw,
  CheckCircle2, XCircle, Clock, AlertTriangle, TrendingUp, Timer,
  Bug, Repeat, Coins, Bot, Users, ListChecks, Wrench, X, Maximize2,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/features/internal-agents/AvatarPicker";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import type { RangeKey } from "@/features/crm/overview/crmStats";
import {
  fetchHqAgents, fetchHqRuns, fetchHqMissions, fetchHqDeliverables,
  fetchHqApprovals, fetchHqLoopEvents,
  buildPerfSeries, runHeadline, sourceBreakdown, missionFunnel,
  computeProductivity, computeApprovals, computeLoopHealth, bucketCounts,
  RANGES, fmtUsd, fmtDuration,
  type HqAgent, type HqRun, type HqMission, type HqDeliverable,
  type HqApproval, type LoopDecisionEvent, type PerfPoint, type RunHeadline,
  type AgentProductivity, type ApprovalStats, type LoopHealth, type SourceSlice,
} from "./hqStats";

// ─────────────────────────────────────────────────────────────────── data hook

export function useHqAnalytics(projectId: string | null | undefined, enabled = true) {
  const agentsQ = useQuery({
    queryKey: ["hq_agents", projectId],
    enabled: !!projectId && enabled,
    queryFn: () => fetchHqAgents(projectId!),
  });
  const agents = agentsQ.data ?? [];

  const runsQ = useQuery({
    queryKey: ["hq_runs", projectId],
    enabled: !!projectId && enabled,
    queryFn: () => fetchHqRuns(projectId!),
  });
  const missionsQ = useQuery({
    queryKey: ["hq_missions", projectId],
    enabled: !!projectId && enabled,
    queryFn: () => fetchHqMissions(projectId!),
  });
  const deliverablesQ = useQuery({
    queryKey: ["hq_deliverables", projectId],
    enabled: !!projectId && enabled && agents.length > 0,
    queryFn: () => fetchHqDeliverables(projectId!, agents.map((a) => a.id)),
  });
  const approvalsQ = useQuery({
    queryKey: ["hq_approvals", projectId],
    enabled: !!projectId && enabled,
    queryFn: () => fetchHqApprovals(projectId!),
  });
  const loopQ = useQuery({
    queryKey: ["hq_loop_events", projectId],
    enabled: !!projectId && enabled && agents.length > 0,
    queryFn: () => fetchHqLoopEvents(projectId!, agents.map((a) => a.id)),
  });

  return {
    agents,
    runs: (runsQ.data ?? []) as HqRun[],
    missions: (missionsQ.data ?? []) as HqMission[],
    deliverables: (deliverablesQ.data ?? []) as HqDeliverable[],
    approvals: (approvalsQ.data ?? []) as HqApproval[],
    loopEvents: (loopQ.data ?? []) as LoopDecisionEvent[],
    isLoading: agentsQ.isLoading || runsQ.isLoading || missionsQ.isLoading || approvalsQ.isLoading,
  };
}

export interface HqAnalyticsData {
  agents: HqAgent[];
  runs: HqRun[];
  missions: HqMission[];
  deliverables: HqDeliverable[];
  approvals: HqApproval[];
  loopEvents: LoopDecisionEvent[];
}

function windowFilter(range: RangeKey, data: HqAnalyticsData) {
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const from = Date.now() - days * 24 * 3600 * 1000;
  const inFrom = (t: string) => +new Date(t) >= from;
  return {
    runs: data.runs.filter((r) => inFrom(r.created_at)),
    approvals: data.approvals.filter((a) => inFrom(a.requested_at)),
    deliverables: data.deliverables.filter((d) => inFrom(d.created_at)),
    loopEvents: data.loopEvents.filter((e) => inFrom(e.created_at)),
  };
}

// ──────────────────────────────────────────────────────────────── shared bits

const fmtCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function rateTone(v: number | null): string | undefined {
  if (v == null) return undefined;
  return v >= 70 ? "text-emerald-600 dark:text-emerald-400" : v >= 40 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400";
}

function SectionCard({ title, subtitle, icon, right, children, className }: {
  title: string; subtitle?: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <Card className={cn("relative overflow-hidden rounded-2xl border bg-card p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
            {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>;
}

function Empty({ label }: { label: string }) {
  return <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-border text-center text-xs text-muted-foreground">{label}</div>;
}

const axis = { tick: { fontSize: 11 }, stroke: "hsl(var(--muted-foreground) / 0.35)" } as const;
const tooltipStyle = {
  contentStyle: { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.08)" },
  cursor: { fill: "hsl(var(--muted) / 0.35)" },
} as const;

/** Animated SVG sparkline — draw-in path + gradient fill (framer-motion). */
function Sparkline({ data, width = 300, height = 40, strokeWidth = 1.8, color = "#6366f1", className }: {
  data: number[]; width?: number; height?: number; strokeWidth?: number; color?: string; className?: string;
}) {
  const uid = useId().replace(/:/g, "");
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
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: "easeInOut" }} />
      <motion.path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#sg-${uid})`}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 0.15, ease: "easeInOut" }} />
    </svg>
  );
}

/** Premium KPI card — accent glow, animated value, optional sparkline. When
 *  `onClick` is provided (a curve exists) the card expands to a full curve. */
function StatCard({ label, value, sub, icon, accent, spark, tone, onClick, expanded, hint }: {
  label: string; value: string; sub?: ReactNode; icon: LucideIcon; accent: string; spark?: number[]; tone?: string;
  onClick?: () => void; expanded?: boolean; hint?: boolean;
}) {
  const Icon = icon;
  const interactive = !!onClick;
  return (
    <motion.div whileHover={{ y: interactive ? -2 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-card p-4 shadow-sm transition-colors",
        interactive && "cursor-pointer",
        expanded ? "border-primary/60 ring-2 ring-primary/20" : "border-border",
      )}>
      <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full opacity-[0.18] blur-2xl" style={{ background: accent }} />
      {hint && (
        <div className="pointer-events-none absolute right-2.5 top-2.5 rounded-md bg-muted/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <Maximize2 className="h-3 w-3" />
        </div>
      )}
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
          <motion.p key={value} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
            className={cn("mt-1 truncate text-2xl font-bold tabular-nums", tone)}>{value}</motion.p>
          {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `${accent}1a`, color: accent }}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {spark && spark.length >= 2 && (
        <div className="relative mt-3 h-10">
          <Sparkline data={spark} color={accent} />
        </div>
      )}
    </motion.div>
  );
}

interface CurveDef {
  name: string;
  data: number[];
  labels: string[];
  fullLabels?: string[];
  fmt?: (v: number) => string;
}

interface KpiCardDef {
  key: string;
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  accent: string;
  tone?: string;
  curve?: CurveDef;
}

/** Grid of KPI cards — clicking a card with a `curve` expands it full-width
 *  into an animated line chart (click again / ✕ to collapse). */
function KpiGrid({ cards, gridClass }: { cards: KpiCardDef[]; gridClass?: string }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expanded = cards.find((c) => c.key === expandedKey);

  return (
    <div className="space-y-3">
      <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6", gridClass)}>
        {cards.map((c) => (
          <StatCard
            key={c.key}
            label={c.label}
            value={c.value}
            sub={c.sub}
            icon={c.icon}
            accent={c.accent}
            tone={c.tone}
            spark={c.curve?.data}
            hint={!!c.curve}
            expanded={expandedKey === c.key}
            onClick={c.curve ? () => setExpandedKey(expandedKey === c.key ? null : c.key) : undefined}
          />
        ))}
      </div>
      <AnimatePresence mode="wait">
        {expanded?.curve && (
          <motion.div key={expanded.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: "easeOut" }}>
            <CurvePanel curve={expanded.curve} accent={expanded.accent} onClose={() => setExpandedKey(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Full-width animated curve (gradient area line chart) for an expanded metric. */
function CurvePanel({ curve, accent, onClose }: { curve: CurveDef; accent: string; onClose: () => void }) {
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
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{curve.name}</span>
          <LegendDot color={accent} label="Évolution sur la période" />
        </div>
        <button onClick={onClose} aria-label="Fermer la courbe"
          className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -6 }}>
            <defs>
              <linearGradient id={`cv-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.28} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
            <XAxis dataKey="label" {...axis} minTickGap={24} />
            <YAxis width={44} {...axis} tickFormatter={(v: number) => fmt(v)} />
            <Tooltip
              {...tooltipStyle}
              formatter={(v, name) => [fmt(Number(v) || 0), name]}
              labelFormatter={(_, p) => {
                const row = p?.[0]?.payload as { full: string } | undefined;
                return row?.full ?? "";
              }}
            />
            <Area type="monotone" dataKey="value" name={curve.name} stroke={accent} strokeWidth={2}
              fill={`url(#cv-${uid})`} dot={false} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RangePicker({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-border bg-muted/40 p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.key}
          onClick={() => onChange(r.key)}
          aria-pressed={value === r.key}
          className={cn(
            "rounded-lg px-2.5 py-1 text-xs transition-colors",
            value === r.key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

type TabKey = "perf" | "sources" | "productivity" | "governance" | "loop";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "perf", label: "Performance & coût", icon: Zap },
  { key: "sources", label: "Sources", icon: Activity },
  { key: "productivity", label: "Productivité", icon: Gauge },
  { key: "governance", label: "Gouvernance", icon: ShieldCheck },
  { key: "loop", label: "Santé du loop", icon: Bug },
];

/** Segmented switch with an animated active pill. */
function SegmentedControl({ value, onChange }: { value: TabKey; onChange: (t: TabKey) => void }) {
  return (
    <div className="scrollbar-slim flex w-full gap-1 overflow-x-auto rounded-2xl border border-border bg-muted/40 p-1 lg:w-fit">
      {TABS.map((t) => {
        const active = value === t.key;
        return (
          <button key={t.key} onClick={() => onChange(t.key)} aria-pressed={active}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}>
            {active && (
              <motion.span layoutId="hq-tab-pill" className="absolute inset-0 rounded-xl bg-card shadow-sm ring-1 ring-border"
                transition={{ type: "spring", bounce: 0.2, duration: 0.5 }} />
            )}
            <t.icon className="relative z-10 h-3.5 w-3.5" />
            <span className="relative z-10 whitespace-nowrap">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── main block

export function HqAnalytics({
  data, range, onRangeChange, isLoading,
}: {
  data: HqAnalyticsData;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  isLoading?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("perf");
  const w = useMemo(() => windowFilter(range, data), [range, data]);
  const series = useMemo(() => buildPerfSeries(w.runs, range), [w.runs, range]);
  const headline = useMemo(() => runHeadline(w.runs), [w.runs]);
  const sources = useMemo(() => sourceBreakdown(w.runs), [w.runs]);
  const funnel = useMemo(() => missionFunnel(data.missions, w.runs, range), [data.missions, w.runs, range]);
  const productivity = useMemo(
    () => computeProductivity(data.agents, w.runs, w.deliverables, w.approvals),
    [data.agents, w.runs, w.deliverables, w.approvals],
  );
  const approvals = useMemo(() => computeApprovals(w.approvals), [w.approvals]);
  const health = useMemo(
    () => computeLoopHealth(w.loopEvents, w.runs.filter((r) => r.status === "failed")),
    [w.loopEvents, w.runs],
  );

  const labels = useMemo(() => series.map((p) => p.tick), [series]);
  const fullLabels = useMemo(() => series.map((p) => p.full), [series]);
  const approvalsByBucket = useMemo(() => bucketCounts(w.approvals, range, (a) => a.requested_at), [w.approvals, range]);
  const approvedByBucket = useMemo(() => bucketCounts(w.approvals, range, (a) => a.requested_at, (a) => a.status === "approved" || a.status === "executed"), [w.approvals, range]);
  const rejectedByBucket = useMemo(() => bucketCounts(w.approvals, range, (a) => a.requested_at, (a) => a.status === "rejected"), [w.approvals, range]);
  const loopDecisionsByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at), [w.loopEvents, range]);
  const loopReplansByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at, (e) => e.action === "replan"), [w.loopEvents, range]);
  const loopLoopsByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at, (e) => e.loopDetected), [w.loopEvents, range]);
  const loopStagnationByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at, (e) => e.stagnantTicks >= 3), [w.loopEvents, range]);
  const loopAbortsByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at, (e) => e.action === "abort"), [w.loopEvents, range]);
  const loopEscalationsByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at, (e) => e.escalated), [w.loopEvents, range]);
  const loopErrorsByBucket = useMemo(() => bucketCounts(w.loopEvents, range, (e) => e.created_at, (e) => e.errors > 0), [w.loopEvents, range]);

  if (isLoading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" /> Analyse & Gouvernance
          </h2>
          <p className="text-[11px] text-muted-foreground">Performance, coût, productivité et santé de la force de travail IA</p>
        </div>
        <RangePicker value={range} onChange={onRangeChange} />
      </div>

      <SegmentedControl value={tab} onChange={setTab} />

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}>
          {tab === "perf" && <PerfTab series={series} headline={headline} range={range} />}
          {tab === "sources" && <SourcesTab sources={sources} funnel={funnel} series={series} />}
          {tab === "productivity" && <ProductivityTab rows={productivity} />}
          {tab === "governance" && <GovernanceTab stats={approvals} agents={data.agents} labels={labels} fullLabels={fullLabels} approvalsByBucket={approvalsByBucket} approvedByBucket={approvedByBucket} rejectedByBucket={rejectedByBucket} />}
          {tab === "loop" && <LoopHealthTab health={health} agents={data.agents} labels={labels} fullLabels={fullLabels} loopDecisionsByBucket={loopDecisionsByBucket} loopReplansByBucket={loopReplansByBucket} loopLoopsByBucket={loopLoopsByBucket} loopStagnationByBucket={loopStagnationByBucket} loopAbortsByBucket={loopAbortsByBucket} loopEscalationsByBucket={loopEscalationsByBucket} loopErrorsByBucket={loopErrorsByBucket} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ────────────────────────────────────────────────────── 1. Performance & coût

const bucketSuccessRate = (p: PerfPoint) => {
  const ended = p.succeeded + p.failed;
  return ended ? Math.round((p.succeeded / ended) * 100) : 0;
};

function PerfTab({ series, headline, range }: { series: PerfPoint[]; headline: RunHeadline; range: RangeKey }) {
  const palette = useCategorical();
  const periodLabel = RANGES.find((r) => r.key === range)?.label ?? "";
  const avg = (p: PerfPoint) => p.avgDurationSec ?? 0;
  const labels = series.map((p) => p.tick);
  const fullLabels = series.map((p) => p.full);

  return (
    <div className="space-y-4">
      <KpiGrid
        cards={[
          { key: "rate", label: "Taux de succès", value: headline.successRate == null ? "—" : `${headline.successRate}%`, icon: TrendingUp, accent: "#10b981", tone: rateTone(headline.successRate), curve: { name: "Taux de succès", data: series.map(bucketSuccessRate), labels, fullLabels, fmt: (v) => `${Math.round(v)}%` } },
          { key: "dur", label: "Durée moyenne", value: fmtDuration(headline.avgDurationSec != null ? headline.avgDurationSec * 1000 : null), icon: Timer, accent: "#3b82f6", curve: { name: "Durée moyenne des runs", data: series.map(avg), labels, fullLabels, fmt: (v) => fmtDuration(v * 1000) } },
          { key: "cost", label: "Coût total", value: fmtUsd(headline.totalCost), icon: DollarSign, accent: "#8b5cf6", curve: { name: "Coût par période", data: series.map((p) => p.costUsd), labels, fullLabels, fmt: fmtUsd } },
          { key: "avgcost", label: "Coût moyen / run", value: fmtUsd(headline.avgCost), icon: Coins, accent: "#06b6d4", curve: { name: "Coût moyen / run", data: series.map((p) => (p.runs ? +(p.costUsd / p.runs).toFixed(2) : 0)), labels, fullLabels, fmt: fmtUsd } },
          { key: "tok", label: "Tokens", value: fmtCompact.format(headline.totalTokens), icon: Activity, accent: "#f59e0b", curve: { name: "Tokens consommés", data: series.map((p) => p.tokens), labels, fullLabels, fmt: (v) => fmtCompact.format(v) } },
          { key: "act", label: "Actions outil", value: String(headline.totalActions), icon: Wrench, accent: "#f43f5e", curve: { name: "Actions d'outil", data: series.map((p) => p.actions), labels, fullLabels, fmt: (v) => fmtCompact.format(v) } },
        ]}
      />

      <SectionCard
        title="Évolution des runs & coût cumulé"
        subtitle={`${periodLabel.trim() || "Période"} · ${headline.runs} runs (${headline.succeeded} réussis, ${headline.failed} échoués, ${headline.ongoing} en cours)`}
        icon={<Zap className="h-4 w-4 text-muted-foreground" />}
      >
        {series.length === 0 ? <Empty label="Aucun run sur la période." />
          : (
            <div className="h-64 w-full sm:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
                  <XAxis dataKey="tick" {...axis} />
                  <YAxis yAxisId="left" width={36} {...axis} allowDecimals={false} />
                  <YAxis yAxisId="right" orientation="right" width={44} {...axis}
                    tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k$` : `$${v}`)} />
                  <Tooltip
                    {...tooltipStyle}
                    formatter={(value, name) => (name === "Coût cumulé" ? [fmtUsd(Number(value) || 0), name] : [value, name])}
                    labelFormatter={(_, payload) => {
                      const p = payload?.[0]?.payload as (typeof series)[number] | undefined;
                      return p?.full ?? "";
                    }}
                  />
                  <Bar yAxisId="left" dataKey="succeeded" name="Réussis" stackId="runs" fill={palette[1]} maxBarSize={26} />
                  <Bar yAxisId="left" dataKey="failed" name="Échoués" stackId="runs" fill={palette[7]} maxBarSize={26} />
                  <Bar yAxisId="left" dataKey="ongoing" name="En cours" stackId="runs" fill={palette[3]} radius={[3, 3, 0, 0]} maxBarSize={26} />
                  <Line yAxisId="right" type="monotone" dataKey="cumCostUsd" name="Coût cumulé" stroke={palette[0]} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <LegendDot color={palette[1]} label="Réussis" />
          <LegendDot color={palette[7]} label="Échoués" />
          <LegendDot color={palette[3]} label="En cours" />
          <LegendDot color={palette[0]} label="Coût cumulé" />
        </div>
      </SectionCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────── 2. Volume & sources

function SourcesTab({ sources, funnel, series }: {
  sources: SourceSlice[]; funnel: ReturnType<typeof missionFunnel>; series: PerfPoint[];
}) {
  const palette = useCategorical();
  const total = sources.reduce((s, x) => s + x.value, 0);
  const hasRuns = total > 0;
  const activeMissions = funnel.byStatus.filter((s) => s.status === "active" || s.status === "running").reduce((s, x) => s + x.count, 0);
  const labels = series.map((p) => p.tick);
  const fullLabels = series.map((p) => p.full);

  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="md:grid-cols-3 xl:grid-cols-5"
        cards={[
          { key: "runs", label: "Runs sur la période", value: String(total), icon: Zap, accent: "#8b5cf6", curve: { name: "Runs par période", data: series.map((p) => p.runs), labels, fullLabels } },
          { key: "sources", label: "Sources distinctes", value: String(sources.length), icon: Activity, accent: "#3b82f6" },
          { key: "active", label: "Missions actives", value: String(activeMissions), icon: Bot, accent: "#10b981" },
          { key: "sched", label: "Planifiées (cron)", value: String(funnel.scheduled), icon: RefreshCw, accent: "#06b6d4" },
          { key: "totalm", label: "Total missions", value: String(funnel.byStatus.reduce((s, x) => s + x.count, 0)), icon: ListChecks, accent: "#f59e0b" },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Répartition par source" subtitle="Origine des runs déclenchés" icon={<Activity className="h-4 w-4 text-muted-foreground" />}>
          {hasRuns ? (
            <div className="flex items-center gap-6">
              <div className="relative h-44 w-44 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={sources} dataKey="value" nameKey="label" innerRadius={52} outerRadius={76} paddingAngle={3}>
                      {sources.map((s, i) => <Cell key={s.key} fill={palette[i % palette.length]} />)}
                    </Pie>
                    <Tooltip {...tooltipStyle} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-bold tabular-nums">{total}</span>
                  <span className="text-[10px] text-muted-foreground">runs</span>
                </div>
              </div>
              <ul className="min-w-0 flex-1 space-y-2 text-xs">
                {sources.map((s, i) => (
                  <li key={s.key} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: palette[i % palette.length] }} />
                    <span className="flex-1 truncate">{s.label}</span>
                    <span className="font-medium tabular-nums">{s.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : <Empty label="Aucun run sur la période." />}
        </SectionCard>

        <SectionCard title="Top missions" subtitle="Charge par mission sur la période" icon={<Bot className="h-4 w-4 text-muted-foreground" />}>
          {funnel.perMission.length === 0 ? <Empty label="Aucune mission." />
            : (
              <div className="scrollbar-slim max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {funnel.perMission.slice(0, 8).map((m, i) => (
                  <div key={m.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-card text-[11px] font-bold shadow-sm">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{m.title}</span>
                    <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] capitalize", m.status === "active" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>
                      {m.status}
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{m.runs} runs</span>
                  </div>
                ))}
              </div>
            )}
        </SectionCard>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────── 3. Productivité par agent

function successColor(v: number | null): string {
  if (v == null) return "#94a3b8";
  return v >= 70 ? "#10b981" : v >= 40 ? "#f59e0b" : "#f43f5e";
}

function ProductivityTab({ rows }: { rows: AgentProductivity[] }) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const active = rows.filter((r) => r.runs > 0).length;
  const top = [...rows].sort((a, b) => b.runs - a.runs)[0];
  const best = [...rows].filter((r) => r.successRate != null).sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0))[0];
  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Agents actifs" value={String(active)} sub={`sur ${rows.length} agents`} icon={Users} accent="#8b5cf6" />
        <StatCard label="Top agent" value={top && top.runs > 0 ? top.agent.name : "—"} sub={top && top.runs > 0 ? `${top.runs} runs` : "Aucun run"}
          icon={Bot} accent="#3b82f6" />
        <StatCard label="Meilleur taux de succès" value={best ? `${best.successRate}%` : "—"} sub={best?.agent.name}
          icon={TrendingUp} accent="#10b981" tone={rateTone(best?.successRate ?? null)} />
        <StatCard label="Coût moyen / run" value={totalRuns ? fmtUsd(totalCost / totalRuns) : "—"} sub={`${totalRuns} runs au total`}
          icon={DollarSign} accent="#f59e0b" />
      </div>

      <SectionCard title="Détail par agent" subtitle={`Classés par nombre de runs · ${active} agent${active > 1 ? "s" : ""} actif${active > 1 ? "s" : ""} sur la période`}
        icon={<Gauge className="h-4 w-4 text-muted-foreground" />}>
        {rows.length === 0 ? <Empty label="Aucun agent sur la période." />
          : (
            <div className="scrollbar-slim -mx-1 max-h-80 overflow-auto px-1">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-2">Agent</th>
                    <th className="px-2 py-2 text-right">Runs</th>
                    <th className="px-2 py-2 text-right">Succès</th>
                    <th className="px-2 py-2 text-right">Coût</th>
                    <th className="px-2 py-2 text-right">Moy. coût</th>
                    <th className="px-2 py-2 text-right">Durée moy.</th>
                    <th className="px-2 py-2 text-right">Livrables</th>
                    <th className="px-2 py-2 text-right">En attente</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((r) => (
                    <tr key={r.agent.id} className="transition-colors hover:bg-muted/30">
                      <td className="py-2 pr-2">
                        <button
                          onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${r.agent.id}/chat`)}
                          className="flex items-center gap-2 text-left hover:text-primary"
                          title={r.agent.name}
                        >
                          <AgentAvatar url={r.agent.avatar_url} seed={r.agent.name} className="h-7 w-7 shrink-0 overflow-hidden rounded-lg" />
                          <span className="max-w-[150px] truncate font-medium text-foreground">{r.agent.name}</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{r.runs}</td>
                      <td className="px-2 py-2 text-right">
                        {r.successRate == null
                          ? <span className="text-muted-foreground">—</span>
                          : (
                            <span className="inline-flex items-center justify-end gap-2">
                              <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                                <span className="block h-full rounded-full" style={{ width: `${r.successRate}%`, background: successColor(r.successRate) }} />
                              </span>
                              <span className="w-9 font-medium tabular-nums" style={{ color: successColor(r.successRate) }}>{r.successRate}%</span>
                            </span>
                          )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtUsd(r.totalCost)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtUsd(r.avgCost)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtDuration(r.avgDurationSec != null ? r.avgDurationSec * 1000 : null)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{r.deliverables}</td>
                      <td className="px-2 py-2 text-right">
                        {r.pendingApprovals > 0
                          ? <span className="font-medium tabular-nums text-amber-600 dark:text-amber-400">{r.pendingApprovals}</span>
                          : <span className="tabular-nums text-muted-foreground">0</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </SectionCard>
    </div>
  );
}

// ─────────────────────────────────────────────────── 4. Approbations & gouvernance

function GovernanceTab({ stats, agents, labels, fullLabels, approvalsByBucket, approvedByBucket, rejectedByBucket }: {
  stats: ApprovalStats; agents: HqAgent[];
  labels: string[]; fullLabels: string[];
  approvalsByBucket: number[]; approvedByBucket: number[]; rejectedByBucket: number[];
}) {
  const palette = useCategorical();
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent";
  const maxTool = Math.max(1, ...stats.byTool.map((t) => t.total));

  return (
    <div className="space-y-4">
      <KpiGrid
        cards={[
          { key: "total", label: "Total requêtes", value: String(stats.total), icon: ShieldCheck, accent: "#8b5cf6", curve: { name: "Requêtes par période", data: approvalsByBucket, labels, fullLabels } },
          { key: "rate", label: "Taux d'approbation", value: stats.approvalRate == null ? "—" : `${stats.approvalRate}%`, icon: TrendingUp, accent: "#10b981", tone: rateTone(stats.approvalRate) },
          { key: "appr", label: "Approuvées", value: String(stats.approved + stats.executed), icon: CheckCircle2, accent: "#10b981", curve: { name: "Approuvées par période", data: approvedByBucket, labels, fullLabels } },
          { key: "rej", label: "Rejetées", value: String(stats.rejected), icon: XCircle, accent: "#f43f5e", curve: { name: "Rejetées par période", data: rejectedByBucket, labels, fullLabels } },
          { key: "pend", label: "En attente", value: String(stats.pending), icon: AlertTriangle, accent: "#f59e0b", tone: stats.pending > 0 ? "text-amber-600 dark:text-amber-400" : undefined },
          { key: "dec", label: "Décision moyenne", value: stats.avgDecisionMin == null ? "—" : `${stats.avgDecisionMin} min`, icon: Timer, accent: "#06b6d4" },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Statuts des requêtes" subtitle="Décisions humaines sur les actions sensibles" icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}>
          {stats.byStatus.length === 0 ? <Empty label="Aucune requête sur la période." />
            : (
              <div className="flex items-center gap-6">
                <div className="relative h-44 w-44 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={stats.byStatus} dataKey="value" nameKey="label" innerRadius={52} outerRadius={76} paddingAngle={3}>
                        {stats.byStatus.map((s, i) => <Cell key={s.label} fill={palette[i % palette.length]} />)}
                      </Pie>
                      <Tooltip {...tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-xl font-bold tabular-nums">{stats.total}</span>
                    <span className="text-[10px] text-muted-foreground">requêtes</span>
                  </div>
                </div>
                <ul className="min-w-0 flex-1 space-y-2 text-xs">
                  {stats.byStatus.map((s, i) => (
                    <li key={s.label} className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: palette[i % palette.length] }} />
                      <span className="flex-1 truncate">{s.label}</span>
                      <span className="font-medium tabular-nums">{s.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
        </SectionCard>

        <SectionCard title="Répartition par outil" subtitle="Requêtes d'approbation par outil" icon={<Wrench className="h-4 w-4 text-muted-foreground" />}>
          {stats.byTool.length === 0 ? <Empty label="Aucune requête." />
            : (
              <div className="space-y-2.5">
                {stats.byTool.slice(0, 8).map((t) => (
                  <div key={t.tool} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 truncate text-xs text-muted-foreground" title={t.tool}>{t.tool}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${(t.total / maxTool) * 100}%`, background: palette[0] }} />
                    </div>
                    <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{t.total} · {t.approved} appr.</span>
                  </div>
                ))}
                <div className="pt-1">
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Par agent</div>
                  {stats.byAgent.length === 0 ? <p className="text-[11px] text-muted-foreground">Aucune requête.</p>
                    : (
                      <div className="flex flex-wrap gap-1.5">
                        {stats.byAgent.slice(0, 6).map((a) => (
                          <span key={a.agentId} className="inline-flex items-center gap-1 rounded-lg bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            <span className="max-w-[90px] truncate">{agentName(a.agentId)}</span>
                            <span className="font-semibold text-foreground">{a.total}</span>
                          </span>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            )}
        </SectionCard>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────── 5. Santé du loop

function LoopHealthTab({ health, agents, labels, fullLabels, loopDecisionsByBucket, loopReplansByBucket, loopLoopsByBucket, loopStagnationByBucket, loopAbortsByBucket, loopEscalationsByBucket, loopErrorsByBucket }: {
  health: LoopHealth; agents: HqAgent[];
  labels: string[]; fullLabels: string[];
  loopDecisionsByBucket: number[]; loopReplansByBucket: number[]; loopLoopsByBucket: number[];
  loopStagnationByBucket: number[]; loopAbortsByBucket: number[]; loopEscalationsByBucket: number[]; loopErrorsByBucket: number[];
}) {
  const palette = useCategorical();
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent";

  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="md:grid-cols-4 xl:grid-cols-8"
        cards={[
          { key: "dec", label: "Décisions loop", value: String(health.decisions), icon: Activity, accent: "#8b5cf6", curve: { name: "Décisions par période", data: loopDecisionsByBucket, labels, fullLabels } },
          { key: "replans", label: "Replanifications", value: String(health.replans), icon: Repeat, accent: "#f59e0b", tone: health.replans > 0 ? "text-amber-600 dark:text-amber-400" : undefined, curve: { name: "Replanifications par période", data: loopReplansByBucket, labels, fullLabels } },
          { key: "loops", label: "Boucles détectées", value: String(health.loopsDetected), icon: RefreshCw, accent: "#f43f5e", tone: health.loopsDetected > 0 ? "text-rose-600 dark:text-rose-400" : undefined, curve: { name: "Boucles détectées par période", data: loopLoopsByBucket, labels, fullLabels } },
          { key: "stag", label: "Stagnations", value: String(health.stagnationEvents), icon: Clock, accent: "#f59e0b", tone: health.stagnationEvents > 0 ? "text-amber-600 dark:text-amber-400" : undefined, curve: { name: "Stagnations par période", data: loopStagnationByBucket, labels, fullLabels } },
          { key: "aborts", label: "Abandons", value: String(health.aborts), icon: XCircle, accent: "#f43f5e", tone: health.aborts > 0 ? "text-rose-600 dark:text-rose-400" : undefined, curve: { name: "Abandons par période", data: loopAbortsByBucket, labels, fullLabels } },
          { key: "esc", label: "Escalades", value: String(health.escalations), icon: TrendingUp, accent: "#06b6d4", curve: { name: "Escalades par période", data: loopEscalationsByBucket, labels, fullLabels } },
          { key: "iter", label: "Itérations moy.", value: health.avgIterations == null ? "—" : String(health.avgIterations), icon: ListChecks, accent: "#3b82f6" },
          { key: "errors", label: "Erreurs signalées", value: String(health.errorsInSignals), icon: Bug, accent: "#10b981", curve: { name: "Runs avec erreurs par période", data: loopErrorsByBucket, labels, fullLabels } },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Actions finales" subtitle="Dernière décision du contrôleur par run" icon={<Repeat className="h-4 w-4 text-muted-foreground" />}>
          {health.decisions === 0 ? <Empty label="Aucune donnée de loop." />
            : (
              <div className="flex h-44 items-end gap-2">
                {[
                  { label: "Continue", value: health.continues, color: palette[1] },
                  { label: "Finalise", value: health.finalizes, color: palette[0] },
                  { label: "Replan", value: health.replans, color: palette[3] },
                  { label: "Abort", value: health.aborts, color: palette[7] },
                ].map((b) => {
                  const h = Math.max(4, (b.value / Math.max(1, health.decisions)) * 100);
                  return (
                    <div key={b.label} className="flex flex-1 flex-col items-center gap-1.5">
                      <motion.div className="w-full rounded-t-xl" style={{ background: b.color }}
                        initial={{ height: 0 }} animate={{ height: `${h}%` }} transition={{ type: "spring", bounce: 0.3, duration: 0.6 }} />
                      <span className="text-[10px] text-muted-foreground">{b.label}</span>
                      <span className="text-sm font-bold tabular-nums">{b.value}</span>
                    </div>
                  );
                })}
              </div>
            )}
        </SectionCard>

        <SectionCard title="Par agent" subtitle="Décisions, replans et boucles par agent" icon={<Users className="h-4 w-4 text-muted-foreground" />}>
          {health.perAgent.length === 0 ? <Empty label="Aucune donnée de loop." />
            : (
              <div className="scrollbar-slim max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {health.perAgent.slice(0, 8).map((a) => (
                  <div key={a.agentId} className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-2 text-xs">
                    <span className="w-28 shrink-0 truncate text-muted-foreground">{agentName(a.agentId)}</span>
                    <span className="shrink-0 tabular-nums">{a.decisions} déc.</span>
                    <span className="shrink-0 tabular-nums">{a.replans} repl.</span>
                    <span className={cn("shrink-0 tabular-nums", a.loopsDetected > 0 ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>{a.loopsDetected} boucles</span>
                  </div>
                ))}
              </div>
            )}
        </SectionCard>

        <SectionCard title="Causes d'échec" subtitle="Première ligne des messages d'erreur des runs échoués" icon={<Bug className="h-4 w-4 text-muted-foreground" />}>
          {health.failureReasons.length === 0 ? <Empty label="Aucun run échoué." />
            : (
              <ul className="space-y-2">
                {health.failureReasons.map((r) => (
                  <li key={r.label} className="flex items-center gap-3 text-xs">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.label}>{r.label}</span>
                    <span className="shrink-0 rounded-lg bg-muted px-2 py-0.5 font-semibold tabular-nums">{r.count}</span>
                  </li>
                ))}
              </ul>
            )}
        </SectionCard>
      </div>
    </div>
  );
}
