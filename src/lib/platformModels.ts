// The platform's default LLM connection (OpenRouter, free models by default):
// what agents and the assistant run on before a company connects its own
// models in AI Ops. The key never leaves the backend — aiops-infra
// `platform.models` returns the connection state, its per-task models and the
// catalogue it can serve.
import { useQuery } from "@tanstack/react-query";
import { callEdge } from "@/lib/edge";

export interface PlatformModel {
  id: string;
  name: string;
  context_length: number | null;
  input: string[];
  output: string[];
  tools: boolean;
  free: boolean;
  price_in: number | null;
  price_out: number | null;
  expires: string | null;
}

export interface PlatformModels {
  provider: string | null;
  connected: boolean;
  free_only: boolean;
  routes: Record<string, string>;
  models: PlatformModel[];
  error: string | null;
}

/** The task routes, same keys as the backend (ROUTE_KEYS, llm-upstream). */
export const MODEL_ROUTES: Array<{ key: string; label: string; hint: string; image?: boolean; extra?: boolean }> = [
  { key: "light", label: "Léger", hint: "Réponses courtes, salutations, appels rapides" },
  { key: "standard", label: "Moyen", hint: "Le travail courant : outils, rédaction, recherche" },
  { key: "heavy", label: "Lourd", hint: "Raisonnement, analyse, plans complexes" },
  { key: "code", label: "Code", hint: "Écrire ou corriger du code, du SQL", extra: true },
  { key: "vision", label: "Vision", hint: "Lire une image jointe", extra: true },
  { key: "long_context", label: "Long contexte", hint: "Gros documents, longs transcrits", extra: true },
  { key: "image", label: "Images", hint: "L'outil generate_image", image: true, extra: true },
];

export const PROVIDER_LABEL: Record<string, string> = {
  openrouter: "OpenRouter", runware: "Runware", azure: "Azure OpenAI", litellm: "Passerelle LiteLLM",
};

/** The first model of a route (« a,b,c »: the others are fallbacks). */
export const primaryModel = (route: string | undefined): string => (route ?? "").split(",")[0]?.trim() ?? "";

/** « nvidia/nemotron-3.5-lightning:free » → « nemotron-3.5-lightning ». */
export function shortModel(id: string): string {
  if (id === "openrouter/free") return "Routeur gratuit";
  return id.replace(/^[^/]+\//, "").replace(/:free$/, "");
}

export function usePlatformModels(workspaceId: string | null | undefined, projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["platform_models", projectId],
    enabled: !!workspaceId && !!projectId,
    staleTime: 10 * 60_000,
    queryFn: () => callEdge<PlatformModels>("aiops-infra", {
      action: "platform.models", workspace_id: workspaceId, project_id: projectId,
    }),
  });
}
