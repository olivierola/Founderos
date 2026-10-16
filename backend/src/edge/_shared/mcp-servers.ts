// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/mcp-servers.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Les serveurs MCP d'un run, prêts à appeler : en-têtes statiques déchiffrés,
// jeton OAuth rafraîchi, jeton d'API, outils filtrés par le catalogue.
//
// Deux sources :
//   - les serveurs ACTIVÉS sur l'agent (agent_mcp_servers) : tous leurs outils ;
//   - les serveurs ACCORDÉS au run (internal_agent_runs.mcp_grants, 0286) : ceux
//     qu'un workflow a choisis pour ses étapes, limités aux outils choisis. Une
//     délégation et un sous-agent héritent des accès du run qui les lance.
//
// Partagé par le moteur d'agents (internal-agent-run) et par le moteur
// d'automatisation (automation-engine), qui appelle un outil MCP sans agent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureAccessToken } from "./mcp-oauth.ts";
import { loadMcpCatalog, type McpTokenExchangeAuth } from "./mcp-auth.ts";
import { loadMcpApiTokens } from "./mcp-api-token.ts";
import { loadMcpHeaders, mergeMcpHeaders } from "./mcp-headers.ts";
import type { McpGrant } from "./workflow-doc.ts";

export type { McpGrant };

export type LoadedMcpServer = {
  id: string; name: string; url: string; headers: Record<string, string>;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  auth?: McpTokenExchangeAuth;
  /** Joint par le relais du client (G2). */
  relayId?: string | null;
  environment?: string | null;
  /** Jeton d'API du serveur (0278), déchiffré ici, jamais montré au modèle. */
  apiToken?: { token: string; audience: string | null; cluster: string | null };
};

// deno-lint-ignore no-explicit-any
type ServerRow = any;

const SERVER_COLUMNS = "id, workspace_id, name, url, enabled, cached_tools, auth_mode, auth_config, oauth, relay_id, environment";

/** Les accès MCP d'un run, nettoyés. Une valeur illisible n'accorde rien. */
export function parseMcpGrants(v: unknown): McpGrant[] {
  if (!Array.isArray(v)) return [];
  const out: McpGrant[] = [];
  for (const g of v.slice(0, 20)) {
    const o = (g ?? {}) as Record<string, unknown>;
    const id = typeof o.server_id === "string" ? o.server_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(id) || out.some((x) => x.server_id === id)) continue;
    const tools = (Array.isArray(o.tools) ? o.tools : []).filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(t));
    out.push({ server_id: id, tools: [...new Set(tools)].slice(0, 100) });
  }
  return out;
}

/** Les accès MCP portés par un run (rien si le run n'en a pas). */
export async function runMcpGrants(admin: SupabaseClient, runId: string | null | undefined): Promise<McpGrant[]> {
  if (!runId) return [];
  const { data } = await admin.from("internal_agent_runs").select("mcp_grants").eq("id", runId).maybeSingle();
  return parseMcpGrants((data as { mcp_grants?: unknown } | null)?.mcp_grants);
}

/**
 * Les accès qu'un workflow peut réellement accorder : seulement des serveurs de
 * SON espace de travail, activés. Un serveur supprimé ou désactivé depuis la
 * rédaction du workflow est ignoré plutôt que de faire échouer le run.
 */
export async function validateMcpGrants(admin: SupabaseClient, workspaceId: string, grants: McpGrant[]): Promise<McpGrant[]> {
  if (!grants.length) return [];
  const { data } = await admin.from("mcp_servers").select("id")
    .eq("workspace_id", workspaceId).eq("enabled", true).in("id", grants.map((g) => g.server_id));
  const ok = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  return grants.filter((g) => ok.has(g.server_id));
}

/** Prépare des lignes mcp_servers pour l'appel. Un serveur inutilisable (jeton
 *  absent, audience manquante) n'est pas exposé. */
export async function prepareMcpServers(admin: SupabaseClient, rows: ServerRow[]): Promise<LoadedMcpServer[]> {
  const enabled = rows.filter((s) => s && s.enabled);
  const apiTokens = await loadMcpApiTokens(admin, enabled.filter((s) => s.auth_mode === "api_token").map((s) => s.id));
  // En-têtes statiques (0280) : déchiffrés ici, jamais lus depuis mcp_servers.headers.
  const staticHeaders = await loadMcpHeaders(admin, enabled.map((s) => s.id));
  const out: LoadedMcpServer[] = [];
  for (const s of enabled) {
    let headers: Record<string, string> = { ...(staticHeaders.get(s.id) ?? {}) };
    let tools: LoadedMcpServer["tools"] = Array.isArray(s.cached_tools) ? s.cached_tools : [];
    let auth: McpTokenExchangeAuth | undefined;
    // OAuth servers: inject a fresh Bearer token (refreshed if near expiry).
    if (s.auth_mode === "oauth") {
      const token = await ensureAccessToken(admin, { id: s.id, oauth: s.oauth || {} });
      if (token) headers = mergeMcpHeaders(headers, { Authorization: `Bearer ${token}` });
    }
    // Échange de jeton : le jeton se demande à chaque appel (mcp-auth.ts), et
    // seuls les tools du catalogue existent pour l'agent — un tool que le
    // serveur annoncerait sans être au catalogue n'est pas exposé.
    // Contexte signé (G2) : même configuration, jeton signé par FounderOS.
    if (s.auth_mode === "token_exchange" || s.auth_mode === "signed_context") {
      const cfg = (s.auth_config ?? {}) as { audience?: string; cluster?: string; provider?: string };
      if (!cfg.audience) continue;
      auth = {
        mode: s.auth_mode, audience: cfg.audience,
        ...(cfg.cluster ? { cluster: cfg.cluster } : {}), ...(cfg.provider ? { provider: cfg.provider } : {}),
      };
      const catalog = await loadMcpCatalog();
      if (catalog) {
        const onCluster = cfg.cluster ? new Set(catalog.tools[cfg.cluster] ?? []) : null;
        tools = tools.filter((t) => catalog.scopes[t.name] && (!onCluster || onCluster.has(t.name)));
      }
    }
    // Jeton d'API (le mode par défaut des serveurs internes) : présenté à chaque appel.
    let apiToken: LoadedMcpServer["apiToken"];
    if (s.auth_mode === "api_token") {
      const token = apiTokens.get(s.id);
      if (!token) continue; // jeton jamais saisi, ou illisible : le serveur n'est pas exposé
      const cfg = (s.auth_config ?? {}) as { audience?: string; cluster?: string };
      apiToken = { token, audience: cfg.audience ?? null, cluster: cfg.cluster ?? null };
      const catalog = await loadMcpCatalog();
      if (catalog && cfg.cluster) {
        const onCluster = new Set(catalog.tools[cfg.cluster] ?? []);
        tools = tools.filter((t) => catalog.scopes[t.name] && onCluster.has(t.name));
      }
    }
    out.push({
      id: s.id, name: s.name, url: s.url, headers, tools, ...(auth ? { auth } : {}), ...(apiToken ? { apiToken } : {}),
      relayId: s.relay_id ?? null, environment: s.environment ?? null,
    });
  }
  return out;
}

/**
 * Les serveurs MCP d'un agent pour ce run : ceux qu'on lui a activés (tous leurs
 * outils), plus ceux que le run porte (limités aux outils accordés). Un serveur
 * à la fois activé et accordé garde l'accès complet de l'activation.
 */
export async function loadRunMcpServers(admin: SupabaseClient, agentId: string, runId?: string | null): Promise<LoadedMcpServer[]> {
  const { data } = await admin.from("agent_mcp_servers").select(`server:mcp_servers(${SERVER_COLUMNS})`).eq("agent_id", agentId);
  const activated = ((data ?? []) as Array<{ server: ServerRow }>).map((r) => r.server).filter(Boolean);
  const activatedIds = new Set(activated.map((s) => s.id));

  const grants = (await runMcpGrants(admin, runId)).filter((g) => !activatedIds.has(g.server_id));
  let granted: ServerRow[] = [];
  if (grants.length) {
    // Même espace que l'agent : un accès recopié d'un autre espace n'ouvre rien.
    const { data: agent } = await admin.from("internal_agents").select("workspace_id").eq("id", agentId).maybeSingle();
    const ws = (agent as { workspace_id?: string } | null)?.workspace_id;
    if (ws) {
      const { data: rows } = await admin.from("mcp_servers").select(SERVER_COLUMNS)
        .eq("workspace_id", ws).in("id", grants.map((g) => g.server_id));
      granted = (rows ?? []) as ServerRow[];
    }
  }

  const servers = await prepareMcpServers(admin, [...activated, ...granted]);
  const limit = new Map(grants.map((g) => [g.server_id, g.tools]));
  return servers.map((s) => {
    const only = limit.get(s.id);
    return only && only.length ? { ...s, tools: s.tools.filter((t) => only.includes(t.name)) } : s;
  });
}

/** Un serveur d'un espace, prêt à appeler (moteur d'automatisation). */
export async function loadWorkspaceMcpServer(admin: SupabaseClient, workspaceId: string, serverId: string): Promise<LoadedMcpServer | null> {
  const { data } = await admin.from("mcp_servers").select(SERVER_COLUMNS).eq("workspace_id", workspaceId).eq("id", serverId).maybeSingle();
  if (!data) return null;
  const [server] = await prepareMcpServers(admin, [data]);
  return server ?? null;
}
