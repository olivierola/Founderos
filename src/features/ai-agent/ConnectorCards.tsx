// Connector cards inside an assistant answer.
//
// The assistant can't connect a service — credentials and OAuth live in the
// user's browser. So instead of ending on "go to the Integrations screen", it
// emits a `connectors` artifact and we render the SAME cards as the catalogue,
// wired to the SAME flows: Composio's hosted page for catalogue toolkits, the
// provider credential dialog for native ones.
//
// When the artifact carries an agent_id, connecting also attaches the connector
// to that agent — otherwise the user would connect Slack and still have an agent
// that can't use it.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { callEdge } from "@/lib/edge";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { findProvider } from "@/lib/providers";
import { ConnectorDialog } from "@/features/integrations/ConnectorDialog";
import {
  ToolkitCard, ComposioConnectDialog, synthToolkit, type ComposioToolkit,
} from "@/features/integrations/ComposioCatalog";

export interface ProposedConnector {
  slug: string;
  name?: string;
  reason?: string;
  status?: string;
}

export interface ConnectorProposal {
  agent_id?: string | null;
  items?: ProposedConnector[];
}

export function ConnectorCards({ proposal }: { proposal: ConnectorProposal }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const location = useLocation();
  // Inside a service dashboard a connection belongs to THAT dashboard (0177);
  // anywhere else only the legacy project-wide scope exists.
  const dashboardId = location.pathname.match(/\/service\/([^/]+)/)?.[1];

  const [composio, setComposio] = useState<ComposioToolkit | null>(null);
  const [native, setNative] = useState<ReturnType<typeof findProvider> | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);

  const items = proposal.items ?? [];

  // Real catalogue entries give the card its logo, auth mode and description;
  // a slug we don't know still renders, just plainer.
  const { data: toolkits } = useQuery({
    queryKey: ["composio_toolkits"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await callEdge<{ toolkits: ComposioToolkit[] }>("composio-catalog", {});
      return res.toolkits;
    },
  });

  const { data: connectors } = useQuery({
    queryKey: ["assistant_connector_status", projectId, dashboardId ?? null],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, status, scope, service_dashboard_id")
        .eq("project_id", projectId!);
      return ((data ?? []) as Array<{ provider: string; status: string; scope: string | null; service_dashboard_id: string | null }>)
        .filter((c) => c.scope !== "personal" && (!c.service_dashboard_id || c.service_dashboard_id === dashboardId));
    },
  });

  const statusOf = useMemo(() => {
    const m = new Map((connectors ?? []).map((c) => [c.provider, c.status]));
    return (slug: string) => m.get(slug);
  }, [connectors]);

  /** Give the agent the connector it just gained access to. */
  async function attachToAgent(slug: string, viaComposio: boolean) {
    const agentId = proposal.agent_id;
    if (!agentId) return;
    setAttaching(slug);
    try {
      const { data: existing } = await supabase
        .from("internal_agent_tools")
        .select("id, kind, config")
        .eq("agent_id", agentId);
      const already = (existing ?? []).some((t: { kind: string; config: Record<string, unknown> | null }) =>
        String(t.config?.toolkit ?? t.config?.provider ?? "") === slug);
      if (!already) {
        await supabase.from("internal_agent_tools").insert({
          agent_id: agentId,
          kind: viaComposio ? "composio_toolkit" : "connector_action",
          name: `Use ${slug}`,
          config: viaComposio ? { toolkit: slug } : { provider: slug },
          requires_approval: false,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["assistant_agent_setup"] }),
        queryClient.invalidateQueries({ queryKey: ["internal_agent_tools"] }),
        queryClient.invalidateQueries({ queryKey: ["agent_tools_setup"] }),
      ]);
    } finally {
      setAttaching(null);
    }
  }

  async function refreshStatus() {
    await queryClient.invalidateQueries({ queryKey: ["assistant_connector_status"] });
    await queryClient.invalidateQueries({ queryKey: ["composio_connectors"] });
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {items.map((c) => {
        const known = (toolkits ?? []).find((t) => t.slug === c.slug);
        const provider = findProvider(c.slug);
        const toolkit = known ?? synthToolkit(c.slug, c.name || c.slug, c.reason ?? null);
        const status = statusOf(c.slug) ?? (c.status === "not_connected" ? undefined : c.status);
        return (
          <div key={c.slug}>
            <ToolkitCard
              toolkit={toolkit}
              status={status}
              onConnect={() => {
                // A native provider has its own credential form; everything else
                // goes through Composio, exactly like the catalogue does.
                if (provider && !known) setNative(provider);
                else setComposio(toolkit);
              }}
            />
            {c.reason && (
              <p className="mt-1 px-1 text-[11px] leading-relaxed text-muted-foreground">{c.reason}</p>
            )}
            {attaching === c.slug && (
              <p className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Rattachement à l'agent…
              </p>
            )}
          </div>
        );
      })}

      <ComposioConnectDialog
        toolkit={composio}
        workspaceId={workspaceId}
        projectId={projectId}
        serviceDashboardId={dashboardId}
        scope={dashboardId ? "dashboard" : "project"}
        onOpenChange={(o) => { if (!o) setComposio(null); }}
        onConnected={async () => {
          const slug = composio?.slug;
          await refreshStatus();
          if (slug) await attachToAgent(slug, true);
        }}
      />

      {workspaceId && projectId && (
        <ConnectorDialog
          open={!!native}
          onOpenChange={(o) => { if (!o) setNative(null); }}
          provider={native ?? null}
          workspaceId={workspaceId}
          projectId={projectId}
          onConnected={async () => {
            const slug = native?.slug;
            await refreshStatus();
            if (slug) await attachToAgent(slug, false);
          }}
        />
      )}
    </div>
  );
}
