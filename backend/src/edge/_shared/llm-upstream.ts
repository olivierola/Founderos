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
//   LLM_MODEL_LIGHT       alias des appels annexes (juges, classements ; défaut : LLM_MODEL_DEFAULT)
//   LLM_EMBEDDING_MODEL   alias des embeddings (RAG, mémoire)
//   LLM_AGENT_KEYS        {"<id ou nom de l'agent>": "<clé virtuelle LiteLLM>"} : le budget de chaque agent
//   LLM_API_KEY           clé des appels sans agent (résumés, interface)
//   LLM_REASONING         1 si l'alias courant est un modèle de raisonnement (pas de température)
// Chaque appel porte `user` (la personne pour qui l'agent agit, pour son budget)
// et `metadata` (agent, run), lus dans le contexte d'appel (llm-context.ts).
//
// LLM_UPSTREAM=azure — Azure OpenAI / AI Foundry en direct (sans passerelle) :
//   AZURE_OPENAI_BASE_URL, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_DEPLOYMENT_HEAVY,
//   AZURE_OPENAI_DEPLOYMENT_LIGHT, AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
//   AZURE_OPENAI_REASONING, et AZURE_OPENAI_API_KEY ou le trio
//   AZURE_OPENAI_TENANT_ID / CLIENT_ID / CLIENT_SECRET (+ AZURE_OPENAI_SCOPE,
//   AZURE_AUTHORITY_HOST).
//
// Modèles de raisonnement (LLM_REASONING / AZURE_OPENAI_REASONING = 1) :
//   - pas de `temperature` (seule la valeur par défaut est acceptée) ;
//   - le plafond de sortie compte AUSSI les tokens de raisonnement : un juge
//     à 120 tokens sur gpt-5-mini les dépense tous à réfléchir et rend un
//     texte vide (constaté le 10/11/2026). On ajoute donc une marge,
//     LLM_REASONING_HEADROOM (défaut 1024), qui ne coûte que si elle sert ;
//   - LLM_REASONING_EFFORT (ou AZURE_OPENAI_REASONING_EFFORT) règle l'effort :
//     une valeur pour tous les modèles, ou un JSON par modèle,
//     {"gpt-5-mini":"minimal"}. Attention : gpt-5.6-terra refuse tout effort
//     autre que « none » dès que la requête porte des outils.
//
// LLM_UPSTREAM=runware — Runware (runware.ai), API compatible OpenAI, un seul
// compte pour des modèles de plusieurs éditeurs (OpenAI, Google, DeepSeek,
// Anthropic, MiniMax…), désignés par leur identifiant AIR :
//   RUNWARE_API_KEY        la clé (en-tête Authorization: Bearer)
//   RUNWARE_BASE_URL       défaut https://api.runware.ai/v1
//   RUNWARE_MODEL          modèle courant      (défaut openai:gpt@5.6-terra)
//   RUNWARE_MODEL_HEAVY    tâches lourdes      (défaut : RUNWARE_MODEL)
//   RUNWARE_MODEL_LIGHT    appels annexes      (défaut openai:gpt@5.4-mini)
// Runware n'a pas d'embeddings : les vecteurs restent chez Jina (JINA_API_KEY,
// jina.ts). Les jugements typés passent par son endpoint /decisions
// (typesafe.ts) et les images par son API native (office-ai/media.ts). Le
// dialecte dépend de la famille du modèle (runwareDialect).
//
// LLM_UPSTREAM=openrouter — OpenRouter (openrouter.ai), API compatible OpenAI,
// des centaines de modèles désignés par éditeur/modèle :
//   OPENROUTER_API_KEY, OPENROUTER_BASE_URL (défaut https://openrouter.ai/api/v1),
//   OPENROUTER_MODEL (défaut openai/gpt-5), OPENROUTER_MODEL_HEAVY,
//   OPENROUTER_MODEL_LIGHT (défaut openai/gpt-5-mini).
// Embeddings chez Jina, jugements typés chez TypeSafe, comme pour Runware.
// C'est la connexion PAR DÉFAUT : sans LLM_UPSTREAM, une OPENROUTER_API_KEY
// suffit (LLM_UPSTREAM=none la désactive). OPENROUTER_FREE_ONLY (défaut 1) ne
// sert que des modèles gratuits (openrouter-catalog.ts).
//
// ── Plusieurs modèles par connecteur : les ROUTES ───────────────────────────
// Un connecteur ne porte plus un modèle mais une table : par palier (light,
// standard, heavy) et par critère (code, vision, long_context, image, judge).
// Pour la passerelle imposée : LLM_MODEL_ROUTES, un JSON
//   {"code":"anthropic/claude-sonnet-4.5","vision":"google/gemini-2.5-pro"}
// qui complète les modèles de palier ci-dessus. Pour un connecteur enregistré
// dans AI Ops (aiops_providers), config.model_routes, réglé dans l'interface.
// Une valeur peut lister plusieurs modèles, séparés par des virgules : le
// premier sert, les suivants sont des replis (natifs chez OpenRouter).
//
// L'appelant ne nomme pas un modèle mais un ALIAS de route : `@light`,
// `@heavy`, `@code|heavy` (« le modèle de code, sinon le lourd »). Le runtime
// choisit l'alias d'après la requête (model-router, requestProfile) ; le
// connecteur le traduit (resolveModelAlias).
//
// Dans tous les cas : LLM_ALLOWED_HOSTS ajoute des hôtes autorisés (un vLLM
// interne déclaré comme endpoint d'agent…).

import { currentLlmCaller } from "./llm-context.ts";
import { freeRoute, freeRoutes, OPENROUTER_FREE_ROUTES, openrouterFreeOnly } from "./openrouter-catalog.ts";
import { withHouseStyle } from "./reply-format.ts";

export type UpstreamKind = "azure" | "litellm" | "runware" | "openrouter";

/** L'API de Runware, compatible OpenAI. */
export const RUNWARE_DEFAULT_BASE_URL = "https://api.runware.ai/v1";
/** L'API d'OpenRouter, compatible OpenAI. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Les clés de route qu'un connecteur peut renseigner. */
export const ROUTE_KEYS = ["light", "standard", "heavy", "code", "vision", "long_context", "image", "judge"] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];
/** Route → modèle(s), « a,b » pour un repli. */
export type ModelRoutes = Partial<Record<string, string>>;
const TIERS = new Set(["light", "standard", "heavy"]);

/** Une table de routes lue d'un JSON (env ou config) : seules les chaînes
 *  non vides restent. Illisible : aucune route, jamais d'erreur. */
export function parseModelRoutes(raw: unknown): ModelRoutes {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: ModelRoutes = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k.trim()] = v.trim();
  }
  return out;
}

/** Un modèle demandé qui n'est pas un modèle mais une route (`@…`). */
export const isModelAlias = (m: unknown): boolean => typeof m === "string" && m.startsWith("@");

/** L'alias d'une requête : son critère s'il y en a un, sinon son palier. */
export function routeAlias(tier: "light" | "standard" | "heavy", need?: string | null): string {
  return need ? `@${need}|${tier}` : `@${tier}`;
}

/**
 * Le modèle d'un alias pour une table de routes. `@code|heavy` : la route
 * « code », sinon « heavy », sinon « standard ». Un palier absent retombe sur
 * « standard », puis sur `fallback` (le modèle par défaut du connecteur).
 */
export function resolveModelAlias(alias: string, routes: ModelRoutes, fallback?: string): string | undefined {
  const keys = alias.replace(/^@/, "").split("|").map((k) => k.trim()).filter(Boolean);
  for (const k of keys) if (routes[k]) return routes[k];
  // Un juge, sans route dédiée, est un appel annexe : le palier léger.
  if (keys.includes("judge") && routes.light) return routes.light;
  return routes.standard ?? fallback;
}

/** Le premier modèle d'une liste « a,b,c » (les autres sont des replis). */
export const primaryModel = (m: string): string => m.split(",")[0]!.trim();

export interface PinnedUpstream {
  kind: UpstreamKind;
  baseUrl: string;
  model: string;
  heavyModel: string;
  /** Le modèle des appels annexes (juges, classements, contrats). */
  lightModel: string;
  embeddingModel: string | null;
  reasoning: boolean;
  /** Les routes par critère (LLM_MODEL_ROUTES), en plus des trois paliers. */
  routes: ModelRoutes;
}

/** Le modèle que demande un appel annexe : il devient le déploiement léger de
 *  la passerelle (`lightModel`). N'a de sens que sur une passerelle imposée —
 *  `cheapModel()` (model-router) ne le rend que dans ce cas, et `callAi` ne
 *  l'envoie jamais tel quel à un fournisseur. */
export const LIGHT_MODEL = "@light";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

/** La passerelle imposée, ou null hors installation dédiée. Une configuration
 *  incomplète lève une erreur : mieux vaut un appel qui échoue en le disant
 *  qu'un appel qui repart en silence vers le fournisseur par défaut. */
/** Le fournisseur imposé, tel que le déploiement le règle. OpenRouter est la
 *  connexion par défaut : une clé suffit, sans LLM_UPSTREAM. LLM_UPSTREAM=none
 *  rend l'ancien comportement (DeepSeek / Groq en direct) : "". */
export function upstreamKind(): string {
  const kind = env("LLM_UPSTREAM").toLowerCase() || (env("OPENROUTER_API_KEY") ? "openrouter" : "");
  return kind === "none" ? "" : kind;
}

export function pinnedUpstream(): PinnedUpstream | null {
  const kind = upstreamKind();
  if (!kind) return null;
  if (kind === "litellm") {
    const baseUrl = env("LLM_BASE_URL").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("LLM_UPSTREAM=litellm demande LLM_BASE_URL.");
    const model = env("LLM_MODEL_DEFAULT") || "ops-default";
    return {
      kind, baseUrl, model,
      heavyModel: env("LLM_MODEL_HEAVY") || model,
      lightModel: env("LLM_MODEL_LIGHT") || model,
      embeddingModel: env("LLM_EMBEDDING_MODEL") || null,
      reasoning: env("LLM_REASONING") === "1",
      routes: parseModelRoutes(env("LLM_MODEL_ROUTES")),
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
      lightModel: env("AZURE_OPENAI_DEPLOYMENT_LIGHT") || deployment,
      embeddingModel: env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT") || null,
      reasoning: env("AZURE_OPENAI_REASONING") === "1",
      routes: parseModelRoutes(env("LLM_MODEL_ROUTES")),
    };
  }
  if (kind === "runware") {
    if (!env("RUNWARE_API_KEY")) throw new Error("LLM_UPSTREAM=runware demande RUNWARE_API_KEY.");
    const model = env("RUNWARE_MODEL") || "openai:gpt@5.6-terra";
    return {
      kind,
      baseUrl: (env("RUNWARE_BASE_URL") || RUNWARE_DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model,
      heavyModel: env("RUNWARE_MODEL_HEAVY") || model,
      lightModel: env("RUNWARE_MODEL_LIGHT") || "openai:gpt@5.4-mini",
      // Pas d'embeddings chez Runware : jina.ts garde Jina.
      embeddingModel: null,
      // Décidé modèle par modèle (runwareDialect), pas pour toute la passerelle.
      reasoning: false,
      routes: parseModelRoutes(env("LLM_MODEL_ROUTES")),
    };
  }
  if (kind === "openrouter") {
    if (!env("OPENROUTER_API_KEY")) throw new Error("LLM_UPSTREAM=openrouter demande OPENROUTER_API_KEY.");
    // Mode gratuit (OPENROUTER_FREE_ONLY, défaut) : les modèles gratuits par
    // défaut, et tout modèle payant demandé par l'env retombe sur eux.
    if (openrouterFreeOnly()) {
      const F = OPENROUTER_FREE_ROUTES;
      // Les critères gratuits (code, vision…) ; les paliers viennent des champs
      // ci-dessous, qu'OPENROUTER_MODEL* peut régler.
      const { light: _l, standard: _s, heavy: _h, ...criteria } = F;
      return {
        kind,
        baseUrl: (env("OPENROUTER_BASE_URL") || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, ""),
        model: freeRoute(env("OPENROUTER_MODEL"), F.standard),
        heavyModel: freeRoute(env("OPENROUTER_MODEL_HEAVY"), F.heavy),
        lightModel: freeRoute(env("OPENROUTER_MODEL_LIGHT"), F.light),
        embeddingModel: null,
        reasoning: false,
        routes: { ...criteria, ...freeRoutes(parseModelRoutes(env("LLM_MODEL_ROUTES"))) },
      };
    }
    const model = env("OPENROUTER_MODEL") || "openai/gpt-5";
    return {
      kind,
      baseUrl: (env("OPENROUTER_BASE_URL") || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model,
      heavyModel: env("OPENROUTER_MODEL_HEAVY") || model,
      lightModel: env("OPENROUTER_MODEL_LIGHT") || "openai/gpt-5-mini",
      // Embeddings chez Jina, comme pour Runware (jina.ts).
      embeddingModel: null,
      reasoning: false,
      routes: parseModelRoutes(env("LLM_MODEL_ROUTES")),
    };
  }
  throw new Error(`LLM_UPSTREAM inconnu : « ${kind} » (attendu : litellm, azure, runware ou openrouter).`);
}

/** Le modèle (alias ou déploiement) qui répond à un modèle demandé par
 *  l'appelant. Les appelants parlent en modèles DeepSeek (deepseek-reasoner
 *  pour le palier lourd, voir model-router) : on garde la distinction lourd /
 *  courant, rien de plus. */
export function upstreamModelFor(up: PinnedUpstream, requested?: string | null): string {
  const heavy = env("AGENT_MODEL_HEAVY") || "deepseek-reasoner";
  const r = String(requested ?? "");
  // Une route (`@code|heavy`…) : la table du connecteur, ses trois paliers
  // compris. LIGHT_MODEL (« @light ») en est un cas particulier.
  if (isModelAlias(r)) return resolveModelAlias(r, upstreamRoutes(up), up.model)!;
  return r && (r === heavy || r.includes("reason")) ? up.heavyModel : up.model;
}

/** Toutes les routes de la passerelle imposée : ses trois paliers, puis ses
 *  routes par critère (qui peuvent aussi redéfinir un palier). */
export function upstreamRoutes(up: PinnedUpstream): ModelRoutes {
  return { light: up.lightModel, standard: up.model, heavy: up.heavyModel, ...up.routes };
}

function isUpstreamUrl(up: PinnedUpstream, url: string): boolean {
  return url === up.baseUrl || url.startsWith(`${up.baseUrl}/`);
}

export class LlmUpstreamPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUpstreamPolicyError";
  }
}

/**
 * Garde-fou de sortie. Sans passerelle imposée, tout passe. Avec, seule la
 * passerelle et les hôtes de LLM_ALLOWED_HOSTS sont joignables.
 *
 * `registered` : l'appel vise un connecteur que l'espace a lui-même enregistré
 * dans AI Ops → Modèles et choisi pour cet agent (OpenRouter, Runware…). Ce
 * choix explicite passe, sauf en périmètre strict (LLM_STRICT_PERIMETER=1,
 * installation chez un client où rien ne doit sortir hors de SA passerelle).
 * Sans ça, passer un agent sur OpenRouter échouait dès que LLM_UPSTREAM était
 * posé — même quand la passerelle imposée n'avait plus de crédit.
 */
export function assertAllowedLlmUrl(url: string, opts: { registered?: boolean } = {}): void {
  const up = pinnedUpstream();
  if (!up || isUpstreamUrl(up, url)) return;
  if (opts.registered && env("LLM_STRICT_PERIMETER") !== "1") return;
  let host = "";
  try { host = new URL(url).host; } catch { /* host reste vide : refusé */ }
  const extra = env("LLM_ALLOWED_HOSTS").split(",").map((h) => h.trim()).filter(Boolean);
  if (host && extra.includes(host)) return;
  throw new LlmUpstreamPolicyError(`Appel LLM vers ${host || url} refusé : ce déploiement n'autorise que ${new URL(up.baseUrl).host} (LLM_UPSTREAM=${up.kind}${opts.registered ? ", périmètre strict" : ""}).`);
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
export async function llmAuthHeaders(url: string, apiKey: string, opts: { registered?: boolean } = {}): Promise<Record<string, string>> {
  assertAllowedLlmUrl(url, opts);
  const up = pinnedUpstream();
  if (up && isUpstreamUrl(up, url)) {
    if (up.kind === "litellm") return { Authorization: `Bearer ${litellmKey()}` };
    if (up.kind === "runware") return { Authorization: `Bearer ${env("RUNWARE_API_KEY")}` };
    if (up.kind === "openrouter") return { Authorization: `Bearer ${env("OPENROUTER_API_KEY")}` };
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
 * Après un 401 : si l'appel portait un jeton Entra mis en cache, on le jette et
 * on rend des en-têtes frais (un jeton peut être révoqué avant son heure, ou
 * l'horloge du worker dériver). Null quand rien n'était en cache — une clé
 * d'API refusée le restera, inutile de réessayer.
 */
export async function refreshLlmAuthHeaders(url: string, apiKey: string): Promise<Record<string, string> | null> {
  if (!cachedToken) return null;
  cachedToken = null;
  return await llmAuthHeaders(url, apiKey);
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
export function adaptChatBody(url: string, raw: Record<string, unknown>): Record<string, unknown> {
  // La règle de typographie du propriétaire (pas de tirets longs) : sur tous
  // les chats, quel que soit le fournisseur (reply-format.ts).
  const body = withHouseStyle(raw);
  const up = pinnedUpstream();
  if (!up || !isUpstreamUrl(up, url)) {
    return isAzureUrl(url) ? azureDialect(body)
      : isRunwareUrl(url) ? runwareDialect(body)
      : isOpenRouterUrl(url) ? openrouterDialect(body)
      : singleModel(body);
  }
  const out = { ...body };
  // Les embeddings passent aussi par ici : seul un chat a un raisonnement.
  const chat = Array.isArray(out.messages);
  if (up.kind === "runware") return runwareDialect(out);
  if (up.kind === "openrouter") return openrouterDialect(out);
  Object.assign(out, singleModel(out));
  if (up.kind === "azure") {
    toCompletionLimit(out);
    if (up.reasoning && chat) reasoningDialect(out, "max_completion_tokens");
    return out;
  }
  if (up.reasoning && chat) reasoningDialect(out, "max_tokens");
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

/** An Azure OpenAI / AI Foundry host — a model registered in AI Ops (an agent's
 *  own endpoint) rather than the deployment's pinned upstream. */
function isAzureUrl(url: string): boolean {
  try {
    return /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(new URL(url).host);
  } catch { return false; }
}

/** Azure's dialect for a registered endpoint, where no AZURE_OPENAI_REASONING
 *  says what the deployment is: `max_completion_tokens` always (every current
 *  model takes it), and the reasoning dialect for a reasoning family (o-series,
 *  gpt-5 and later): only the default temperature, and room to think. */
function azureDialect(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  toCompletionLimit(out);
  if (/^(o\d|gpt-[5-9])/i.test(String(out.model ?? "")) && Array.isArray(out.messages)) {
    reasoningDialect(out, "max_completion_tokens");
  }
  return out;
}

/** Runware : l'API publique, ou celle que pointe RUNWARE_BASE_URL. */
export function isRunwareUrl(url: string): boolean {
  try {
    const host = new URL(url).host;
    if (host === "api.runware.ai") return true;
    const configured = env("RUNWARE_BASE_URL");
    return !!configured && host === new URL(configured).host;
  } catch { return false; }
}

/** Les modèles OpenAI de raisonnement servis par Runware (openai:gpt@5…, @6…, o-series). */
const RUNWARE_OPENAI_REASONING = /^openai:(gpt@[5-9]|o\d)/i;

/**
 * Le dialecte d'un chat envoyé à Runware. Runware transmet chaque paramètre
 * selon la référence de l'éditeur du modèle, donc :
 *   - OpenAI de raisonnement : `max_completion_tokens`, température par défaut
 *     seulement, et `reasoning_effort: "none"` dès que la requête porte des
 *     outils — ces modèles refusent sinon les outils de fonction (doc Runware,
 *     même contrainte que gpt-5.6-terra sur Azure). Sans outils, l'effort réglé
 *     (LLM_REASONING_EFFORT, JSON par identifiant AIR) et la marge de
 *     raisonnement s'appliquent comme ailleurs ;
 *   - les autres (Gemini, DeepSeek, MiniMax, GLM, Claude…) : `max_tokens` et
 *     `temperature` standard, l'effort réglé s'il y en a un.
 * Les embeddings ne passent jamais ici (pas de `messages`).
 */
export function runwareDialect(body: Record<string, unknown>): Record<string, unknown> {
  // Une route « a,b » : Runware ne connaît pas de repli, le premier sert.
  const out = singleModel({ ...body });
  if (!Array.isArray(out.messages)) return out;
  const model = String(out.model ?? "");
  if (RUNWARE_OPENAI_REASONING.test(model)) {
    toCompletionLimit(out);
    const hasTools = Array.isArray(out.tools) && out.tools.length > 0;
    if (out.reasoning_effort === undefined && hasTools) out.reasoning_effort = "none";
    reasoningDialect(out, "max_completion_tokens");
    return out;
  }
  if ("max_completion_tokens" in out && !("max_tokens" in out)) {
    out.max_tokens = out.max_completion_tokens;
    delete out.max_completion_tokens;
  }
  if (out.reasoning_effort === undefined) {
    const effort = reasoningEffortFor(model);
    if (effort) out.reasoning_effort = effort;
  }
  return out;
}

/** Une route « a,b,c » envoyée à un fournisseur sans repli natif : le premier
 *  modèle seulement. */
export function singleModel(body: Record<string, unknown>): Record<string, unknown> {
  return typeof body.model === "string" && body.model.includes(",") ? { ...body, model: primaryModel(body.model) } : body;
}

/** OpenRouter : l'API publique, ou celle que pointe OPENROUTER_BASE_URL. */
export function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).host;
    if (host === "openrouter.ai") return true;
    const configured = env("OPENROUTER_BASE_URL");
    return !!configured && host === new URL(configured).host;
  } catch { return false; }
}

/** Les modèles de raisonnement d'OpenAI chez OpenRouter (openai/gpt-5…, o-series). */
const OPENROUTER_OPENAI_REASONING = /^openai\/(gpt-[5-9]|o\d)/i;

/**
 * Le dialecte d'un chat envoyé à OpenRouter.
 *   - Une route « a,b,c » devient `model: a` + `models: [a, b, c]` : OpenRouter
 *     bascule seul sur le suivant quand un modèle est indisponible, saturé ou
 *     refuse la requête — le repli multi-modèles sans code de notre côté.
 *   - `usage: { include: true }` : la réponse porte le coût facturé
 *     (`usage.cost`), que le runtime préfère à son estimation.
 *   - L'effort de raisonnement réglé passe dans le champ unifié `reasoning`.
 *     Les modèles de raisonnement d'OpenAI n'acceptent que la température par
 *     défaut : elle est retirée pour eux.
 */
export function openrouterDialect(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  if (!Array.isArray(out.messages)) return singleModel(out);
  if (typeof out.model === "string" && out.model.includes(",")) {
    const list = out.model.split(",").map((m) => m.trim()).filter(Boolean);
    out.model = list[0];
    if (list.length > 1 && out.models === undefined) out.models = list.slice(0, 3);
  }
  if (out.usage === undefined) out.usage = { include: true };
  const model = String(out.model ?? "");
  if (OPENROUTER_OPENAI_REASONING.test(model)) delete out.temperature;
  // Claude et Gemini ne mettent en cache que derrière un point explicite :
  // sans lui, chaque tour d'une boucle d'agent repaie tout le préfixe
  // (outils + prompt système + transcrit), alors que le runtime fait tout pour
  // le garder stable (schémas collants, zone scellée, FOCUS éphémère).
  if (PROMPT_CACHE_MODELS.test(model) && env("LLM_PROMPT_CACHE") !== "0") {
    out.messages = withCacheBreakpoints(out.messages as Array<Record<string, unknown>>, model);
  }
  if (out.reasoning === undefined && out.reasoning_effort === undefined) {
    const effort = reasoningEffortFor(model);
    if (effort) out.reasoning = { effort };
  }
  return out;
}

// ── Cache de préfixe explicite (Anthropic, Gemini) ───────────────────────────
//
// OpenAI, DeepSeek et Azure cachent seuls tout préfixe répété. Claude (et
// Gemini via OpenRouter) ne le font que jusqu'à un point marqué
// `cache_control` dans le contenu d'un message — quatre au plus chez
// Anthropic. Deux suffisent à une boucle d'agent :
//   1. le message système, qui scelle avec lui les schémas d'outils (ils le
//      précèdent dans le préfixe) : la partie la plus lourde et la plus stable ;
//   2. le dernier message utilisateur ou texte : les tours suivants relisent
//      le préfixe jusque-là (Anthropic remonte jusqu'à 20 blocs pour le
//      retrouver) au lieu de le repayer.
// Un message dont le contenu n'est pas du texte simple (déjà en parties, ou
// vide) garde sa forme : on ne marque que ce qu'on peut marquer sans le
// transformer.

const PROMPT_CACHE_MODELS = /^(anthropic\/|google\/gemini)|claude/i;
const EPHEMERAL = { type: "ephemeral" } as const;

// Le point du message système dure une heure chez Claude (d'après eve). Le
// défaut de cinq minutes ne couvre pas un run qui attend une approbation, une
// réponse ou le tick suivant : il repayait alors tout le préfixe, outils et
// prompt système compris. L'écriture à 1 h coûte 2× le prix d'entrée au lieu de
// 1,25×, rentabilisée dès la deuxième relecture. Le point de queue garde cinq
// minutes : il bouge à chaque tour. Anthropic exige que les points longs
// précèdent les courts, ce qui est le cas. LLM_PROMPT_CACHE_TTL=5m revient à
// l'ancien comportement.
const LONG_CACHE_MODELS = /^anthropic\/|claude/i;
const EPHEMERAL_1H = { type: "ephemeral", ttl: "1h" } as const;

function markText(msg: Record<string, unknown>, mark: Record<string, unknown> = EPHEMERAL): Record<string, unknown> | null {
  const c = msg.content;
  if (typeof c === "string") {
    if (!c.trim()) return null;
    return { ...msg, content: [{ type: "text", text: c, cache_control: mark }] };
  }
  if (Array.isArray(c) && c.length) {
    const parts = c.map((p) => ({ ...(p as Record<string, unknown>) }));
    const last = parts[parts.length - 1];
    if (last.type !== "text" || !String(last.text ?? "").trim()) return null;
    last.cache_control = mark;
    return { ...msg, content: parts };
  }
  return null;
}

export function withCacheBreakpoints(
  messages: Array<Record<string, unknown>>,
  model = "",
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.map((m) => m);
  const sys = out.findIndex((m) => m.role === "system");
  const longTtl = LONG_CACHE_MODELS.test(model) && env("LLM_PROMPT_CACHE_TTL").toLowerCase() !== "5m";
  if (sys >= 0) out[sys] = markText(out[sys], longTtl ? EPHEMERAL_1H : EPHEMERAL) ?? out[sys];
  // Le dernier message marquable : un message utilisateur ou une réponse
  // texte. Ni un résultat d'outil (OpenRouter attend une chaîne pour le rôle
  // tool), ni un appel d'outil sans texte.
  for (let i = out.length - 1; i > sys; i--) {
    if (out[i].role === "tool") continue;
    if (out[i].role === "assistant" && Array.isArray(out[i].tool_calls) && !String(out[i].content ?? "").trim()) continue;
    const marked = markText(out[i]);
    if (marked) { out[i] = marked; break; }
  }
  return out;
}

/** Retire les points de cache d'un corps déjà adapté : le repli quand un
 *  fournisseur (ou un modèle de repli de la route) les refuse. Vrai s'il y en
 *  avait. */
export function stripCacheControl(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false;
  let found = false;
  body.messages = (body.messages as Array<Record<string, unknown>>).map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content as Array<Record<string, unknown>>;
    if (!parts.some((p) => p && "cache_control" in p)) return m;
    found = true;
    // Une seule partie texte : on rend la chaîne d'origine.
    if (parts.length === 1 && parts[0].type === "text") return { ...m, content: String(parts[0].text ?? "") };
    return { ...m, content: parts.map(({ cache_control: _c, ...rest }) => rest) };
  });
  return found;
}

/** Azure refuse `max_tokens` sur les modèles récents : `max_completion_tokens`. */
function toCompletionLimit(out: Record<string, unknown>): void {
  if (!("max_tokens" in out)) return;
  if (out.max_tokens !== undefined) out.max_completion_tokens = out.max_tokens;
  delete out.max_tokens;
}

/** L'effort de raisonnement réglé pour `model` : une valeur pour tous, ou un
 *  JSON par modèle. Vide : rien n'est envoyé, le modèle garde son défaut. */
export function reasoningEffortFor(model: string): string {
  // Sur Runware, le réglage Azure resté en secret ne vaut plus rien : ses clés
  // sont des noms de déploiement, et une valeur unique (« minimal ») partirait
  // vers des modèles Gemini ou DeepSeek qui ne la connaissent pas.
  const kind = upstreamKind();
  const raw = env("LLM_REASONING_EFFORT") || (
    kind === "runware" ? env("RUNWARE_REASONING_EFFORT")
      : kind === "openrouter" ? env("OPENROUTER_REASONING_EFFORT")
      : env("AZURE_OPENAI_REASONING_EFFORT"));
  if (!raw) return "";
  if (!raw.startsWith("{")) return raw;
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>)[model];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Ce qu'un modèle de raisonnement demande à un chat : la température par défaut
 * (toute autre valeur est refusée), l'effort réglé s'il y en a un, et une marge
 * sur le plafond de sortie, qui compte aussi les tokens de réflexion. Sans elle,
 * un appel court rend un texte vide (`finish_reason: length`). La marge ne
 * coûte rien quand le modèle ne s'en sert pas ; elle est inutile quand l'effort
 * est « none » ou « minimal ».
 */
function reasoningDialect(out: Record<string, unknown>, limitKey: "max_tokens" | "max_completion_tokens"): void {
  delete out.temperature;
  if (out.reasoning_effort === undefined) {
    const effort = reasoningEffortFor(String(out.model ?? ""));
    if (effort) out.reasoning_effort = effort;
  }
  const effort = String(out.reasoning_effort ?? "");
  const limit = Number(out[limitKey]);
  if (!Number.isFinite(limit) || limit <= 0 || effort === "none" || effort === "minimal") return;
  const raw = env("LLM_REASONING_HEADROOM");
  const headroom = raw === "" ? 1024 : Math.max(0, Number(raw) || 0);
  out[limitKey] = limit + headroom;
}
