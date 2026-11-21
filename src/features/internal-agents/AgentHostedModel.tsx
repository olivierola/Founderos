// Which model an agent runs on: one of the providers we supply (DeepSeek, Groq),
// one of the company's registered cloud/custom models (aiops_providers
// cloud_endpoint — Azure OpenAI, OpenAI… added in AI Ops → Modèles), or a
// self-hosted RunPod GPU server. All of them sit in the single "Modèle" select
// of the agent's settings. A registered model or a server is written onto the
// agent (hosted_provider_id / hosted_endpoint_url / hosted_model /
// hosted_server_id) and resolved at run time by internal-agent-run; our own
// providers go to internal_agents.model with the hosted fields cleared.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { InternalAgent } from "./shared";

interface AiopsServer {
  id: string; name: string; endpoint_url: string | null;
  served_model: string | null; status: string;
}
interface CloudProvider {
  id: string; name: string; config: { base_url?: string; model_routes?: Record<string, string> } | null; status: string;
  metadata: { models?: string[] } | null;
}

export interface AgentModelOption { value: string; label: string; hint?: string }

// La valeur reste « deepseek » (compatibilité des agents existants), mais elle
// désigne le fournisseur de la plateforme — Runware, OpenRouter, Azure… — qui
// choisit le modèle à chaque requête d'après ses routes (palier, critère).
export const BUILTIN_MODEL_OPTIONS: AgentModelOption[] = [
  { value: "deepseek", label: "Connexion par défaut · automatique", hint: "OpenRouter : le bon modèle à chaque requête (léger, moyen, lourd), réglable par tâche" },
  { value: "groq", label: "Rapide (Groq)", hint: "Échanges courts, si la plateforme a une clé Groq" },
];

/** The agent's current choice as one select value: `p:<provider>:<model>` for a
 *  registered model, `s:<server>` for a RunPod server, else the builtin id. */
export function agentModelValue(agent: InternalAgent): string {
  if (agent.hosted_provider_id) return `p:${agent.hosted_provider_id}:${agent.hosted_model ?? ""}`;
  if (agent.hosted_server_id) return `s:${agent.hosted_server_id}`;
  return agent.model === "groq" ? "groq" : "deepseek";
}

export function useAgentModelChoices(projectId: string) {
  const { data: providers } = useQuery({
    queryKey: ["aiops_agent_cloud_models", projectId],
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_providers_public")
        .select("id, name, config, status, metadata")
        .eq("project_id", projectId).eq("kind", "cloud_endpoint");
      return (data ?? []) as CloudProvider[];
    },
  });
  const { data: servers } = useQuery({
    queryKey: ["aiops_hosted_servers", projectId],
    queryFn: async () => {
      const { data } = await supabase
        .from("aiops_servers")
        .select("id, name, endpoint_url, served_model, status")
        .eq("project_id", projectId).eq("source", "runpod")
        .not("endpoint_url", "is", null);
      return (data ?? []) as AiopsServer[];
    },
  });

  const options: AgentModelOption[] = [
    ...BUILTIN_MODEL_OPTIONS,
    ...(providers ?? []).flatMap((p) => [
      // Un connecteur qui a des modèles par tâche : sans modèle imposé, le
      // runtime prend la route de chaque requête (hosted_model vide).
      ...(Object.keys(p.config?.model_routes ?? {}).length
        ? [{ value: `p:${p.id}:`, label: `${p.name} · Automatique (selon la requête)`, hint: "Modèles par tâche du connecteur (AI Ops)" }]
        : []),
      // Tout le catalogue du connecteur (OpenRouter en expose des centaines) :
      // la liste se filtre au clavier (SoftSelect).
      ...(p.metadata?.models ?? []).map((m) => ({
        value: `p:${p.id}:${m}`,
        label: `${p.name} · ${m}`,
        hint: p.status === "connected" ? "Vos modèles (AI Ops)" : `Vos modèles (AI Ops) · ${p.status}`,
      })),
    ]),
    ...(servers ?? []).map((s) => ({
      value: `s:${s.id}`,
      label: `${s.name}${s.served_model ? ` · ${s.served_model}` : ""}`,
      hint: `Serveur auto-hébergé${s.status !== "online" ? ` · ${s.status}` : ""}`,
    })),
  ];

  /** The internal_agents columns a select value maps to. */
  function patchFor(value: string): Record<string, unknown> {
    if (value.startsWith("p:")) {
      // Provider ids are UUIDs (no colon); the model id may contain one (Ollama tags).
      const rest = value.slice(2);
      const i = rest.indexOf(":");
      const providerId = rest.slice(0, i);
      const model = rest.slice(i + 1);
      const p = (providers ?? []).find((x) => x.id === providerId);
      return {
        hosted_provider_id: providerId,
        hosted_model: model || null,
        hosted_endpoint_url: p?.config?.base_url ?? null,
        hosted_server_id: null,
      };
    }
    if (value.startsWith("s:")) {
      const serverId = value.slice(2);
      const s = (servers ?? []).find((x) => x.id === serverId);
      return {
        hosted_server_id: serverId,
        hosted_endpoint_url: s?.endpoint_url ?? null,
        hosted_model: s?.served_model ?? null,
        hosted_provider_id: null,
      };
    }
    return {
      model: value === "groq" ? "groq" : "deepseek",
      hosted_provider_id: null, hosted_server_id: null, hosted_endpoint_url: null, hosted_model: null,
    };
  }

  return { options, patchFor };
}
