// The cockpit's data layer: seven bounded reads that every tab derives from.
// Kept apart from the shell so a leaf tab can trigger a refresh (approvals)
// without importing the component that renders it.
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchHqAgents, fetchHqRuns, fetchHqMissions, fetchHqDeliverables, fetchHqApprovals,
  fetchHqLoopEvents,
} from "../hqStats";
import {
  fetchHqToolEvents, fetchKnowledgeProbes, fetchHqCollections, fetchHqCollectionSources,
  fetchHqCollectionLinks, fetchHqRagGrants, fetchHqServices,
} from "../hqUsage";
import type { HqRawData } from "./model";

const STALE = 60_000;

const HQ_QUERY_KEYS = [
  "hq_agents", "hq_runs", "hq_missions", "hq_approvals",
  "hq_agent_activity", "hq_knowledge_base", "hq_services",
] as const;

/** Fetches every row the cockpit derives from. `dashboardId` narrows the whole
 *  thing to one service dashboard's agents. */
export function useHqData(projectId: string | null | undefined, dashboardId?: string | null) {
  const on = !!projectId;
  const key = [projectId ?? "none", dashboardId ?? "all"] as const;

  const agentsQ = useQuery({
    queryKey: ["hq_agents", ...key],
    enabled: on,
    staleTime: STALE,
    queryFn: () => fetchHqAgents(projectId!, dashboardId ?? null),
  });
  const agents = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const scope = dashboardId ? agentIds : null;
  /** Identifies the exact agent set a scoped query ran against. */
  const scopeKey = dashboardId ? agentIds.join(",") : "all";
  // A service's queries can only run once its roster is known; firing them
  // early would read the whole project and then look scoped.
  const scopeReady = !dashboardId || agentsQ.isSuccess;

  const runsQ = useQuery({
    queryKey: ["hq_runs", ...key, scopeKey],
    enabled: on && scopeReady,
    staleTime: STALE,
    queryFn: () => fetchHqRuns(projectId!, scope),
  });
  const missionsQ = useQuery({
    queryKey: ["hq_missions", ...key, scopeKey],
    enabled: on && scopeReady,
    staleTime: STALE,
    queryFn: () => fetchHqMissions(projectId!, scope),
  });
  const approvalsQ = useQuery({
    queryKey: ["hq_approvals", ...key, scopeKey],
    enabled: on && scopeReady,
    staleTime: STALE,
    queryFn: () => fetchHqApprovals(projectId!, scope),
  });

  // Everything hanging off the agent ids, in one round of parallel reads.
  const activityQ = useQuery({
    queryKey: ["hq_agent_activity", ...key, scopeKey, agentIds.length],
    enabled: on && agentIds.length > 0,
    staleTime: STALE,
    queryFn: async () => {
      const [deliverables, loopEvents, toolEvents, knowledgeProbes, ragGrants] = await Promise.all([
        fetchHqDeliverables(projectId!, agentIds),
        fetchHqLoopEvents(projectId!, agentIds),
        fetchHqToolEvents(agentIds),
        fetchKnowledgeProbes(agentIds),
        fetchHqRagGrants(agentIds),
      ]);
      return { deliverables, loopEvents, toolEvents, knowledgeProbes, ragGrants };
    },
  });

  const knowledgeQ = useQuery({
    queryKey: ["hq_knowledge_base", projectId],
    enabled: on,
    staleTime: STALE,
    queryFn: async () => {
      const [collections, collectionSources, collectionLinks] = await Promise.all([
        fetchHqCollections(projectId!),
        fetchHqCollectionSources(projectId!),
        fetchHqCollectionLinks(projectId!),
      ]);
      return { collections, collectionSources, collectionLinks };
    },
  });

  // A single service already IS the scope — no cross-service breakdown there.
  const servicesQ = useQuery({
    queryKey: ["hq_services", projectId],
    enabled: on && !dashboardId,
    staleTime: STALE,
    queryFn: () => fetchHqServices(projectId!),
  });

  const raw: HqRawData = useMemo(() => ({
    agents,
    runs: runsQ.data ?? [],
    missions: missionsQ.data ?? [],
    approvals: approvalsQ.data ?? [],
    deliverables: activityQ.data?.deliverables ?? [],
    loopEvents: activityQ.data?.loopEvents ?? [],
    toolEvents: activityQ.data?.toolEvents ?? [],
    knowledgeProbes: activityQ.data?.knowledgeProbes ?? [],
    ragGrants: activityQ.data?.ragGrants ?? [],
    collections: knowledgeQ.data?.collections ?? [],
    collectionSources: knowledgeQ.data?.collectionSources ?? [],
    collectionLinks: knowledgeQ.data?.collectionLinks ?? [],
    services: servicesQ.data ?? [],
  }), [agents, runsQ.data, missionsQ.data, approvalsQ.data, activityQ.data, knowledgeQ.data, servicesQ.data]);

  return {
    raw,
    isLoading: agentsQ.isLoading || runsQ.isLoading,
    isFetching: agentsQ.isFetching || runsQ.isFetching || activityQ.isFetching
      || missionsQ.isFetching || approvalsQ.isFetching || knowledgeQ.isFetching,
    hasAgents: agents.length > 0,
  };
}

/** Invalidates every cockpit query — the manual refresh, and the resync after a
 *  human decides an approval (which resumes a run and may ship a deliverable). */
export function useHqRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const k of HQ_QUERY_KEYS) qc.invalidateQueries({ queryKey: [k] });
  };
}
