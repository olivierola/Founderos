// Public agents moved into the service dashboards (0195): their six builder
// tabs are now /service/:dashboardId/public/:agentId?t=<tab> instead of the
// standalone /agent/builder/:agentId/:tab page. Every inbound link — CRM record
// actions, the workforce roster, onboarding pages, bookmarks — keeps working by
// resolving the agent's dashboard here and bouncing there.

import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

/** The dashboard a public agent belongs to, falling back to the project's first. */
function usePublicAgentDashboard(agentId?: string) {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["public_agent_dashboard_redirect", agentId ?? null, projectId],
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async () => {
      if (agentId) {
        const { data } = await supabase
          .from("rag_agents")
          .select("service_dashboard_id")
          .eq("id", agentId)
          .maybeSingle();
        const id = (data as { service_dashboard_id?: string | null } | null)?.service_dashboard_id;
        if (id) return id;
      }
      // Orphaned (its dashboard was deleted — the FK is `on delete set null`):
      // open it in the project's first dashboard, which re-files it on arrival.
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

/** /app/:ws/:proj/agent/builder/:agentId/:tab? → the agent inside its dashboard. */
export function PublicAgentRedirect() {
  const { workspaceSlug, projectSlug, agentId, tab } = useParams();
  const { data: dashboardId, isPending } = usePublicAgentDashboard(agentId);
  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Ouverture de l'agent…
      </div>
    );
  }
  const base = `/app/${workspaceSlug}/${projectSlug}`;
  // No dashboard at all in this project: the roster is the only place left that
  // can talk about this agent (and it offers to create a dashboard).
  if (!dashboardId) return <Navigate replace to={`${base}/agent/agents`} />;
  return <Navigate replace to={`${base}/service/${dashboardId}/public/${agentId}?t=${tab || "playground"}`} />;
}
