// Jeton d'appel des serveurs MCP (docs/openshift-implementation.md D3, D5 ;
// généralisé à tout IdP par docs/enterprise-generalisation.md G1).
//
// Pour chaque appel de tool vers un serveur en mode `token_exchange`, FounderOS
// demande à l'IdP de l'entreprise un jeton court pour ce seul serveur, qui porte
// la personne ET l'agent. Deux méthodes, selon le fournisseur qui délègue
// (idp-directory.ts) :
//
//   token_exchange  RFC 8693 (Keycloak, Okta, Ping, Auth0) :
//                   subject_token = le jeton de la personne (idp-tokens.ts) ;
//                   sans personne (exécution planifiée), celui du compte de
//                   service du client de l'agent ; client = le client de
//                   l'agent ; audience = le serveur ; scope = celui du tool au
//                   catalogue.
//   entra_obo       On-Behalf-Of d'Entra ID : le jeton de la personne adressé à
//                   l'application de l'agent (user_scope) est échangé par
//                   celle-ci contre un jeton pour le serveur (scope
//                   <audience>/.default). Sans personne : client credentials
//                   de l'application de l'agent.
//
// Le jeton obtenu vaut quelques minutes pour ce seul serveur ; il est mis en
// cache jusqu'à 30 s de son expiration. Il ne part que vers les hôtes de
// MCP_INTERNAL_HOSTS.
//
//   CATALOG_FILE        catalogue des tools (policies/catalog/data.json)
//   MCP_INTERNAL_HOSTS  motifs d'hôtes des serveurs MCP internes, ex. *.apps-int.*.interne.exemple
//   OPA_URL             pré-décision (facultatif) — le serveur MCP reste l'autorité

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  allAgentIdentities, envAgentClients, resetEnvAgentClients, resetIdpDirectoryCache, resolveAgentIdentity, resolveIdpConfig,
  supabaseIdpDirectory, type AgentIdentity, type IdpDirectory,
} from "./idp-directory.ts";
import {
  decodeJwtPayload, getUserIdpAccessToken, IdpError, idpRolesOf, postToken, supabaseIdpTokenStore,
  type IdpConfig, type IdpTokenStore,
} from "./idp-tokens.ts";
import { hostMatches, internalHostPatterns } from "./ssrf.ts";
import { signUserContext } from "./user-context.ts";

export interface McpTokenExchangeAuth {
  /** token_exchange : jeton émis par l'IdP (G1) ; signed_context : contexte signé par FounderOS (G2). */
  mode: "token_exchange" | "signed_context";
  audience: string;
  cluster?: string;
  /** Le fournisseur qui délègue (auth_ref), quand il y en a plusieurs. */
  provider?: string;
}

/** Repli par variables (AGENT_IDP_CLIENTS) : le client d'un agent par son id ou son nom. */
export function agentClientFor(agent: { id: string; name?: string | null }): AgentIdentity | null {
  const all = envAgentClients();
  return all[agent.id] ?? (agent.name ? all[agent.name] : undefined) ?? null;
}

// ── Catalogue ────────────────────────────────────────────────────────────────

export interface McpCatalog { scopes: Record<string, string>; tools: Record<string, string[]> }
let catalogCache: McpCatalog | null | undefined;

/** Null sans CATALOG_FILE. Lu une fois par processus. */
export async function loadMcpCatalog(): Promise<McpCatalog | null> {
  if (catalogCache !== undefined) return catalogCache;
  const file = (Deno.env.get("CATALOG_FILE") ?? "").trim();
  if (!file) return (catalogCache = null);
  const json = JSON.parse(await Deno.readTextFile(file)) as Partial<McpCatalog>;
  catalogCache = { scopes: json.scopes ?? {}, tools: json.tools ?? {} };
  return catalogCache;
}

// ── Hôtes autorisés ──────────────────────────────────────────────────────────

/**
 * Le serveur visé peut-il recevoir un jeton d'appel ? En direct : hôte interne
 * déclaré ; par le relais : https, ou la boucle locale du relais (passerelle
 * d'entreprise, G7 : le serveur MCP est dans le même pod, le trafic n'en sort pas).
 */
function assertMcpTarget(url: string, viaRelay?: boolean): void {
  if (viaRelay) {
    if (!isRelayReachableMcpUrl(url)) {
      throw new IdpError("host_not_allowed", `Jeton d'appel refusé : ${url} n'est ni en https, ni sur la boucle locale du relais.`);
    }
    return;
  }
  if (!isInternalMcpUrl(url)) {
    throw new IdpError("host_not_allowed", `Jeton d'appel refusé : ${url} n'est pas un serveur MCP interne (MCP_INTERNAL_HOSTS, https), ni joint par un relais.`);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Par un relais : https, ou http sur la boucle locale (le serveur MCP de la passerelle). */
export function isRelayReachableMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

export function isInternalMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hostMatches(u.hostname, internalHostPatterns());
  } catch {
    return false;
  }
}

// ── Jetons ───────────────────────────────────────────────────────────────────

const callTokenCache = new Map<string, { token: string; exp: number }>();
const serviceTokenCache = new Map<string, { token: string; exp: number }>();

/** Pour les tests. */
export function resetMcpAuthCaches(): void {
  callTokenCache.clear();
  serviceTokenCache.clear();
  catalogCache = undefined;
  resetEnvAgentClients();
  resetIdpDirectoryCache();
}

const expiry = (tokens: Record<string, unknown>) => Date.now() + Math.max(Number(tokens.expires_in) || 60, 30) * 1000;

/** Entra ID : une ressource se demande par sa portée « <id ou URI de l'application>/.default ». */
export const entraScopeFor = (audience: string) => (/\/\.default$/.test(audience) || audience.includes(" ") ? audience : `${audience}/.default`);

async function serviceToken(cfg: IdpConfig, client: AgentIdentity, scope?: string): Promise<string> {
  const key = `${cfg.provider}|${client.client_id}|${scope ?? ""}`;
  const hit = serviceTokenCache.get(key);
  if (hit && hit.exp - 30_000 > Date.now()) return hit.token;
  const tokens = await postToken(cfg, {
    grant_type: "client_credentials", client_id: client.client_id, client_secret: client.client_secret,
    ...(scope ? { scope } : {}),
  });
  const token = String(tokens.access_token ?? "");
  serviceTokenCache.set(key, { token, exp: expiry(tokens) });
  return token;
}

async function exchange(cfg: IdpConfig, client: AgentIdentity, subjectToken: string, audience: string, scope?: string) {
  try {
    return await postToken(cfg, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: client.client_id,
      client_secret: client.client_secret,
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience,
      ...(scope ? { scope } : {}),
    });
  } catch (err) {
    if (err instanceof IdpError) {
      throw new IdpError("exchange_refused", `L'IdP refuse l'échange vers ${audience} pour ${client.client_id} : ${err.message}`);
    }
    throw err;
  }
}

async function onBehalfOf(cfg: IdpConfig, client: AgentIdentity, assertion: string, audience: string) {
  try {
    return await postToken(cfg, {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: client.client_id,
      client_secret: client.client_secret,
      assertion,
      scope: entraScopeFor(audience),
      requested_token_use: "on_behalf_of",
    });
  } catch (err) {
    if (err instanceof IdpError) {
      throw new IdpError("exchange_refused", `Entra ID refuse l'On-Behalf-Of vers ${audience} pour ${client.client_id} : ${err.message}`);
    }
    throw err;
  }
}

export interface CallTokenRequest {
  /** La personne pour qui l'agent agit ; null : exécution planifiée. */
  userId: string | null;
  agent: { id: string; name?: string | null };
  audience: string;
  scope?: string;
  /** Le fournisseur qui délègue (auth_ref) ; absent : le seul qui délègue. */
  provider?: string | null;
}

/**
 * Jeton d'appel pour UN serveur. `store` et `directory` sont remplaçables pour
 * les tests ; sinon, ils lisent la base par `admin`.
 */
export async function mcpCallToken(
  admin: SupabaseClient | null,
  req: CallTokenRequest,
  store?: IdpTokenStore,
  directory?: IdpDirectory | null,
): Promise<string> {
  const dir = directory !== undefined ? directory : (admin ? supabaseIdpDirectory(admin) : null);
  const cfg = await resolveIdpConfig(dir, req.provider);
  if (!cfg) {
    throw new IdpError("not_configured", "Aucun fournisseur d'identité ne délègue aux agents (Administration → Authentification → Délégation, ou KEYCLOAK_*).");
  }
  const client = await resolveAgentIdentity(dir, cfg, req.agent);
  if (!client) {
    throw new IdpError("agent_client_missing", `Aucune identité auprès de l'IdP pour l'agent ${req.agent.name ?? req.agent.id} (Administration → Authentification → Identités des agents).`);
  }

  const key = `${cfg.provider}|${req.userId ?? "service"}|${client.client_id}|${req.audience}|${req.scope ?? ""}`;
  const hit = callTokenCache.get(key);
  if (hit && hit.exp - 30_000 > Date.now()) return hit.token;

  const users = () => store ?? supabaseIdpTokenStore(admin!);
  let tokens: Record<string, unknown>;
  if (cfg.delegation === "entra_obo") {
    if (req.userId) {
      // Le jeton de la personne adressé à l'application de l'agent, puis l'OBO.
      const assertion = await getUserIdpAccessToken(cfg, users(), req.userId, client.user_scope || `api://${client.client_id}/.default`);
      tokens = await onBehalfOf(cfg, client, assertion, req.audience);
    } else {
      // Exécution planifiée : l'application de l'agent seule (rôles d'application).
      tokens = { access_token: await serviceToken(cfg, client, entraScopeFor(req.audience)), expires_in: 300 };
    }
  } else {
    const subject = req.userId
      ? await getUserIdpAccessToken(cfg, users(), req.userId)
      : await serviceToken(cfg, client);
    tokens = await exchange(cfg, client, subject, req.audience, req.scope);
  }
  const token = String(tokens.access_token ?? "");
  callTokenCache.set(key, { token, exp: expiry(tokens) });
  return token;
}

/** traceparent W3C : un identifiant de trace par run (l'UUID du run), une étape par appel. */
export function traceparentFor(runId?: string | null): string {
  const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  const compact = (runId ?? "").replace(/-/g, "").toLowerCase();
  const traceId = /^[0-9a-f]{32}$/.test(compact) && !/^0+$/.test(compact) ? compact : hex(16);
  return `00-${traceId}-${hex(8)}-01`;
}

/**
 * En-têtes d'un appel de tool vers un serveur MCP en mode token_exchange ou
 * signed_context. `viaRelay` : le serveur est joint par le relais du client,
 * dont la liste blanche fait autorité (MCP_INTERNAL_HOSTS ne le connaît pas) ;
 * https reste exigé.
 */
export async function mcpRequestHeaders(
  admin: SupabaseClient | null,
  opts: {
    url: string; auth: McpTokenExchangeAuth; agent: { id: string; name?: string | null }; userId: string | null;
    tool?: string; runId?: string | null; viaRelay?: boolean;
  },
  store?: IdpTokenStore,
): Promise<Record<string, string>> {
  assertMcpTarget(opts.url, opts.viaRelay);
  const scope = opts.tool ? (await loadMcpCatalog())?.scopes[opts.tool] : undefined;
  const token = opts.auth.mode === "signed_context"
    ? await signUserContext(admin, { audience: opts.auth.audience, userId: opts.userId, agent: opts.agent, runId: opts.runId ?? null, scope: scope ?? null })
    : await mcpCallToken(admin, {
      userId: opts.userId, agent: opts.agent, audience: opts.auth.audience, scope, provider: opts.auth.provider,
    }, store);
  return {
    Authorization: `Bearer ${token}`,
    traceparent: traceparentFor(opts.runId),
    ...(opts.runId ? { "X-Session-Id": opts.runId } : {}),
  };
}

/**
 * Découverte des tools (tools/list) depuis l'interface : pas d'agent ni
 * d'utilisateur en jeu. On essaie le compte de service de chaque client d'agent
 * jusqu'à en trouver un que l'IdP autorise pour cette audience.
 */
export async function mcpDiscoveryHeaders(
  url: string,
  audience: string,
  opts: {
    admin?: SupabaseClient | null; provider?: string | null; directory?: IdpDirectory | null;
    viaRelay?: boolean; mode?: McpTokenExchangeAuth["mode"]; userId?: string | null;
  } = {},
): Promise<Record<string, string>> {
  assertMcpTarget(url, opts.viaRelay);
  // Contexte signé : FounderOS atteste la personne qui lance la découverte, au
  // nom d'un agent « founderos-discovery » (à autoriser dans ALLOWED_AGENTS).
  if (opts.mode === "signed_context") {
    const token = await signUserContext(opts.admin ?? null, {
      audience, userId: opts.userId ?? null, agent: { id: "founderos-discovery", name: "founderos-discovery" },
    });
    return { Authorization: `Bearer ${token}`, traceparent: traceparentFor() };
  }
  const dir = opts.directory !== undefined ? opts.directory : (opts.admin ? supabaseIdpDirectory(opts.admin) : null);
  const cfg = await resolveIdpConfig(dir, opts.provider);
  if (!cfg) throw new IdpError("not_configured", "Aucun fournisseur d'identité ne délègue aux agents (Administration → Authentification → Délégation, ou KEYCLOAK_*).");
  const errors: string[] = [];
  for (const client of await allAgentIdentities(dir, cfg)) {
    try {
      const token = cfg.delegation === "entra_obo"
        ? await serviceToken(cfg, client, entraScopeFor(audience))
        : String((await exchange(cfg, client, await serviceToken(cfg, client), audience)).access_token ?? "");
      return { Authorization: `Bearer ${token}`, traceparent: traceparentFor() };
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new IdpError("exchange_refused", errors.length ? errors.join(" ; ") : "Aucune identité d'agent configurée pour ce fournisseur.");
}

// ── Pré-décision OPA ─────────────────────────────────────────────────────────

export interface PreDecision { decision: "allow" | "deny" | "approval_required"; reason: string }

/**
 * Consulte OPA avant d'appeler le serveur MCP, avec les revendications du jeton
 * d'appel. Seul un refus est appliqué ici, pour épargner un aller-retour :
 * l'approbation et tout le reste se décident sur le serveur MCP, qui fait foi.
 * OPA injoignable : null, et l'appel part (le serveur refusera s'il le faut).
 */
export async function opaPreDecision(opts: { tool: string; cluster?: string; targetCluster?: string; callToken: string }): Promise<PreDecision | null> {
  const base = (Deno.env.get("OPA_URL") ?? "").trim().replace(/\/+$/, "");
  if (!base || !opts.cluster) return null;
  const claims = decodeJwtPayload(opts.callToken);
  // Keycloak : scope, azp, realm_access.roles. Entra ID : scp, azp (v2) ou appid (v1), roles.
  const scopes = typeof claims.scope === "string" ? claims.scope : typeof claims.scp === "string" ? claims.scp : "";
  const input = {
    tool: opts.tool,
    cluster: opts.cluster,
    target_cluster: opts.targetCluster ?? opts.cluster,
    params_hash: "",
    token: {
      sub: String(claims.sub ?? ""),
      azp: String(claims.azp ?? claims.appid ?? ""),
      scopes: scopes.split(" ").filter(Boolean),
      roles: idpRolesOf(opts.callToken),
    },
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${base}/v1/data/ai/tools`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }), signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const out = (await res.json()) as { result?: { decision?: string; reason?: string } };
    const d = out.result?.decision;
    return d === "allow" || d === "deny" || d === "approval_required" ? { decision: d, reason: out.result?.reason ?? d } : null;
  } catch {
    return null;
  }
}

/**
 * La personne pour qui l'agent agit : celle de la salle ou du lancement
 * (actingUserId), sinon celle de la conversation, sinon celle qui a déclenché
 * le run. Null : exécution planifiée, sans humain.
 */
export async function resolveRequester(ctx: {
  admin: SupabaseClient;
  actingUserId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  mcpRequester?: string | null;
}): Promise<string | null> {
  if (ctx.mcpRequester !== undefined) return ctx.mcpRequester;
  let who: string | null = ctx.actingUserId ?? null;
  if (!who && ctx.conversationId) {
    const { data } = await ctx.admin.from("internal_agent_conversations").select("user_id").eq("id", ctx.conversationId).maybeSingle();
    who = (data as { user_id?: string | null } | null)?.user_id ?? null;
  }
  if (!who && ctx.runId) {
    const { data } = await ctx.admin.from("internal_agent_runs").select("triggered_by").eq("id", ctx.runId).maybeSingle();
    who = (data as { triggered_by?: string | null } | null)?.triggered_by ?? null;
  }
  ctx.mcpRequester = who;
  return who;
}
