// What a composer can ask the backend for — one list, used by every composer.
//
// Not provider model ids any more: the platform's gateway (Runware, OpenRouter,
// Azure…) and each agent's connector translate these into a real model per
// request (supabase/functions/_shared/llm-upstream.ts, ModelRoutes). « Auto »
// pins nothing — the request's tier and criterion (code, vision, long context)
// choose. The others ask for a tier route: `@heavy`, `@light`.

export interface ChatModel {
  /** Sent as-is to the backend: "auto", or a route alias (`@heavy`…). */
  id: string;
  /** Shown in the composer's picker. */
  name: string;
  /** The level, next to the name (« Élevé », « Rapide »…). */
  level?: string;
  description: string;
}

export const CHAT_MODELS: ChatModel[] = [
  {
    id: "auto",
    name: "Auto",
    description: "Le bon modèle à chaque requête : léger, moyen, lourd, code…",
  },
  {
    id: "@heavy",
    name: "Réflexion",
    level: "Élevé",
    description: "Le modèle lourd : analyses, plans complexes, raisonnement long",
  },
  {
    id: "@standard",
    name: "Standard",
    level: "Moyen",
    description: "Le modèle courant de la plateforme, sans escalade",
  },
  {
    id: "@light",
    name: "Rapide",
    level: "Léger",
    description: "Réponses courtes et rapides",
  },
];

export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id;
