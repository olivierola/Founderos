// Ce qui fait d'un agent FounderOS un agent OpenCode (docs/harness-opencode,
// phase 2) : son prompt système, sa connexion au modèle, ses paliers.
//
//   prompt     — le même constructeur que l'ancien moteur (buildSystemPrompt) :
//                identité, entreprise, caractère, consignes, règles de réponse.
//                La mémoire et les skills arrivent avec le plugin de contexte.
//   connexion  — son connecteur AI Ops s'il en a un (URL + clé déchiffrée),
//                sinon la connexion par défaut de la plateforme (LLM_UPSTREAM,
//                OpenRouter en local).
//   paliers    — light / standard / heavy et les critères (code, vision, long
//                contexte) : ceux de l'agent par-dessus ceux du connecteur ou
//                de la plateforme ; « a,b,c » = a, puis b et c en repli
//                (natif chez OpenRouter, par le champ `models`).
//
// Le modèle d'un tour se choisit comme avant : le palier de la demande
// (classifyRequest, puis AgentPilot s'il est allumé) et son critère.

import type { SupabaseClient } from "@supabase/supabase-js";
import { judgeModelTier } from "../edge/_shared/agentpilot.ts";
import { decryptSecret } from "../edge/_shared/crypto.ts";
import {
  llmAuthHeaders, parseModelRoutes, pinnedUpstream, primaryModel, resolveModelAlias, routeAlias, upstreamRoutes,
} from "../edge/_shared/llm-upstream.ts";
import { classifyRequest, detectNeed } from "../edge/_shared/model-router.ts";
import { freeRoutes, openrouterFreeOnly } from "../edge/_shared/openrouter-catalog.ts";
import { loadSelfModel } from "../edge/_shared/self-model.ts";
import {
  buildSystemPrompt, loadAgentAndTools, loadCompanySection, type AgentRow,
} from "../edge/internal-agent-run/index.ts";

/** Le fournisseur et l'agent OpenCode d'une instance (une instance = un agent). */
export const PROVIDER_ID = "founderos";
export const AGENT_ID = "founderos";

export interface AgentConnection {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  /** OpenRouter : les replis d'une route passent par le champ `models`. */
  openrouter: boolean;
  /** D'où vient la connexion, pour la timeline. */
  source: "connector" | "server" | "platform";
}

export interface AgentProfile {
  agent: AgentRow;
  system: string;
  steps?: number;
  connection: AgentConnection;
  /** Route → « modèle » ou « a,b,c ». `standard` est toujours présente. */
  routes: Record<string, string>;
}

/** Ce que l'agent a sous la main, en attendant les outils FounderOS (phase 3). */
export const BUILTIN_CAPABILITIES = [
  "- read, glob, grep : lire et chercher dans ton dossier de travail.",
  "- write, edit : créer et modifier des fichiers dans ton dossier de travail.",
  "- webfetch, websearch : lire une page web, chercher sur le web.",
  "- question : poser une question à l'utilisateur quand tu ne peux vraiment pas avancer sans lui.",
  "- subagent : confier une sous-tâche indépendante à un sous-agent qui travaille en arrière-plan.",
].join("\n");

/** « Bearer xxx » → la clé ; les autres en-têtes restent des en-têtes. */
function splitAuth(headers: Record<string, string>): { apiKey: string; rest: Record<string, string> } {
  const rest: Record<string, string> = {};
  let apiKey = "";
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") apiKey = v.replace(/^Bearer\s+/i, "");
    else if (k.toLowerCase() !== "content-type") rest[k] = v;
  }
  return { apiKey, rest };
}

async function connectionOf(admin: SupabaseClient, agent: AgentRow): Promise<{ connection: AgentConnection; routes: Record<string, string> }> {
  const agentRoutes = parseModelRoutes(agent.model_routes ?? {}) as Record<string, string>;
  // 1) Son connecteur AI Ops : URL, clé chiffrée, routes du connecteur.
  if (agent.hosted_provider_id) {
    const { data: p } = await admin.from("aiops_providers")
      .select("config, secret_ciphertext, secret_iv").eq("id", agent.hosted_provider_id).maybeSingle();
    const config = ((p as { config?: Record<string, unknown> } | null)?.config ?? {}) as { base_url?: string; model_routes?: unknown };
    const baseURL = String(config.base_url ?? "").replace(/\/+$/, "");
    if (!baseURL) throw new Error("le connecteur de l'agent n'a pas d'URL");
    let apiKey = "";
    const secret = p as { secret_ciphertext?: string; secret_iv?: string } | null;
    if (secret?.secret_ciphertext && secret.secret_iv) apiKey = await decryptSecret(secret.secret_ciphertext, secret.secret_iv);
    const routes = { ...(parseModelRoutes(config.model_routes) as Record<string, string>), ...agentRoutes };
    if (agent.hosted_model) routes.standard ??= agent.hosted_model;
    if (!routes.standard) throw new Error("le connecteur de l'agent n'a pas de modèle par défaut");
    return {
      connection: { baseURL, apiKey, headers: {}, openrouter: /openrouter\.ai/.test(baseURL), source: "connector" },
      routes,
    };
  }
  // 2) Un serveur GPU auto-hébergé : un seul modèle.
  if (agent.hosted_endpoint_url && agent.hosted_model) {
    return {
      connection: {
        baseURL: agent.hosted_endpoint_url.replace(/\/+$/, ""), apiKey: process.env.RUNPOD_VLLM_API_KEY ?? "",
        headers: {}, openrouter: false, source: "server",
      },
      routes: { standard: agent.hosted_model },
    };
  }
  // 3) La connexion par défaut de la plateforme, avec les routes de l'agent par-dessus.
  const up = pinnedUpstream();
  if (!up) throw new Error("aucune connexion LLM par défaut (LLM_UPSTREAM) pour cet agent");
  const openrouter = up.kind === "openrouter";
  const own = openrouter && openrouterFreeOnly() ? freeRoutes(agentRoutes) : agentRoutes;
  const routes = { ...(upstreamRoutes(up) as Record<string, string>), ...own };
  routes.standard ??= up.model;
  const { apiKey, rest } = splitAuth(await llmAuthHeaders(`${up.baseUrl}/chat/completions`, ""));
  return { connection: { baseURL: up.baseUrl.replace(/\/+$/, ""), apiKey, headers: rest, openrouter, source: "platform" }, routes };
}

/** Le profil complet d'un agent : relu à chaque tour (il peut avoir changé). */
export async function loadAgentProfile(admin: SupabaseClient, agentId: string): Promise<AgentProfile> {
  const { agent } = await loadAgentAndTools(agentId);
  const [company, selfModel, link] = await Promise.all([
    loadCompanySection(admin as never, agent).catch(() => null),
    loadSelfModel(admin as never, agent as never).catch(() => ""),
    connectionOf(admin, agent),
  ]);
  const { prompt } = buildSystemPrompt(
    agent, BUILTIN_CAPABILITIES, "chat", "", "", [], "", false, "", undefined, false, company, undefined, selfModel,
  );
  const steps = Number(agent.max_steps);
  return {
    agent,
    system: prompt,
    // max_steps compte des étapes de plan ; une étape coûte plusieurs tours de modèle.
    steps: Number.isFinite(steps) && steps > 0 ? Math.min(Math.max(Math.round(steps * 15), 60), 400) : undefined,
    connection: link.connection,
    routes: link.routes,
  };
}

/** Les modèles à déclarer chez le fournisseur : le premier de chaque route,
 *  avec ses replis (OpenRouter) dans le corps de la requête. */
export function profileModels(profile: AgentProfile): Array<{ id: string; fallbacks: string[] }> {
  const out = new Map<string, string[]>();
  for (const value of Object.values(profile.routes)) {
    const list = String(value).split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length || out.has(list[0])) continue;
    out.set(list[0], profile.connection.openrouter ? list.slice(0, 3) : []);
  }
  return [...out.entries()].map(([id, fallbacks]) => ({ id, fallbacks }));
}

/** Le modèle d'une route (« @code|heavy » → le premier modèle qui y répond). */
export function modelForRoute(profile: AgentProfile, tier: "light" | "standard" | "heavy", need?: string | null): string {
  const value = resolveModelAlias(routeAlias(tier, need), profile.routes, profile.routes.standard) ?? profile.routes.standard;
  return primaryModel(value);
}

/**
 * Le modèle d'un tour : le palier de la demande (classifyRequest), confirmé ou
 * relevé par AgentPilot quand il est allumé, et son critère (code, vision,
 * long contexte). Un modèle choisi dans le composer l'emporte.
 */
export async function chooseTurnModel(
  admin: SupabaseClient,
  profile: AgentProfile,
  text: string,
  opts: { composer?: string | null; runId?: string | null; contextChars?: number } = {},
): Promise<{ model: string; tier: "light" | "standard" | "heavy"; need: string | null }> {
  const composer = String(opts.composer ?? "").trim();
  if (composer && !composer.startsWith("@")) return { model: composer, tier: "standard", need: null };
  const cls = classifyRequest(text, { mode: "chat" });
  const need = detectNeed(text, { contextChars: opts.contextChars });
  const judged = await judgeModelTier(
    { admin: admin as never, workspaceId: profile.agent.workspace_id, projectId: profile.agent.project_id, runId: opts.runId ?? null, agentId: profile.agent.id },
    text, cls.model, "chat",
  ).catch(() => null);
  const tier = judged ?? cls.model;
  return { model: modelForRoute(profile, tier, need), tier, need };
}
