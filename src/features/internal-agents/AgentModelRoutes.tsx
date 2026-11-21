// An agent's models per task (0303, internal_agents.model_routes): light /
// medium / heavy, plus code, vision, long context and images. An empty choice
// keeps the default. The runtime picks the route from each request (tier, then
// criterion).
//
// Two cases, same table:
//   - on the platform's default connection (OpenRouter…): the choices come from
//     the platform catalogue, defaults from the platform routes (see
//     internal-agent-run platformEndpointForAgent);
//   - on its OWN connector (AI Ops → Modèles): the choices are the connector's
//     whole catalogue, defaults are the connector's routes, and the agent's
//     choices override them for this agent only (resolveAgentEndpoint).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon as Check, CaretDownIcon as CaretDown } from "@phosphor-icons/react";
import { SoftSelect } from "@/components/ui/soft-form";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  MODEL_ROUTES, PROVIDER_LABEL, primaryModel, shortModel, usePlatformModels,
} from "@/lib/platformModels";
import type { InternalAgent } from "./shared";

const DEFAULT = "__default";

interface Connector {
  id: string;
  name: string;
  config: { model_routes?: Record<string, string> } | null;
  metadata: { models?: string[] } | null;
}

export function AgentModelRoutes({ agent, disabled, className }: {
  agent: InternalAgent; disabled?: boolean; className?: string;
}) {
  const queryClient = useQueryClient();
  const onConnector = !!agent.hosted_provider_id;
  const { data: platform } = usePlatformModels(agent.workspace_id, agent.project_id);
  const { data: connector } = useQuery({
    queryKey: ["agent_routes_connector", agent.hosted_provider_id],
    enabled: onConnector,
    queryFn: async () => {
      const { data } = await supabase.from("aiops_providers_public")
        .select("id, name, config, metadata").eq("id", agent.hosted_provider_id!).maybeSingle();
      return (data ?? null) as Connector | null;
    },
  });
  const [routes, setRoutes] = useState<Record<string, string>>(() => ({ ...(agent.model_routes ?? {}) }));
  const [saved, setSaved] = useState<string | null>(null);
  const [more, setMore] = useState(() => MODEL_ROUTES.some((r) => r.extra && agent.model_routes?.[r.key]));

  // A self-hosted GPU server serves one model: nothing to route.
  if (agent.hosted_server_id) return null;

  // What each route can pick, what it falls back to, and whose catalogue it is.
  let source: string;
  let defaults: Record<string, string>;
  let textIds: string[];
  let imageIds: string[];
  if (onConnector) {
    if (!connector) return null;
    const all = connector.metadata?.models ?? [];
    source = connector.name;
    defaults = connector.config?.model_routes ?? {};
    // The connector's catalogue says nothing of capabilities: every model is offered.
    textIds = all;
    imageIds = all;
    if (!defaults.standard && agent.hosted_model) defaults = { ...defaults, standard: agent.hosted_model };
  } else {
    if (!platform?.provider) return null;
    source = `${PROVIDER_LABEL[platform.provider] ?? platform.provider}${platform.free_only ? " · gratuits" : ""}`;
    defaults = platform.routes;
    textIds = platform.models.filter((m) => m.output.includes("text") && m.tools).map((m) => m.id);
    imageIds = platform.models.filter((m) => m.output.includes("image") && !m.output.includes("text")).map((m) => m.id);
  }

  async function choose(key: string, value: string) {
    const next = { ...routes };
    if (value === DEFAULT) delete next[key]; else next[key] = value;
    setRoutes(next);
    const { error } = await supabase.from("internal_agents")
      .update({ model_routes: next, updated_at: new Date().toISOString() }).eq("id", agent.id);
    if (error) return;
    setSaved(key);
    setTimeout(() => setSaved((k) => (k === key ? null : k)), 1600);
    queryClient.invalidateQueries({ queryKey: ["sd_agent_full", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
  }

  const rows = MODEL_ROUTES.filter((r) => !r.extra || more);

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
        <span className="text-[12px] font-medium text-muted-foreground">Modèles par tâche</span>
        <span className="truncate text-[11px] text-muted-foreground">{source}</span>
      </div>
      <div className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card/60">
        {rows.map((r) => {
          const ids = r.image ? imageIds : textIds;
          const fallback = primaryModel(defaults[r.key] ?? (r.image ? undefined : defaults.standard));
          const value = routes[r.key] ? primaryModel(routes[r.key]) : DEFAULT;
          // A model chosen earlier that the catalogue no longer lists stays visible.
          const missing = value !== DEFAULT && !ids.includes(value);
          const options = [
            { value: DEFAULT, label: fallback ? `Par défaut · ${shortModel(fallback)}` : "Par défaut" },
            ...(missing ? [{ value, label: shortModel(value), hint: value }] : []),
            ...ids.map((id) => ({ value: id, label: shortModel(id), hint: id })),
          ];
          return (
            <div key={r.key} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{r.label}</div>
                <div className="truncate text-[11px] text-muted-foreground">{r.hint}</div>
              </div>
              <div className="flex min-w-0 w-[58%] items-center gap-1.5">
                <SoftSelect
                  value={value}
                  options={options}
                  onChange={(v) => void choose(r.key, v)}
                  disabled={disabled}
                  align="end"
                  className="min-w-0 flex-1"
                />
                {saved === r.key && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
              </div>
            </div>
          );
        })}
        <button
          type="button" onClick={() => setMore((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <CaretDown className={cn("h-3 w-3 transition-transform", more && "rotate-180")} />
          {more ? "Moins" : "Code, vision, long contexte, images"}
        </button>
      </div>
    </div>
  );
}
