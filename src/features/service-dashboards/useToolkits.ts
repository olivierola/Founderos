import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import type { ComposioToolkit } from "@/features/integrations/ComposioCatalog";
import type { AgentTemplate } from "@/features/internal-agents/agentTemplates";

/** A tool an agent (or template) needs, resolved against the Composio catalogue. */
export interface ToolNeed {
  /** Toolkit / provider slug — the key both Composio and `connectors` use. */
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
}

/** Composio's catalogue, fetched once and shared by every card on the page. */
export function useComposioToolkits() {
  return useQuery({
    queryKey: ["composio_toolkits"],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const res = await callEdge<{ toolkits: ComposioToolkit[] }>("composio-catalog", {});
      return res.toolkits ?? [];
    },
  });
}

/** slug → connection status for this project (source = composio). */
export function useConnectorStatus(workspaceId: string | null, projectId: string | null) {
  return useQuery({
    queryKey: ["composio_connectors", workspaceId, projectId],
    enabled: !!workspaceId && !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, status, source")
        .eq("workspace_id", workspaceId!).eq("project_id", projectId!);
      const map = new Map<string, string>();
      for (const c of (data ?? []) as Array<{ provider: string; status: string; source: string }>) {
        // A provider can hold both an in-house and a Composio row; "connected"
        // from either is enough for the agent to work.
        if (c.status === "connected" || !map.has(c.provider)) map.set(c.provider, c.status);
      }
      return map;
    },
  });
}

/** The slugs a set of agent tool rows depends on. */
export function toolSlugsFromRows(rows: Array<{ kind: string; config: Record<string, unknown> | null }>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const slug = r.kind === "connector_action" ? String(r.config?.provider ?? "")
      : r.kind === "composio_toolkit" ? String(r.config?.toolkit ?? "")
      : "";
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** The slugs a template declares — same two tool kinds. */
export function toolSlugsFromTemplate(t: AgentTemplate): string[] {
  return toolSlugsFromRows(t.tools.map((x) => ({ kind: x.kind, config: x.config ?? null })));
}

/** Decorate slugs with the catalogue's name/logo and this project's status. */
export function resolveNeeds(
  slugs: string[],
  toolkits: ComposioToolkit[] | undefined,
  status: Map<string, string> | undefined,
): ToolNeed[] {
  return slugs
    .map((slug) => {
      const t = (toolkits ?? []).find((x) => x.slug === slug);
      return {
        slug,
        name: t?.name ?? slug,
        logo: t?.logo ?? null,
        connected: status?.get(slug) === "connected",
      };
    })
    // Templates ship the alternatives of their trade (five CRMs, four ATS), so
    // the head of this list has to be what the project actually runs — callers
    // truncate it, and truncating to five unconnected logos tells you nothing.
    .sort((a, b) => Number(b.connected) - Number(a.connected));
}
