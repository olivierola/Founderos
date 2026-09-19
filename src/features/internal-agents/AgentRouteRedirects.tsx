// The internal-agent pages were removed from the main dashboard (AI Workforce):
// an agent is worked with inside its service dashboard, not in a second, parallel
// screen. The old URLs stay routed so every inbound link — CRM record actions,
// AI HQ cards, the governance registry, bookmarks — resolves the agent's
// dashboard and bounces there instead of 404-ing.

import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

/** The service dashboard an agent belongs to, falling back to the project's first. */
function useAgentDashboard(agentId?: string) {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["agent_dashboard_redirect", agentId ?? null, projectId],
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      if (agentId) {
        const { data } = await supabase
          .from("internal_agents")
          .select("service_dashboard_id")
          .eq("id", agentId)
          .maybeSingle();
        const id = (data as { service_dashboard_id?: string | null } | null)?.service_dashboard_id;
        if (id) return id;
      }
      // Agent not attached to a dashboard (or no agent at all): the project's
      // first dashboard is the closest thing to "where the workforce lives".
      const { data } = await supabase
        .from("service_dashboards")
        .select("id")
        .eq("project_id", projectId!)
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle();
      return ((data as { id?: string } | null)?.id ?? null) as string | null;
    },
  });
}

function Resolving() {
  return (
    <div className="flex h-full items-center justify-center py-20 text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Ouverture de l'agent…
    </div>
  );
}

/** /app/:ws/:proj/agent/internal/:agentId/* → the agent inside its dashboard. */
export function InternalAgentRedirect() {
  const { workspaceSlug, projectSlug, agentId } = useParams();
  const { data: dashboardId, isPending } = useAgentDashboard(agentId);
  if (isPending) return <Resolving />;
  const base = `/app/${workspaceSlug}/${projectSlug}`;
  return (
    <Navigate
      replace
      to={dashboardId ? `${base}/service/${dashboardId}/agent/${agentId}` : `${base}/hq/dashboard`}
    />
  );
}

/** /app/:ws/:proj/agent/internal-agents → the dashboard's agents tab. */
export function InternalAgentsIndexRedirect() {
  const { workspaceSlug, projectSlug } = useParams();
  const { data: dashboardId, isPending } = useAgentDashboard();
  if (isPending) return <Resolving />;
  const base = `/app/${workspaceSlug}/${projectSlug}`;
  return <Navigate replace to={dashboardId ? `${base}/service/${dashboardId}/agents` : `${base}/hq/dashboard`} />;
}
