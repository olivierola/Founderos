import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from "recharts";
import {
  ArrowUpRightIcon, ArrowDownRightIcon, ArrowRightIcon, BellIcon, ClockIcon, CalendarBlankIcon,
  PlusIcon, CheckIcon, TrashIcon, FunnelSimpleIcon, XIcon, WarningCircleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useToast } from "@/components/ToastProvider";
import { Tabs } from "@/features/tracker/ui";
import { formatRelative } from "@/features/tracker/pickers";
import { fetchMyWork } from "@/features/tracker/model";
import { useLiteAgents, type LiteAgent } from "./live/teams";

/**
 * La vue d'ensemble du service, en tête de l'accueil.
 *
 * Une rangée de filtres (période, collaborateur, déclencheur) pilote tout ce
 * qui suit : les indicateurs et leur tendance face à la période précédente,
 * l'activité dans le temps, le coût, la carte des heures actives, la charge
 * par collaborateur, les erreurs qui reviennent. À côté, les rappels :
 * personnels (0306), missions planifiées à venir et échéances des work items.
 *
 * Cliquer un collaborateur (barre ou carte) filtre toute la vue sur lui.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Couleurs de statut fixes (palette de référence dataviz) : jamais réutilisées
// pour une série, toujours accompagnées d'un libellé.
const C_OK = "#0ca30c";
const C_FAIL = "#d03b3b";
const C_OTHER = "#898781";
const C_SERIES = "#3987e5";

type Period = "1" | "7" | "30" | "90";
type Via = "all" | "schedule" | "manual" | "api";

interface Run {
  id: string; agent_id: string; status: string; mission_id: string | null; triggered_via: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
  cost_usd: number | null; tokens_in: number | null; tokens_out: number | null; action_count: number | null;
  error_message: string | null;
}

interface Bucket { t: number; label: string; ok: number; fail: number; other: number; cost: number; tokens: number; actions: number; runs: number }

const fmtInt = (n: number) => new Intl.NumberFormat("fr-FR", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
const fmtUsd = (n: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
function fmtDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${String(s % 60).padStart(2, "0")}` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function useServiceBase(dashboardId: string) {
  const { workspaceSlug, projectSlug } = useParams();
  return `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
}

/** Les buckets d'une période : par heure sur 24 h, par jour au-delà. */
function makeBuckets(days: number, end: number): Bucket[] {
  const hourly = days === 1;
  const step = hourly ? HOUR : DAY;
  const n = hourly ? 24 : days;
  const last = new Date(end);
  if (hourly) last.setMinutes(0, 0, 0); else last.setHours(0, 0, 0, 0);
  const out: Bucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = last.getTime() - i * step;
    const d = new Date(t);
    out.push({
      t,
      label: hourly ? `${d.getHours()}h` : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }),
      ok: 0, fail: 0, other: 0, cost: 0, tokens: 0, actions: 0, runs: 0,
    });
  }
  return out;
}

function summarize(runs: Run[]) {
  const finished = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
  const ok = runs.filter((r) => r.status === "succeeded").length;
  const durations = runs
    .filter((r) => r.started_at && r.finished_at)
    .map((r) => Date.parse(r.finished_at!) - Date.parse(r.started_at!))
    .filter((x) => x > 0);
  return {
    runs: runs.length,
    success: finished.length ? ok / finished.length : NaN,
    cost: runs.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0),
    tokens: runs.reduce((s, r) => s + Number(r.tokens_in ?? 0) + Number(r.tokens_out ?? 0), 0),
    actions: runs.reduce((s, r) => s + Number(r.action_count ?? 0), 0),
    duration: median(durations),
    failed: runs.filter((r) => r.status === "failed").length,
  };
}

/** Une erreur, sans ce qui change d'une occurrence à l'autre (ids, nombres). */
function errorKey(msg: string) {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "…")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

export function ServiceOverview({ dashboardId, onOpenIssue }: {
  dashboardId: string;
  onOpenIssue?: (projectId: string, issueId: string) => void;
}) {
  const navigate = useNavigate();
  const base = useServiceBase(dashboardId);
  const [period, setPeriod] = useState<Period>("7");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [via, setVia] = useState<Via>("all");
  const days = Number(period);

  const { data: agentsData } = useLiteAgents(dashboardId);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const agentIds = agents.map((a) => a.id);

  // Deux périodes d'un coup : la courante, et la précédente pour la tendance.
  const { data: allRuns, isLoading } = useQuery({
    queryKey: ["sd_overview_runs", dashboardId, agentIds.join(","), period],
    enabled: agentIds.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 2 * days * DAY).toISOString();
      const { data, error } = await supabase.from("internal_agent_runs")
        .select("id, agent_id, status, mission_id, triggered_via, created_at, started_at, finished_at, cost_usd, tokens_in, tokens_out, action_count, error_message")
        .in("agent_id", agentIds).is("parent_run_id", null).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(5000);
      if (error) throw new Error(error.message);
      return (data ?? []) as Run[];
    },
  });

  const now = Date.now();
  const start = now - days * DAY;
  const filtered = useMemo(() => (allRuns ?? []).filter((r) =>
    (agentFilter === "all" || r.agent_id === agentFilter) && (via === "all" || r.triggered_via === via),
  ), [allRuns, agentFilter, via]);
  const current = filtered.filter((r) => Date.parse(r.created_at) >= start);
  const previous = filtered.filter((r) => Date.parse(r.created_at) < start);
  const cur = summarize(current);
  const prev = summarize(previous);

  const buckets = useMemo(() => {
    const bs = makeBuckets(days, now);
    const step = days === 1 ? HOUR : DAY;
    for (const r of current) {
      const t = Date.parse(r.created_at);
      const i = bs.findIndex((b) => t >= b.t && t < b.t + step);
      if (i < 0) continue;
      const b = bs[i];
      b.runs++;
      if (r.status === "succeeded") b.ok++; else if (r.status === "failed") b.fail++; else b.other++;
      b.cost += Number(r.cost_usd ?? 0);
      b.tokens += Number(r.tokens_in ?? 0) + Number(r.tokens_out ?? 0);
      b.actions += Number(r.action_count ?? 0);
    }
    return bs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.length, days, allRuns, agentFilter, via]);

  const successSeries = buckets.map((b) => (b.ok + b.fail ? b.ok / (b.ok + b.fail) : NaN));

  // Par collaborateur : sur la période, avec le filtre déclencheur mais pas
  // celui du collaborateur, pour pouvoir passer de l'un à l'autre.
  const perAgent = useMemo(() => {
    const rows = (allRuns ?? []).filter((r) => Date.parse(r.created_at) >= start && (via === "all" || r.triggered_via === via));
    const map = new Map<string, Run[]>();
    for (const r of rows) map.set(r.agent_id, [...(map.get(r.agent_id) ?? []), r]);
    return agents.map((a) => {
      const rs = map.get(a.id) ?? [];
      const s = summarize(rs);
      const last = rs[0]?.created_at ?? null;
      const spark = makeBuckets(Math.min(days, 30), now).map((b) => {
        const step = days === 1 ? HOUR : DAY;
        return rs.filter((r) => { const t = Date.parse(r.created_at); return t >= b.t && t < b.t + step; }).length;
      });
      return { agent: a, ...s, last, spark };
    }).sort((x, y) => y.runs - x.runs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRuns, agents, via, period]);

  const errors = useMemo(() => {
    const map = new Map<string, { key: string; sample: string; count: number; last: string; agents: Set<string> }>();
    for (const r of current) {
      if (r.status !== "failed" || !r.error_message) continue;
      const k = errorKey(r.error_message);
      const e = map.get(k) ?? { key: k, sample: r.error_message, count: 0, last: r.created_at, agents: new Set<string>() };
      e.count++;
      if (r.created_at > e.last) e.last = r.created_at;
      e.agents.add(r.agent_id);
      map.set(k, e);
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }, [current]);

  // Jour de la semaine × heure, lundi en premier.
  const heat = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const r of current) {
      const d = new Date(r.created_at);
      grid[(d.getDay() + 6) % 7][d.getHours()]++;
    }
    return grid;
  }, [current]);

  const filtersOn = agentFilter !== "all" || via !== "all";
  const filteredAgent = agentFilter !== "all" ? agentById.get(agentFilter) : undefined;
  const periodLabel = period === "1" ? "24 h" : `${period} jours`;

  return (
    <div className="space-y-2">
      {/* Les filtres : une seule rangée, au-dessus de tout ce qu'ils pilotent. */}
      <div className="flex flex-wrap items-center gap-2 pb-1">
        <h3 className="mr-1 text-[14px] font-semibold">Vue d'ensemble</h3>
        <Tabs
          value={period}
          onChange={(v) => setPeriod(v)}
          options={[{ key: "1", label: "24 h" }, { key: "7", label: "7 j" }, { key: "30", label: "30 j" }, { key: "90", label: "90 j" }]}
        />
        <label className="relative inline-flex items-center">
          <FunnelSimpleIcon className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="h-7 rounded-md border border-border bg-background pl-7 pr-2 text-12 focus:outline-none focus:ring-2 focus:ring-ring/20"
            aria-label="Collaborateur"
          >
            <option value="all">Tous les collaborateurs</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <Tabs
          value={via}
          onChange={(v) => setVia(v)}
          options={[{ key: "all", label: "Tout" }, { key: "schedule", label: "Planifié" }, { key: "manual", label: "Manuel" }, { key: "api", label: "API" }]}
        />
        {filtersOn && (
          <button
            type="button" onClick={() => { setAgentFilter("all"); setVia("all"); }}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-12 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-3 w-3" /> Réinitialiser
          </button>
        )}
        <span className="ml-auto text-11 text-muted-foreground">
          {isLoading ? "Chargement…" : `${fmtInt(cur.runs)} runs sur ${periodLabel}${filteredAgent ? ` · ${filteredAgent.name}` : ""}`}
        </span>
      </div>

      {/* Indicateurs, chacun avec sa tendance et sa courbe. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
        <Kpi label="Runs" value={fmtInt(cur.runs)} cur={cur.runs} prev={prev.runs} spark={buckets.map((b) => b.runs)} />
        <Kpi
          label="Taux de réussite" value={Number.isNaN(cur.success) ? "-" : `${Math.round(cur.success * 100)} %`}
          cur={cur.success} prev={prev.success} spark={successSeries} goodWhenUp
        />
        <Kpi label="Échecs" value={fmtInt(cur.failed)} cur={cur.failed} prev={prev.failed} spark={buckets.map((b) => b.fail)} goodWhenUp={false} />
        <Kpi label="Coût" value={fmtUsd(cur.cost)} cur={cur.cost} prev={prev.cost} spark={buckets.map((b) => b.cost)} goodWhenUp={false} />
        <Kpi label="Tokens" value={fmtInt(cur.tokens)} cur={cur.tokens} prev={prev.tokens} spark={buckets.map((b) => b.tokens)} />
        <Kpi label="Actions outillées" value={fmtInt(cur.actions)} cur={cur.actions} prev={prev.actions} spark={buckets.map((b) => b.actions)} />
        <Kpi label="Durée médiane" value={fmtDuration(cur.duration)} cur={cur.duration} prev={prev.duration} goodWhenUp={false} />
      </div>

      <div className="grid gap-2 xl:grid-cols-3">
        <Panel className="xl:col-span-2" title="Activité" hint={days === 1 ? "par heure" : "par jour"}
          legend={[{ color: C_OK, label: "Réussis" }, { color: C_FAIL, label: "Échoués" }, { color: C_OTHER, label: "Autres" }]}
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap={days > 30 ? 1 : "20%"}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} tick={{ fontSize: 11, fill: "#898781" }} interval="preserveStartEnd" minTickGap={18} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#898781" }} width={40} />
                <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }} content={<ChartTip rows={[["ok", "Réussis", C_OK], ["fail", "Échoués", C_FAIL], ["other", "Autres", C_OTHER]]} />} />
                <Bar dataKey="ok" stackId="s" fill={C_OK} stroke="hsl(var(--card))" strokeWidth={1} />
                <Bar dataKey="fail" stackId="s" fill={C_FAIL} stroke="hsl(var(--card))" strokeWidth={1} />
                <Bar dataKey="other" stackId="s" fill={C_OTHER} stroke="hsl(var(--card))" strokeWidth={1} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Reminders dashboardId={dashboardId} agents={agentById} onOpenIssue={onOpenIssue} onOpenAgent={(id) => navigate(`${base}/agent/${id}`)} />
      </div>

      <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
        <Panel title="Par collaborateur" hint="cliquer pour filtrer">
          {perAgent.length === 0 ? <Empty>Aucun collaborateur.</Empty> : (
            <ul className="space-y-1">
              {perAgent.slice(0, 8).map((p) => {
                const max = Math.max(1, ...perAgent.map((x) => x.runs));
                const on = agentFilter === p.agent.id;
                const okRuns = p.runs - p.failed;
                return (
                  <li key={p.agent.id}>
                    <button
                      type="button"
                      onClick={() => setAgentFilter(on ? "all" : p.agent.id)}
                      title={`${p.agent.name} : ${p.runs} runs, ${p.failed} en échec, ${fmtUsd(p.cost)}`}
                      className={cn("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted/60", on && "bg-muted")}
                    >
                      <AgentDot agent={p.agent} />
                      <span className="w-28 shrink-0 truncate text-12">{p.agent.name}</span>
                      <span className="flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted/50">
                        <span style={{ width: `${(okRuns / max) * 100}%`, background: C_OK }} />
                        <span style={{ width: `${(p.failed / max) * 100}%`, background: C_FAIL }} className={okRuns ? "border-l-2 border-card" : ""} />
                      </span>
                      <span className="w-9 shrink-0 text-right text-12 tabular-nums">{p.runs}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Coût" hint={`${fmtUsd(cur.cost)} sur ${periodLabel}`}>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="sd-cost" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={C_SERIES} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={C_SERIES} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} tick={{ fontSize: 11, fill: "#898781" }} interval="preserveStartEnd" minTickGap={18} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#898781" }} width={48} tickFormatter={(v: number) => `$${v < 1 ? v.toFixed(2) : Math.round(v)}`} />
                <Tooltip cursor={{ stroke: "#898781", strokeDasharray: "3 3" }} content={<ChartTip rows={[["cost", "Coût", C_SERIES]]} format={fmtUsd} />} />
                <Area type="monotone" dataKey="cost" stroke={C_SERIES} strokeWidth={2} fill="url(#sd-cost)" activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Heures actives" hint="runs par jour et par heure" className="lg:col-span-2 xl:col-span-1">
          <Heatmap grid={heat} />
        </Panel>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="Erreurs fréquentes" hint={cur.failed ? `${cur.failed} échecs` : undefined}>
          {errors.length === 0 ? <Empty>Aucune erreur sur la période.</Empty> : (
            <ul className="divide-y divide-border/60">
              {errors.map((e) => {
                const first = [...e.agents][0];
                return (
                  <li key={e.key}>
                    <button
                      type="button"
                      onClick={() => first && navigate(`${base}/agent/${first}`)}
                      title={e.sample}
                      className="flex w-full items-start gap-2.5 px-1 py-2 text-left hover:bg-muted/40"
                    >
                      <WarningCircleIcon weight="fill" className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: C_FAIL }} />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 break-all font-mono text-[11.5px] leading-snug">{e.sample.slice(0, 220)}</span>
                        <span className="mt-0.5 block text-11 text-muted-foreground">
                          {[...e.agents].map((id) => agentById.get(id)?.name ?? "?").join(", ")} · {formatRelative(e.last)}
                        </span>
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-11 font-medium tabular-nums">×{e.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Collaborateurs" hint={`${agents.length} dans le service`}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
            {perAgent.map((p) => (
              <AgentCard
                key={p.agent.id}
                p={p}
                active={agentFilter === p.agent.id}
                onFilter={() => setAgentFilter(agentFilter === p.agent.id ? "all" : p.agent.id)}
                onOpen={() => navigate(`${base}/agent/${p.agent.id}`)}
              />
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function Panel({ title, hint, legend, className, children }: {
  title: string; hint?: string; legend?: { color: string; label: string }[]; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-md border border-border/70 bg-card p-3", className)}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-13 font-medium">{title}</h4>
        {hint && <span className="text-11 text-muted-foreground">{hint}</span>}
        {legend && (
          <span className="ml-auto flex items-center gap-3">
            {legend.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1.5 text-11 text-muted-foreground">
                <span className="h-2 w-2 rounded-sm" style={{ background: l.color }} /> {l.label}
              </span>
            ))}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-12 text-muted-foreground">{children}</p>;
}

function Kpi({ label, value, cur, prev, spark, goodWhenUp = true }: {
  label: string; value: string; cur: number; prev: number; spark?: number[]; goodWhenUp?: boolean;
}) {
  const hasDelta = Number.isFinite(cur) && Number.isFinite(prev) && prev > 0;
  const delta = hasDelta ? (cur - prev) / prev : 0;
  const up = delta > 0;
  const good = up === goodWhenUp;
  const flat = !hasDelta || Math.abs(delta) < 0.005;
  return (
    <div className="flex flex-col rounded-md border border-border/70 bg-card px-3 py-2.5">
      <span className="text-12 text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="text-[22px] font-semibold leading-none tabular-nums tracking-tight">{value}</span>
        {spark && <Sparkline values={spark} />}
      </div>
      <span className={cn(
        "mt-1.5 inline-flex items-center gap-0.5 text-11",
        flat ? "text-muted-foreground" : good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
      )}>
        {!flat && (up ? <ArrowUpRightIcon className="h-3 w-3" /> : <ArrowDownRightIcon className="h-3 w-3" />)}
        {hasDelta ? `${flat ? "stable" : `${up ? "+" : ""}${Math.round(delta * 100)} %`}` : "pas de référence"}
        <span className="ml-1 text-muted-foreground">vs période précédente</span>
      </span>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const pts = values.map((v, i) => [i, Number.isFinite(v) ? v : 0] as const);
  const max = Math.max(...pts.map((p) => p[1]), 0);
  if (pts.length < 2 || max === 0) return <span className="h-6 w-16" />;
  const w = 64, h = 24;
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0 overflow-visible" aria-hidden>
      <path d={d} fill="none" stroke={C_SERIES} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

type TipRow = [key: string, label: string, color: string];
function ChartTip({ active, payload, rows, format = fmtInt }: {
  active?: boolean; payload?: Array<{ payload: Bucket }>; rows: TipRow[]; format?: (n: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  const d = new Date(b.t);
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-2 text-12 shadow-md">
      <p className="mb-1 font-medium">
        {b.label.endsWith("h")
          ? d.toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" })
          : d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
      </p>
      {rows.map(([k, label, color]) => (
        <p key={k} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
          <span className="text-muted-foreground">{label}</span>
          <span className="ml-auto pl-3 tabular-nums">{format(Number((b as unknown as Record<string, number>)[k] ?? 0))}</span>
        </p>
      ))}
    </div>
  );
}

const DOW = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

function Heatmap({ grid }: { grid: number[][] }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const max = Math.max(1, ...grid.flat());
  const total = grid.flat().reduce((s, x) => s + x, 0);
  return (
    <div>
      <div className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] gap-[2px]">
        {grid.map((row, d) => (
          <div key={d} className="contents">
            <span className="self-center text-[10px] text-muted-foreground">{DOW[d]}</span>
            {row.map((v, h) => (
              <span
                key={h}
                onMouseEnter={() => setHover({ d, h })}
                onMouseLeave={() => setHover(null)}
                className={cn("aspect-square rounded-[2px]", hover?.d === d && hover?.h === h && "ring-1 ring-foreground")}
                style={{ background: v ? C_SERIES : "hsl(var(--muted))", opacity: v ? 0.2 + 0.8 * (v / max) : 0.6 }}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[9px] text-muted-foreground">{h % 6 === 0 ? h : ""}</span>
        ))}
      </div>
      <p className="mt-2 h-4 text-11 text-muted-foreground">
        {hover
          ? `${DOW[hover.d]} ${hover.h}h-${hover.h + 1}h : ${grid[hover.d][hover.h]} run${grid[hover.d][hover.h] > 1 ? "s" : ""}`
          : total ? `${total} runs, plus foncé = plus actif` : "Aucune activité sur la période."}
      </p>
    </div>
  );
}

function AgentDot({ agent }: { agent: LiteAgent }) {
  return <AgentIdentity url={agent.avatar_url ?? null} seed={agent.name} size={18} rounded="rounded-full" interactive={false} />;
}

function AgentCard({ p, active, onFilter, onOpen }: {
  p: { agent: LiteAgent; runs: number; success: number; cost: number; failed: number; last: string | null; spark: number[] };
  active: boolean; onFilter: () => void; onOpen: () => void;
}) {
  return (
    <div className={cn("group flex flex-col rounded-md border bg-background/40 p-2.5 transition-colors", active ? "border-primary/60" : "border-border/70 hover:border-foreground/20")}>
      <div className="flex items-center gap-2">
        <AgentIdentity url={p.agent.avatar_url ?? null} seed={p.agent.name} size={22} rounded="rounded-full" interactive={false} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-12 font-medium hover:underline">{p.agent.name}</button>
        <button
          type="button" onClick={onFilter} title={active ? "Retirer le filtre" : "Filtrer la vue sur ce collaborateur"}
          className={cn("rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground", active && "text-primary")}
        >
          <FunnelSimpleIcon weight={active ? "fill" : "regular"} className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-11">
        <Stat label="Runs" value={fmtInt(p.runs)} />
        <Stat label="Réussite" value={Number.isNaN(p.success) ? "-" : `${Math.round(p.success * 100)} %`} warn={!Number.isNaN(p.success) && p.success < 0.7} />
        <Stat label="Coût" value={fmtUsd(p.cost)} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-11 text-muted-foreground">{p.last ? `Actif ${formatRelative(p.last)}` : "Inactif sur la période"}</span>
        <Sparkline values={p.spark} />
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span className="min-w-0">
      <span className="block text-muted-foreground">{label}</span>
      <span className={cn("block truncate text-12 font-medium tabular-nums", warn && "text-red-600 dark:text-red-400")}>{value}</span>
    </span>
  );
}

/* ── Rappels ─────────────────────────────────────────────────────────────── */

interface Reminder { id: string; title: string; due_at: string | null; done_at: string | null; created_at: string }

type ReminderEntry = {
  key: string; kind: "mine" | "mission" | "due"; at: string | null; title: string; sub: string;
  late: boolean; onClick?: () => void; reminder?: Reminder;
};

const REMINDER_ICON: Record<ReminderEntry["kind"], PhosphorIcon> = { mine: BellIcon, mission: ClockIcon, due: CalendarBlankIcon };

function whenLabel(iso: string | null) {
  if (!iso) return "Sans date";
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / DAY);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const showTime = time !== "00:00";
  if (diff === 0) return showTime ? `Aujourd'hui ${time}` : "Aujourd'hui";
  if (diff === 1) return showTime ? `Demain ${time}` : "Demain";
  if (diff === -1) return "Hier";
  if (diff < 0) return `Il y a ${-diff} j`;
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) + (showTime ? ` ${time}` : "");
}

function Reminders({ dashboardId, agents, onOpenIssue, onOpenAgent }: {
  dashboardId: string;
  agents: Map<string, LiteAgent>;
  onOpenIssue?: (projectId: string, issueId: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<"all" | "mine" | "mission" | "due">("all");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const agentIds = [...agents.keys()];

  const mine = useQuery({
    queryKey: ["sd_home_reminders", dashboardId],
    queryFn: async () => {
      const { data, error } = await supabase.from("sd_home_reminders")
        .select("id, title, due_at, done_at, created_at")
        .eq("dashboard_id", dashboardId).is("done_at", null)
        .order("due_at", { ascending: true, nullsFirst: false }).limit(50);
      // Table absente tant que 0306 n'est pas appliquée : on le dit, sans casser.
      if (error) return { rows: [] as Reminder[], unavailable: true };
      return { rows: (data ?? []) as Reminder[], unavailable: false };
    },
  });

  const missions = useQuery({
    queryKey: ["sd_home_upcoming_missions", dashboardId, agentIds.join(",")],
    enabled: agentIds.length > 0,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const until = new Date(Date.now() + 7 * DAY).toISOString();
      const { data } = await supabase.from("internal_agent_missions")
        .select("id, title, agent_id, next_run_at, schedule")
        .in("agent_id", agentIds).eq("status", "active").not("next_run_at", "is", null).lte("next_run_at", until)
        .order("next_run_at", { ascending: true }).limit(12);
      return (data ?? []) as Array<{ id: string; title: string; agent_id: string; next_run_at: string; schedule: string | null }>;
    },
  });

  const work = useQuery({
    queryKey: ["pj_my_work", dashboardId],
    queryFn: () => fetchMyWork(dashboardId),
  });

  const now = Date.now();
  const SCHEDULE: Record<string, string> = { hourly: "toutes les heures", daily: "chaque jour", weekly: "chaque semaine", monthly: "chaque mois" };
  const entries: ReminderEntry[] = [
    ...(mine.data?.rows ?? []).map((r) => ({
      key: `m-${r.id}`, kind: "mine" as const, at: r.due_at, title: r.title, sub: "Rappel personnel",
      late: !!r.due_at && Date.parse(r.due_at) < now, reminder: r,
    })),
    ...(missions.data ?? []).map((m) => ({
      key: `s-${m.id}`, kind: "mission" as const, at: m.next_run_at, title: m.title,
      sub: `${agents.get(m.agent_id)?.name ?? "Collaborateur"}${m.schedule ? ` · ${SCHEDULE[m.schedule] ?? m.schedule}` : ""}`,
      late: Date.parse(m.next_run_at) < now - 15 * 60_000,
      onClick: () => onOpenAgent(m.agent_id),
    })),
    ...(work.data ?? [])
      .filter((w) => w.target_date && !w.completed_at && w.state_group !== "completed" && w.state_group !== "cancelled"
        && Date.parse(w.target_date) < now + 7 * DAY)
      .map((w) => ({
        key: `w-${w.issue_id}`, kind: "due" as const, at: w.target_date, title: w.name,
        sub: `${w.identifier}-${w.sequence_id} · ${w.project_name}`,
        late: w.target_date!.slice(0, 10) < new Date().toISOString().slice(0, 10),
        onClick: onOpenIssue ? () => onOpenIssue(w.pj_project_id, w.issue_id) : undefined,
      })),
  ].sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));

  const shown = tab === "all" ? entries : entries.filter((e) => e.kind === tab);
  const late = entries.filter((e) => e.late).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ["sd_home_reminders", dashboardId] });

  async function add() {
    const t = title.trim();
    if (!t) return;
    const { error } = await supabase.from("sd_home_reminders").insert({
      dashboard_id: dashboardId, title: t, due_at: due ? new Date(due).toISOString() : null,
    });
    if (error) { toast.error("Rappel impossible à créer", error.message); return; }
    setTitle(""); setDue(""); setAdding(false);
    refresh();
  }
  async function complete(r: Reminder) {
    await supabase.from("sd_home_reminders").update({ done_at: new Date().toISOString() }).eq("id", r.id);
    refresh();
  }
  async function remove(r: Reminder) {
    await supabase.from("sd_home_reminders").delete().eq("id", r.id);
    refresh();
  }

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border/70 bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-13 font-medium">Rappels</h4>
        {late > 0 && (
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-11 font-medium text-red-700 dark:text-red-400">{late} en retard</span>
        )}
        <button
          type="button" onClick={() => setAdding((v) => !v)} disabled={mine.data?.unavailable}
          title={mine.data?.unavailable ? "Rappels personnels indisponibles (migration 0306)" : "Nouveau rappel"}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-12 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" /> Ajouter
        </button>
      </div>

      <Tabs
        className="mb-2 self-start"
        value={tab}
        onChange={setTab}
        options={[
          { key: "all", label: "Tout", count: entries.length },
          { key: "mine", label: "Les miens", count: entries.filter((e) => e.kind === "mine").length },
          { key: "mission", label: "Planifiés", count: entries.filter((e) => e.kind === "mission").length },
          { key: "due", label: "Échéances", count: entries.filter((e) => e.kind === "due").length },
        ]}
      />

      {adding && (
        <form
          onSubmit={(e) => { e.preventDefault(); void add(); }}
          className="mb-2 space-y-1.5 rounded-md border border-border bg-background p-2"
        >
          <input
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }}
            placeholder="Relancer le client, relire un livrable…"
            className="h-7 w-full rounded border border-border bg-transparent px-2 text-12 focus:outline-none focus:ring-2 focus:ring-ring/20"
          />
          <div className="flex items-center gap-1.5">
            <input
              type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-12 [color-scheme:light] dark:[color-scheme:dark]"
            />
            <button type="submit" disabled={!title.trim()} className="h-7 rounded bg-primary px-2.5 text-12 font-medium text-primary-foreground disabled:opacity-50">
              Ajouter
            </button>
          </div>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ maxHeight: 236 }}>
        {shown.length === 0 ? (
          <Empty>{tab === "mine" && mine.data?.unavailable ? "Rappels personnels bientôt disponibles." : "Rien de prévu sur les 7 prochains jours."}</Empty>
        ) : (
          <ul className="space-y-0.5">
            {shown.map((e) => {
              const Icon = REMINDER_ICON[e.kind];
              return (
                <li key={e.key} className="group flex items-center gap-2 rounded px-1.5 py-1.5 hover:bg-muted/50">
                  {e.reminder ? (
                    <button
                      type="button" onClick={() => void complete(e.reminder!)} title="Marquer comme fait"
                      className="grid h-4 w-4 shrink-0 place-items-center rounded border border-border text-transparent hover:border-primary hover:text-primary"
                    >
                      <CheckIcon className="h-3 w-3" />
                    </button>
                  ) : (
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <button
                    type="button" onClick={e.onClick} disabled={!e.onClick}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                  >
                    <span className="block truncate text-12 font-medium">{e.title}</span>
                    <span className="block truncate text-11 text-muted-foreground">{e.sub}</span>
                  </button>
                  <span className={cn("shrink-0 text-11 tabular-nums", e.late ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                    {whenLabel(e.at)}
                  </span>
                  {e.reminder ? (
                    <button
                      type="button" onClick={() => void remove(e.reminder!)} title="Supprimer"
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  ) : e.onClick ? (
                    <ArrowRightIcon className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
