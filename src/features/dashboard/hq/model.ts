// One derivation pass for the whole HQ cockpit.
//
// Every tab reads from the same `HqView`: the raw rows are fetched once, the
// window is applied once, and each statistic is computed once — so two tabs can
// never disagree on "how many runs this period", and switching tabs costs no
// recomputation.
import {
  buildPerfSeries, runHeadline, sourceBreakdown, missionFunnel, computeProductivity,
  computeApprovals, computeLoopHealth, computeDeliverables, bucketCounts,
  windowOf, previousWindowOf, inRange, delta,
  type HqAgent, type HqRun, type HqMission, type HqDeliverable, type HqApproval,
  type LoopDecisionEvent, type PerfPoint, type RunHeadline, type AgentProductivity,
  type ApprovalStats, type LoopHealth, type SourceSlice, type DeliverableStats,
} from "../hqStats";
import {
  computeToolUsage, computeKnowledge, computeServices,
  type HqToolEvent, type HqCollection, type HqCollectionSource, type HqCollectionLink,
  type HqRagGrant, type HqService, type ToolUsage, type KnowledgeStats, type ServiceStat,
} from "../hqUsage";
import { makeBuckets, type RangeKey } from "@/features/crm/overview/crmStats";

/** Everything the HQ fetches, unwindowed. */
export interface HqRawData {
  agents: HqAgent[];
  runs: HqRun[];
  missions: HqMission[];
  deliverables: HqDeliverable[];
  approvals: HqApproval[];
  loopEvents: LoopDecisionEvent[];
  toolEvents: HqToolEvent[];
  knowledgeProbes: Array<{ agent_id: string; created_at: string; hit: boolean }>;
  collections: HqCollection[];
  collectionSources: HqCollectionSource[];
  collectionLinks: HqCollectionLink[];
  ragGrants: HqRagGrant[];
  services: HqService[];
}

export interface HqView {
  range: RangeKey;
  labels: string[];
  fullLabels: string[];
  /** Live (non-archived) agents — the roster. */
  agents: HqAgent[];
  /** Every agent incl. archived, so historical rows still resolve a name. */
  allAgents: HqAgent[];
  agentById: Map<string, HqAgent>;
  agentName: (id: string) => string;

  runs: HqRun[];
  missions: HqMission[];
  deliverables: HqDeliverable[];
  approvals: HqApproval[];
  loopEvents: LoopDecisionEvent[];
  toolEvents: HqToolEvent[];

  series: PerfPoint[];
  headline: RunHeadline;
  /** Same headline over the preceding window — the source of every delta. */
  previous: RunHeadline;
  deltas: {
    runs: number | null; successRate: number | null; cost: number | null;
    tokens: number | null; actions: number | null; duration: number | null;
    deliverables: number | null; toolCalls: number | null;
  };

  sources: SourceSlice[];
  funnel: ReturnType<typeof missionFunnel>;
  productivity: AgentProductivity[];
  approvalStats: ApprovalStats;
  loopHealth: LoopHealth;
  toolUsage: ToolUsage;
  knowledge: KnowledgeStats;
  services: ServiceStat[];
  outputs: DeliverableStats;

  /** Per-bucket counts of any dated collection, on the view's grid. */
  bucket: <T>(items: T[], getDate: (x: T) => string, test?: (x: T) => boolean) => number[];
}

export function buildHqView(raw: HqRawData, range: RangeKey, now: Date = new Date()): HqView {
  const win = windowOf(range, now);
  const prev = previousWindowOf(range, now);

  const runs = raw.runs.filter((r) => inRange(r.created_at, win));
  const prevRuns = raw.runs.filter((r) => inRange(r.created_at, prev));
  const approvals = raw.approvals.filter((a) => inRange(a.requested_at, win));
  const deliverables = raw.deliverables.filter((d) => inRange(d.created_at, win));
  const prevDeliverables = raw.deliverables.filter((d) => inRange(d.created_at, prev));
  const loopEvents = raw.loopEvents.filter((e) => inRange(e.created_at, win));
  const toolEvents = raw.toolEvents.filter((e) => inRange(e.created_at, win));
  const prevToolCalls = raw.toolEvents.filter((e) => e.kind === "tool_call" && inRange(e.created_at, prev)).length;
  const probes = raw.knowledgeProbes.filter((p) => inRange(p.created_at, win));

  const buckets = makeBuckets(range, now);
  const labels = buckets.map((b) => b.tick);
  const fullLabels = buckets.map((b) => b.full);

  const liveAgents = raw.agents.filter((a) => !a.is_archived);
  const agentById = new Map(raw.agents.map((a) => [a.id, a]));

  const headline = runHeadline(runs);
  const previous = runHeadline(prevRuns);
  const toolUsage = computeToolUsage(toolEvents);

  return {
    range,
    labels,
    fullLabels,
    agents: liveAgents,
    allAgents: raw.agents,
    agentById,
    agentName: (id) => agentById.get(id)?.name ?? "Agent supprimé",

    runs,
    missions: raw.missions,
    deliverables,
    approvals,
    loopEvents,
    toolEvents,

    series: buildPerfSeries(runs, range, now),
    headline,
    previous,
    deltas: {
      runs: delta(headline.runs, previous.runs),
      successRate: headline.successRate != null && previous.successRate != null
        ? headline.successRate - previous.successRate : null,
      cost: delta(headline.totalCost, previous.totalCost),
      tokens: delta(headline.totalTokens, previous.totalTokens),
      actions: delta(headline.totalActions, previous.totalActions),
      duration: headline.avgDurationSec != null && previous.avgDurationSec != null
        ? delta(headline.avgDurationSec, previous.avgDurationSec) : null,
      deliverables: delta(deliverables.length, prevDeliverables.length),
      toolCalls: delta(toolUsage.calls, prevToolCalls),
    },

    sources: sourceBreakdown(runs),
    funnel: missionFunnel(raw.missions, runs, range, now),
    productivity: computeProductivity(liveAgents, runs, deliverables, approvals),
    approvalStats: computeApprovals(approvals),
    loopHealth: computeLoopHealth(loopEvents, runs.filter((r) => r.status === "failed")),
    toolUsage,
    knowledge: computeKnowledge(
      raw.collections, raw.collectionSources, raw.collectionLinks, raw.ragGrants,
      liveAgents, toolEvents, probes,
    ),
    services: computeServices(raw.services, raw.agents, runs, deliverables, approvals, toolEvents),
    outputs: computeDeliverables(deliverables, runs),

    bucket: (items, getDate, test) => bucketCounts(items, range, getDate, test, now),
  };
}
