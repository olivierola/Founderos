// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/llm-upstream.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno } from "../../compat/index.ts";

// Passerelle LLM imposée par le déploiement (installation dédiée).
//
// Une installation chez un client ne choisit pas son fournisseur au fil de
// l'eau : ses données ne doivent partir que vers SA passerelle. Avec
// LLM_UPSTREAM, tous les appels de chat (ai.ts) et de vectorisation (jina.ts)
// vont vers elle, et `assertAllowedLlmUrl` refuse tout autre hôte : un repli
// DeepSeek ou Groq oublié quelque part échoue au lieu d'envoyer un prompt hors
// du périmètre.
//
// LLM_UPSTREAM=litellm — la passerelle de la plateforme (ai-gateway) : seul
// détenteur de l'identité Azure, masquage Presidio, budgets, journal.
// FounderOS n'y connaît qu'une adresse interne et des alias de modèles.
//   LLM_BASE_URL          http://litellm.ai-gateway.svc:4000/v1
//   LLM_MODEL_DEFAULT     alias du modèle courant (défaut ops-default)
//   LLM_MODEL_HEAVY       alias des tâches lourdes (défaut : LLM_MODEL_DEFAULT)
//   LLM_EMBEDDING_MODEL   alias des embeddings (RAG, mémoire)
//   LLM_AGENT_KEYS        {"<id ou nom de l'agent>": "<clé virtuelle LiteLLM>"} : le budget de chaque agent
//   LLM_API_KEY           clé des appels sans agent (résumés, interface)
//   LLM_REASONING         1 si l'alias courant est un modèle de raisonnement (pas de température)
// Chaque appel porte `user` (la personne pour qui l'agent agit, pour son budget)
// et `metadata` (agent, run), lus dans le contexte d'appel (llm-context.ts).
//
// LLM_UPSTREAM=azure — Azure OpenAI en direct (sans passerelle) :
//   AZURE_OPENAI_BASE_URL, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_DEPLOYMENT_HEAVY,
//   AZURE_OPENAI_EMBEDDING_DEPLOYMENT, AZURE_OPENAI_REASONING, et AZURE_OPENAI_API_KEY ou
//   le trio AZURE_OPENAI_TENANT_ID / CLIENT_ID / CLIENT_SECRET (+ AZURE_OPENAI_SCOPE,
//   AZURE_AUTHORITY_HOST).
//
// Dans les deux cas : LLM_ALLOWED_HOSTS ajoute des hôtes autorisés (un vLLM
// interne déclaré comme endpoint d'agent…).

import { currentLlmCaller } from "./llm-context.ts";

export type UpstreamKind = "azure" | "litellm";

export interface PinnedUpstream {
  kind: UpstreamKind;
  baseUrl: string;
  model: string;
  heavyModel: string;
  embeddingModel: string | null;
  reasoning: boolean;
}

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

/** La passerelle imposée, ou null hors installation dédiée. Une configuration
 *  incomplète lève une erreur : mieux vaut un appel qui échoue en le disant
 *  qu'un appel qui repart en silence vers le fournisseur par défaut. */
export function pinnedUpstream(): PinnedUpstream | null {
  const kind = env("LLM_UPSTREAM").toLowerCase();
  if (!kind) return null;
  if (kind === "litellm") {
    const baseUrl = env("LLM_BASE_URL").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("LLM_UPSTREAM=litellm demande LLM_BASE_URL.");
    const model = env("LLM_MODEL_DEFAULT") || "ops-default";
    return {
      kind, baseUrl, model,
      heavyModel: env("LLM_MODEL_HEAVY") || model,
      embeddingModel: env("LLM_EMBEDDING_MODEL") || null,
      reasoning: env("LLM_REASONING") === "1",
    };
  }
  if (kind === "azure") {
    const baseUrl = env("AZURE_OPENAI_BASE_URL").replace(/\/+$/, "");
    const deployment = env("AZURE_OPENAI_DEPLOYMENT");
    if (!baseUrl || !deployment) {
      throw new Error("LLM_UPSTREAM=azure demande AZURE_OPENAI_BASE_URL et AZURE_OPENAI_DEPLOYMENT.");
    }
    return {
      kind, baseUrl, model: deployment,
      heavyModel: env("AZURE_OPENAI_DEPLOYMENT_HEAVY") || deployment,
      embeddingModel: env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT") || null,
      reasoning: env("AZURE_OPENAI_REASONING") === "1",
    };
  }
  throw new Error(`LLM_UPSTREAM inconnu : « ${kind} » (attendu : litellm ou azure).`);
}

/** Le modèle (alias ou déploiement) qui répond à un modèle demandé par
 *  l'appelant. Les appelants parlent en modèles DeepSeek (deepseek-reasoner
 *  pour le palier lourd, voir model-router) : on garde la distinction lourd /
 *  courant, rien de plus. */
export function upstreamModelFor(up: PinnedUpstream, requested?: string | null): string {
  const heavy = env("AGENT_MODEL_HEAVY") || "deepseek-reasoner";
  const r = String(requested ?? "");
  return r && (r === heavy || r.includes("reason")) ? up.heavyModel : up.model;
}

function isUpstreamUrl(up: PinnedUpstream, url: string): boolean {
  return url === up.baseUrl || url.startsWith(`${up.baseUrl}/`);
}

/**
 * Garde-fou de sortie. Sans passerelle imposée, tout passe. Avec, seule la
 * passerelle et les hôtes de LLM_ALLOWED_HOSTS sont joignables.
 */
export function assertAllowedLlmUrl(url: string): void {
  const up = pinnedUpstream();
  if (!up || isUpstreamUrl(up, url)) return;
  let host = "";
  try { host = new URL(url).host; } catch { /* host reste vide : refusé */ }
  const extra = env("LLM_ALLOWED_HOSTS").split(",").map((h) => h.trim()).filter(Boolean);
  if (host && extra.includes(host)) return;
  throw new Error(`Appel LLM vers ${host || url} refusé : ce déploiement n'autorise que ${new URL(up.baseUrl).host} (LLM_UPSTREAM=${up.kind}).`);
}

// ── Authentification ────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

async function entraToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 120_000 > Date.now()) return cachedToken.value;
  const tenant = env("AZURE_OPENAI_TENANT_ID");
  const authority = env("AZURE_AUTHORITY_HOST") || "login.microsoftonline.com";
  const res = await fetch(`https://${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env("AZURE_OPENAI_CLIENT_ID"),
      client_secret: env("AZURE_OPENAI_CLIENT_SECRET"),
      scope: env("AZURE_OPENAI_SCOPE") || "https://cognitiveservices.azure.com/.default",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Jeton Entra pour Azure OpenAI refusé (${res.status}) : ${String(json.error_description ?? json.error ?? "").slice(0, 200)}`);
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

let agentKeysCache: Record<string, string> | null = null;
function agentKeys(): Record<string, string> {
  if (agentKeysCache) return agentKeysCache;
  const raw = env("LLM_AGENT_KEYS");
  try {
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    agentKeysCache = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    throw new Error("LLM_AGENT_KEYS n'est pas un JSON valide.");
  }
  return agentKeysCache;
}

/** Pour les tests. */
export function resetUpstreamCaches(): void {
  agentKeysCache = null;
  cachedToken = null;
}

/** La clé virtuelle LiteLLM de l'appel : celle de l'agent, sinon la clé commune. */
function litellmKey(): string {
  const caller = currentLlmCaller();
  const keys = agentKeys();
  const key = (caller?.agentId && keys[caller.agentId]) || (caller?.agentName && keys[caller.agentName]) || env("LLM_API_KEY");
  if (!key) {
    throw new Error(`Aucune clé LiteLLM pour ${caller?.agentName ?? caller?.agentId ?? "cet appel"} (LLM_AGENT_KEYS, LLM_API_KEY).`);
  }
  return key;
}

/**
 * En-têtes d'un appel LLM vers `url`. Vers la passerelle : sa clé (LiteLLM : la
 * clé virtuelle de l'agent ; Azure : clé ou jeton Entra). Ailleurs : le Bearer
 * de l'appelant, s'il en a un (un endpoint interne non authentifié refuse
 * parfois un « Bearer » vide).
 */
export async function llmAuthHeaders(url: string, apiKey: string): Promise<Record<string, string>> {
  assertAllowedLlmUrl(url);
  const up = pinnedUpstream();
  if (up && isUpstreamUrl(up, url)) {
    if (up.kind === "litellm") return { Authorization: `Bearer ${litellmKey()}` };
    const key = env("AZURE_OPENAI_API_KEY");
    if (key) return { "api-key": key };
    if (env("AZURE_OPENAI_TENANT_ID") && env("AZURE_OPENAI_CLIENT_ID") && env("AZURE_OPENAI_CLIENT_SECRET")) {
      return { Authorization: `Bearer ${await entraToken()}` };
    }
    throw new Error("Azure OpenAI : renseignez AZURE_OPENAI_API_KEY, ou le trio AZURE_OPENAI_TENANT_ID / CLIENT_ID / CLIENT_SECRET.");
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Adapte un corps de chat à la passerelle.
 *   Azure    : `max_tokens` → `max_completion_tokens` (les modèles récents
 *              refusent le premier), pas de `temperature` pour un modèle de
 *              raisonnement.
 *   LiteLLM  : `user` (budget de la personne) et `metadata` (agent, run), pour
 *              les budgets et les journaux de la passerelle ; pas de
 *              `temperature` pour un alias de raisonnement.
 */
export function adaptChatBody(url: string, body: Record<string, unknown>): Record<string, unknown> {
  const up = pinnedUpstream();
  if (!up || !isUpstreamUrl(up, url)) return body;
  const out = { ...body };
  if (up.reasoning) delete out.temperature;
  if (up.kind === "azure") {
    if ("max_tokens" in out) {
      if (out.max_tokens !== undefined) out.max_completion_tokens = out.max_tokens;
      delete out.max_tokens;
    }
    return out;
  }
  const caller = currentLlmCaller();
  if (caller?.userId && out.user === undefined) out.user = caller.userId;
  const metadata = {
    ...(caller?.agentName ? { agent: caller.agentName } : {}),
    ...(caller?.agentId ? { agent_id: caller.agentId } : {}),
    ...(caller?.runId ? { run_id: caller.runId } : {}),
  };
  if (Object.keys(metadata).length && out.metadata === undefined) out.metadata = metadata;
  return out;
}

/** Pour les appels qui ne passent pas par ai.ts (flux SSE, relais brut) : où
 *  envoyer un chat et avec quels en-têtes. Null hors installation dédiée. */
export async function pinnedChatTarget(requested?: string | null): Promise<{
  url: string;
  model: string;
  headers: Record<string, string>;
} | null> {
  const up = pinnedUpstream();
  if (!up) return null;
  const url = `${up.baseUrl}/chat/completions`;
  return { url, model: upstreamModelFor(up, requested), headers: await llmAuthHeaders(url, "") };
}
