// HQ analytics — derivations that turn the internal-agent tables into the AI HQ
// dashboard's advanced stats. Everything is computed client-side from a handful
// of bounded fetches; the range selector only re-buckets, no new round-trips.
import { supabase } from "@/lib/supabase";
import { makeBuckets, type Bucket, type RangeKey } from "@/features/crm/overview/crmStats";

export type { RangeKey };

// ────────────────────────────────────────────────────────────── row shapes

export interface HqAgent {
  id: string; name: string; description: string | null;
  avatar_emoji: string | null; avatar_url: string | null;
  avatar_style: "avatar" | "orb" | null; accent_color: string | null;
  chat_enabled: boolean; mission_enabled: boolean;
  is_archived: boolean | null;
  /** Service dashboard this agent belongs to (0133), null = unassigned. */
  service_dashboard_id: string | null;
  /** Folder inside that service (0161). */
  folder_id: string | null;
  created_at: string;
}

export interface HqMission {
  id: string; agent_id: string; title: string; status: string;
  schedule: string | null; priority: string | null; created_at: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface HqRun {
  id: string; mission_id: string | null; agent_id: string;
  status: RunStatus;
  run_kind: string | null; label: string | null;
  tokens_in: number; tokens_out: number; cost_usd: number; action_count: number;
  error_message: string | null;
  triggered_via: string | null;
  started_at: string | null; finished_at: string | null; created_at: string;
}

export interface HqApproval {
  id: string; agent_id: string; run_id: string | null; tool_name: string;
  action_kind: string; status: string; reason: string | null;
  requested_at: string; decided_at: string | null;
}

export interface HqDeliverable {
  id: string; agent_id: string; run_id: string | null; kind: string;
  name: string; created_at: string;
}

/** A parsed `loop` run event — one row per controller decision (see
 *  _shared/agent-loop.ts loopEventPayload). */
export interface LoopDecisionEvent {
  run_id: string; agent_id: string; created_at: string;
  iteration: number; action: string; reason: string; escalated: boolean;
  loopDetected: boolean; stagnantTicks: number; errors: number;
  replans: number; maxReplans: number; brokenTools: string[];
}

// ────────────────────────────────────────────────────────────── data access

const RUN_SELECT =
  "id, mission_id, agent_id, status, run_kind, label, tokens_in, tokens_out, cost_usd, action_count, error_message, triggered_via, started_at, finished_at, created_at";

/** Restricts a project-wide query to one service dashboard's agents. `null`
 *  means "no scope" (the whole project); an EMPTY array means "a scope that
 *  matches nothing" and callers must skip the query entirely. */
export type AgentScope = string[] | null;

export async function fetchHqAgents(projectId: string, dashboardId?: string | null): Promise<HqAgent[]> {
  let q = supabase
    .from("internal_agents")
    .select("id, name, description, avatar_emoji, avatar_url, avatar_style, accent_color, chat_enabled, mission_enabled, is_archived, service_dashboard_id, folder_id, created_at")
    .eq("project_id", projectId);
  if (dashboardId) q = q.eq("service_dashboard_id", dashboardId);
  const { data } = await q.order("created_at", { ascending: false });
  return (data ?? []) as HqAgent[];
}

export async function fetchHqRuns(projectId: string, scope: AgentScope = null, limit = 800): Promise<HqRun[]> {
  if (scope?.length === 0) return [];
  let q = supabase.from("internal_agent_runs").select(RUN_SELECT).eq("project_id", projectId);
  if (scope) q = q.in("agent_id", scope);
  // Newest first so the cap keeps the RECENT window (ordering ascending with a
  // limit handed back the project's oldest runs — the charts then rendered a
  // flat, empty period for any workspace past the cap).
  const { data } = await q.order("created_at", { ascending: false }).limit(limit);
  return ((data ?? []) as HqRun[]).reverse();
}

export async function fetchHqMissions(projectId: string, scope: AgentScope = null): Promise<HqMission[]> {
  if (scope?.length === 0) return [];
  let q = supabase
    .from("internal_agent_missions")
    .select("id, agent_id, title, status, schedule, priority, created_at")
    .eq("project_id", projectId);
  if (scope) q = q.in("agent_id", scope);
  const { data } = await q.order("created_at", { ascending: false });
  return (data ?? []) as HqMission[];
}

// deliverables / run_events have no project_id → scope them by the project's agents.
export async function fetchHqDeliverables(projectId: string, agentIds: string[], limit = 400): Promise<HqDeliverable[]> {
  if (agentIds.length === 0) return [];
  const { data } = await supabase
    .from("internal_agent_deliverables")
    .select("id, agent_id, run_id, kind, name, created_at")
    .in("agent_id", agentIds).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as HqDeliverable[];
}

export async function fetchHqApprovals(projectId: string, scope: AgentScope = null, limit = 500): Promise<HqApproval[]> {
  if (scope?.length === 0) return [];
  let q = supabase
    .from("internal_agent_approvals")
    .select("id, agent_id, run_id, tool_name, action_kind, status, reason, requested_at, decided_at")
    .eq("project_id", projectId);
  if (scope) q = q.in("agent_id", scope);
  const { data } = await q.order("requested_at", { ascending: false }).limit(limit);
  return (data ?? []) as HqApproval[];
}

function parseLoopEvent(e: { run_id: string; agent_id: string; payload: Record<string, unknown>; created_at: string }): LoopDecisionEvent | null {
  const p = e.payload ?? {};
  const s = (p.signals ?? {}) as Record<string, unknown>;
  const broken = Array.isArray(s.broken_tools) ? s.broken_tools.map(String) : [];
  const replans = String(s.replans ?? "0/0").split("/");
  return {
    run_id: e.run_id,
    agent_id: e.agent_id,
    created_at: e.created_at,
    iteration: Number(p.iteration) || 0,
    action: String(p.action ?? "continue"),
    reason: String(p.reason ?? ""),
    escalated: p.escalated === true,
    loopDetected: s.loop_detected === true,
    stagnantTicks: Number(s.stagnant_ticks) || 0,
    errors: Number(s.errors) || 0,
    replans: Number(replans[0]) || 0,
    maxReplans: Number(replans[1]) || 0,
    brokenTools: broken,
  };
}

export async function fetchHqLoopEvents(projectId: string, agentIds: string[], limit = 400): Promise<LoopDecisionEvent[]> {
  if (agentIds.length === 0) return [];
  const { data } = await supabase
    .from("internal_agent_run_events")
    .select("run_id, agent_id, payload, created_at")
    .in("agent_id", agentIds).eq("kind", "loop").order("created_at", { ascending: false }).limit(limit);
  return (data ?? [])
    .map((e) => parseLoopEvent(e as { run_id: string; agent_id: string; payload: Record<string, unknown>; created_at: string }))
    .filter((x): x is LoopDecisionEvent => x != null);
}

// ────────────────────────────────────────────────────────────── helpers

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "30d", label: "30 derniers jours" },
  { key: "90d", label: "90 derniers jours" },
  { key: "12m", label: "12 derniers mois" },
];

const pct = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 100));

export function fmtUsd(v: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 1 ? 4 : 2 }).format(v);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function runDurationSec(r: HqRun): number | null {
  if (!r.started_at || !r.finished_at) return null;
  const d = (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000;
  return d >= 0 ? d : null;
}

/** Count items per time bucket (for a metric's curve over the range). */
export function bucketCounts<T>(
  items: T[],
  range: RangeKey,
  getDate: (x: T) => string,
  test?: (x: T) => boolean,
  now: Date = new Date(),
): number[] {
  const buckets = makeBuckets(range, now);
  return buckets.map((b) => {
    const t0 = b.start, t1 = b.end;
    let n = 0;
    for (const it of items) {
      const t = +new Date(getDate(it));
      if (t >= t0 && t < t1 && (!test || test(it))) n++;
    }
    return n;
  });
}

/** The [from, to) instants a range covers — aligned on the SAME bucket grid the
 *  charts use, so a KPI and its curve never disagree by a few hours. */
export function windowOf(range: RangeKey, now: Date = new Date()): { from: number; to: number } {
  const buckets = makeBuckets(range, now);
  return { from: buckets[0]?.start ?? 0, to: buckets[buckets.length - 1]?.end ?? Date.now() };
}

/** The window of equal length immediately before `windowOf(range)`. */
export function previousWindowOf(range: RangeKey, now: Date = new Date()): { from: number; to: number } {
  const { from, to } = windowOf(range, now);
  const span = to - from;
  return { from: from - span, to: from };
}

export function inRange(iso: string, w: { from: number; to: number }): boolean {
  const t = +new Date(iso);
  return t >= w.from && t < w.to;
}

/** Period-over-period variation in %, null when there is no baseline. */
export function delta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

// ────────────────────────────────────────────────────────── performance series

export interface PerfPoint {
  key: string;
  tick: string;
  full: string;
  runs: number;
  succeeded: number;
  failed: number;
  ongoing: number;
  costUsd: number;
  cumCostUsd: number;
  tokens: number;
  actions: number;
  avgDurationSec: number | null;
}

const inWindow = (r: HqRun, b: Bucket) => {
  const t = +new Date(r.created_at);
  return t >= b.start && t < b.end;
};

export function buildPerfSeries(runs: HqRun[], range: RangeKey, now: Date = new Date()): PerfPoint[] {
  const buckets = makeBuckets(range, now);
  let cum = 0;
  const ended: HqRun[] = [];
  return buckets.map((b, i) => {
    const rs = runs.filter((r) => inWindow(r, b));
    const succeeded = rs.filter((r) => r.status === "succeeded").length;
    const failed = rs.filter((r) => r.status === "failed").length;
    const ongoing = rs.filter((r) => r.status === "queued" || r.status === "running" || r.status === "cancelled").length;
    const costUsd = rs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    cum += costUsd;
    const tokens = rs.reduce((s, r) => s + (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0), 0);
    const actions = rs.reduce((s, r) => s + (Number(r.action_count) || 0), 0);
    ended.push(...rs);
    const durs = ended.map(runDurationSec).filter((d): d is number => d != null);
    return {
      key: `b${i}`,
      tick: b.tick,
      full: b.full,
      runs: rs.length,
      succeeded,
      failed,
      ongoing,
      costUsd,
      cumCostUsd: cum,
      tokens,
      actions,
      avgDurationSec: durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null,
    };
  });
}

export interface RunHeadline {
  runs: number;
  succeeded: number;
  failed: number;
  ongoing: number;
  successRate: number | null;
  totalCost: number;
  avgCost: number;
  totalTokens: number;
  totalActions: number;
  avgDurationSec: number | null;
}

export function runHeadline(runs: HqRun[]): RunHeadline {
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const ongoing = runs.filter((r) => r.status === "queued" || r.status === "running" || r.status === "cancelled").length;
  const ended = succeeded + failed;
  const durs = runs.map(runDurationSec).filter((d): d is number => d != null);
  return {
    runs: runs.length,
    succeeded,
    failed,
    ongoing,
    successRate: pct(succeeded, ended),
    totalCost: runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0),
    avgCost: runs.length ? runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) / runs.length : 0,
    totalTokens: runs.reduce((s, r) => s + (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0), 0),
    totalActions: runs.reduce((s, r) => s + (Number(r.action_count) || 0), 0),
    avgDurationSec: durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null,
  };
}

// ────────────────────────────────────────────────────────────── volume & sources

export interface SourceSlice { label: string; key: string; value: number }
export interface MissionPerf { id: string; title: string; status: string; runs: number; succeeded: number; lastRunAt: string | null }

export function sourceBreakdown(runs: HqRun[]): SourceSlice[] {
  const labels: Record<string, string> = {
    manual: "Manuel", schedule: "Planifié", api: "API", chat: "Chat",
  };
  const counts = new Map<string, number>();
  for (const r of runs) {
    const k = r.triggered_via || "unknown";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, label: labels[key] ?? key, value }))
    .sort((a, b) => b.value - a.value);
}

export function missionFunnel(missions: HqMission[], runs: HqRun[], range: RangeKey, now: Date = new Date()): {
  byStatus: { status: string; count: number }[];
  scheduled: number;
  perMission: MissionPerf[];
} {
  const buckets = makeBuckets(range, now);
  const from = buckets[0]?.start ?? 0;
  const to = buckets[buckets.length - 1]?.end ?? Infinity;
  const byStatusMap = new Map<string, number>();
  for (const m of missions) byStatusMap.set(m.status, (byStatusMap.get(m.status) ?? 0) + 1);
  const byStatus = [...byStatusMap.entries()].map(([status, count]) => ({ status, count }));
  const scheduled = missions.filter((m) => m.schedule && m.status === "active").length;

  const perMission = missions.map((m) => {
    const mine = runs.filter((r) => r.mission_id === m.id);
    const windowed = mine.filter((r) => {
      const t = +new Date(r.created_at);
      return t >= from && t < to;
    });
    const last = mine.reduce<string | null>((acc, r) =>
      r.created_at > (acc ?? "") ? r.created_at : acc, null);
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      runs: windowed.length,
      succeeded: windowed.filter((r) => r.status === "succeeded").length,
      lastRunAt: last,
    };
  }).sort((a, b) => b.runs - a.runs);

  return { byStatus, scheduled, perMission };
}

// ────────────────────────────────────────────────────────── per-agent productivity

export interface AgentProductivity {
  agent: HqAgent;
  runs: number;
  succeeded: number;
  successRate: number | null;
  totalCost: number;
  avgCost: number;
  avgDurationSec: number | null;
  totalActions: number;
  deliverables: number;
  pendingApprovals: number;
}

export function computeProductivity(
  agents: HqAgent[],
  runs: HqRun[],
  deliverables: HqDeliverable[],
  approvals: HqApproval[],
): AgentProductivity[] {
  const runsByAgent = new Map<string, HqRun[]>();
  for (const r of runs) {
    const arr = runsByAgent.get(r.agent_id);
    if (arr) arr.push(r); else runsByAgent.set(r.agent_id, [r]);
  }
  const delivByAgent = new Map<string, number>();
  for (const d of deliverables) delivByAgent.set(d.agent_id, (delivByAgent.get(d.agent_id) ?? 0) + 1);
  const pendingByAgent = new Map<string, number>();
  for (const a of approvals) {
    if (a.status !== "pending") continue;
    pendingByAgent.set(a.agent_id, (pendingByAgent.get(a.agent_id) ?? 0) + 1);
  }

  return agents
    .map((agent) => {
      const mine = runsByAgent.get(agent.id) ?? [];
      const ended = mine.filter((r) => r.status === "succeeded" || r.status === "failed");
      const succeeded = mine.filter((r) => r.status === "succeeded").length;
      const totalCost = mine.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
      const durs = mine.map(runDurationSec).filter((d): d is number => d != null);
      return {
        agent,
        runs: mine.length,
        succeeded,
        successRate: pct(succeeded, ended.length),
        totalCost,
        avgCost: mine.length ? totalCost / mine.length : 0,
        avgDurationSec: durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null,
        totalActions: mine.reduce((s, r) => s + (Number(r.action_count) || 0), 0),
        deliverables: delivByAgent.get(agent.id) ?? 0,
        pendingApprovals: pendingByAgent.get(agent.id) ?? 0,
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

// ──────────────────────────────────────────────────────────── approval governance

export interface ApprovalStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
  /** approved+executed ÷ decided */
  approvalRate: number | null;
  /** avg minutes between requested_at and decided_at */
  avgDecisionMin: number | null;
  byStatus: { label: string; value: number }[];
  byTool: { tool: string; total: number; approved: number; rejected: number; pending: number }[];
  byAgent: { agentId: string; total: number; approved: number; rejected: number; pending: number }[];
}

export function computeApprovals(approvals: HqApproval[]): ApprovalStats {
  const status = (s: string) => approvals.filter((a) => a.status === s).length;
  const approved = status("approved") + status("executed");
  const rejected = status("rejected");
  const executed = status("executed");
  const failed = status("failed");
  const decided = approved + rejected;

  let acc = 0, n = 0;
  for (const a of approvals) {
    if (!a.decided_at) continue;
    acc += Math.max(0, (new Date(a.decided_at).getTime() - new Date(a.requested_at).getTime()) / 60000);
    n++;
  }

  const byToolMap = new Map<string, { total: number; approved: number; rejected: number; pending: number }>();
  const byAgentMap = new Map<string, { total: number; approved: number; rejected: number; pending: number }>();
  for (const a of approvals) {
    const t = byToolMap.get(a.tool_name) ?? { total: 0, approved: 0, rejected: 0, pending: 0 };
    t.total++;
    if (a.status === "approved" || a.status === "executed") t.approved++;
    else if (a.status === "rejected") t.rejected++;
    else if (a.status === "pending") t.pending++;
    byToolMap.set(a.tool_name, t);

    const g = byAgentMap.get(a.agent_id) ?? { total: 0, approved: 0, rejected: 0, pending: 0 };
    g.total++;
    if (a.status === "approved" || a.status === "executed") g.approved++;
    else if (a.status === "rejected") g.rejected++;
    else if (a.status === "pending") g.pending++;
    byAgentMap.set(a.agent_id, g);
  }

  return {
    total: approvals.length,
    pending: status("pending"),
    approved: status("approved"),
    rejected,
    executed,
    failed,
    approvalRate: pct(approved, decided),
    avgDecisionMin: n ? Math.round(acc / n) : null,
    byStatus: [
      { label: "Approuvées", value: approved },
      { label: "Rejetées", value: rejected },
      { label: "En attente", value: status("pending") },
      { label: "Échec d'exécution", value: failed },
    ].filter((s) => s.value > 0),
    byTool: [...byToolMap.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.total - a.total).slice(0, 12),
    byAgent: [...byAgentMap.entries()].map(([agentId, v]) => ({ agentId, ...v })).sort((a, b) => b.total - a.total),
  };
}

// ──────────────────────────────────────────────────────────────────── outputs

export interface DeliverableStats {
  total: number;
  byKind: { kind: string; label: string; count: number }[];
  byAgent: { agentId: string; count: number }[];
  /** Deliverables ÷ succeeded runs — how much a successful run actually ships. */
  perRun: number | null;
}

const DELIVERABLE_LABELS: Record<string, string> = {
  markdown: "Document", json: "Données", file: "Fichier", url: "Lien", code: "Code",
  document: "Document", presentation: "Présentation", spreadsheet: "Tableur",
  image: "Image", text: "Texte", report: "Rapport",
};

export function deliverableLabel(kind: string): string {
  return DELIVERABLE_LABELS[kind] ?? kind;
}

export function computeDeliverables(deliverables: HqDeliverable[], runs: HqRun[]): DeliverableStats {
  const byKindMap = new Map<string, number>();
  const byAgentMap = new Map<string, number>();
  for (const d of deliverables) {
    byKindMap.set(d.kind, (byKindMap.get(d.kind) ?? 0) + 1);
    byAgentMap.set(d.agent_id, (byAgentMap.get(d.agent_id) ?? 0) + 1);
  }
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  return {
    total: deliverables.length,
    byKind: [...byKindMap.entries()]
      .map(([kind, count]) => ({ kind, label: deliverableLabel(kind), count }))
      .sort((a, b) => b.count - a.count),
    byAgent: [...byAgentMap.entries()].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count),
    perRun: succeeded ? +(deliverables.length / succeeded).toFixed(1) : null,
  };
}

// ─────────────────────────────────────────────────────────────────── loop health

export interface AgentLoopHealth {
  agentId: string;
  decisions: number;
  replans: number;
  aborts: number;
  loopsDetected: number;
  stagnation: number;
  escalations: number;
}

export interface LoopHealth {
  decisions: number;
  replans: number;
  aborts: number;
  finalizes: number;
  continues: number;
  loopsDetected: number;
  stagnationEvents: number;
  escalations: number;
  errorsInSignals: number;
  avgIterations: number | null;
  perAgent: AgentLoopHealth[];
  failureReasons: { label: string; count: number }[];
}

const STAGNATION_LIMIT = 3;

export function computeLoopHealth(events: LoopDecisionEvent[], failedRuns: HqRun[]): LoopHealth {
  // Per run, keep the LAST decision (chronologically) for the outcome counts;
  // "any" counters accumulate across the run's whole life.
  const lastByRun = new Map<string, LoopDecisionEvent>();
  const anyByRun = new Map<string, { loop: boolean; stagnant: boolean; escalate: boolean; errors: number }>();
  for (const e of events) {
    const prev = lastByRun.get(e.run_id);
    if (!prev || e.created_at > prev.created_at) lastByRun.set(e.run_id, e);
    const acc = anyByRun.get(e.run_id) ?? { loop: false, stagnant: false, escalate: false, errors: 0 };
    acc.loop = acc.loop || e.loopDetected;
    acc.stagnant = acc.stagnant || e.stagnantTicks >= STAGNATION_LIMIT;
    acc.escalate = acc.escalate || e.escalated;
    acc.errors = Math.max(acc.errors, e.errors);
    anyByRun.set(e.run_id, acc);
  }

  let replans = 0, aborts = 0, finalizes = 0, continues = 0;
  for (const e of lastByRun.values()) {
    if (e.action === "replan") replans++;
    else if (e.action === "abort") aborts++;
    else if (e.action === "finalize") finalizes++;
    else continues++;
  }

  let loopsDetected = 0, stagnationEvents = 0, escalations = 0, errorsInSignals = 0, iterSum = 0;
  for (const [runId, acc] of anyByRun) {
    if (acc.loop) loopsDetected++;
    if (acc.stagnant) stagnationEvents++;
    if (acc.escalate) escalations++;
    errorsInSignals += acc.errors;
    iterSum += lastByRun.get(runId)?.iteration ?? 0;
  }

  const perAgentMap = new Map<string, AgentLoopHealth>();
  for (const e of events) {
    const g = perAgentMap.get(e.agent_id) ?? { agentId: e.agent_id, decisions: 0, replans: 0, aborts: 0, loopsDetected: 0, stagnation: 0, escalations: 0 };
    g.decisions++;
    if (e.action === "replan") g.replans++;
    if (e.action === "abort") g.aborts++;
    if (e.loopDetected) g.loopsDetected++;
    if (e.stagnantTicks >= STAGNATION_LIMIT) g.stagnation++;
    if (e.escalated) g.escalations++;
    perAgentMap.set(e.agent_id, g);
  }

  const reasonCounts = new Map<string, number>();
  for (const r of failedRuns) {
    const msg = (r.error_message ?? "").trim();
    if (!msg) { reasonCounts.set("(aucun message)", (reasonCounts.get("(aucun message)") ?? 0) + 1); continue; }
    const first = msg.split("\n")[0].trim();
    const key = first.length > 70 ? `${first.slice(0, 67)}…` : first;
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }

  return {
    decisions: events.length,
    replans,
    aborts,
    finalizes,
    continues,
    loopsDetected,
    stagnationEvents,
    escalations,
    errorsInSignals,
    avgIterations: anyByRun.size ? Math.round(iterSum / anyByRun.size) : null,
    perAgent: [...perAgentMap.values()].sort((a, b) => b.decisions - a.decisions).slice(0, 12),
    failureReasons: [...reasonCounts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}
