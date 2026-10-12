// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/idp-directory.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno } from "../../compat/index.ts";

// Où trouver le fournisseur qui délègue et l'identité de chaque agent
// (docs/enterprise-generalisation.md G1, migration 0276).
//
// Réglés dans l'interface (Authentification → Délégation aux agents) :
//   · enterprise_sso_providers.delegation / token_endpoint / subject_claim,
//     et le secret du client du portail (enterprise_sso_provider_secrets) ;
//   · agent_idp_identities : le client de chaque agent auprès de l'IdP.
// Les secrets sont chiffrés en base et déchiffrés ici, côté serveur seulement.
//
// Repli : les variables KEYCLOAK_* et AGENT_IDP_CLIENTS (installation réglée
// avant G1). La base l'emporte quand les deux existent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "./crypto.ts";
import { idpConfig, IdpError, type Delegation, type IdpConfig } from "./idp-tokens.ts";

export interface AgentIdentity {
  client_id: string;
  client_secret: string;
  /** Entra ID : portée du jeton de la personne adressé à l'application de l'agent. */
  user_scope?: string | null;
}

export interface IdpDirectory {
  /** Les fournisseurs qui délèguent, secret du portail déchiffré. */
  providers(): Promise<IdpConfig[]>;
  /** Le client d'un agent auprès d'un fournisseur. */
  agentIdentity(agentId: string, providerId: string): Promise<AgentIdentity | null>;
  /** Tous les clients d'agents d'un fournisseur (découverte des tools). */
  agentIdentities(providerId: string): Promise<AgentIdentity[]>;
}

const TTL_MS = 60_000;
let providersCache: { at: number; value: Promise<IdpConfig[]> } | null = null;

/** Pour les tests, et après un changement de réglage (sso-admin). */
export function resetIdpDirectoryCache(): void {
  providersCache = null;
}

export function supabaseIdpDirectory(admin: SupabaseClient): IdpDirectory {
  return {
    providers() {
      if (providersCache && Date.now() - providersCache.at < TTL_MS) return providersCache.value;
      const value = (async () => {
        const { data, error } = await admin.from("enterprise_sso_providers")
          .select("id, auth_ref, issuer, client_id, delegation, token_endpoint, subject_claim, enabled, protocol")
          .neq("delegation", "none").eq("enabled", true).eq("protocol", "oidc");
        if (error) throw new Error(`enterprise_sso_providers : ${error.message}`);
        const rows = (data ?? []) as Array<{
          id: string; auth_ref: string; issuer: string | null; client_id: string | null; delegation: Delegation;
          token_endpoint: string | null; subject_claim: "sub" | "oid";
        }>;
        if (!rows.length) return [];
        const { data: secrets } = await admin.from("enterprise_sso_provider_secrets")
          .select("provider_id, secret_enc, iv").in("provider_id", rows.map((r) => r.id));
        const byId = new Map(((secrets ?? []) as Array<{ provider_id: string; secret_enc: string; iv: string }>).map((s) => [s.provider_id, s]));
        const out: IdpConfig[] = [];
        for (const r of rows) {
          const s = byId.get(r.id);
          if (!s || !r.issuer || !r.client_id || !r.token_endpoint) continue;
          out.push({
            provider: r.auth_ref,
            providerId: r.id,
            issuer: r.issuer.replace(/\/+$/, ""),
            tokenEndpoint: r.token_endpoint,
            delegation: r.delegation,
            subjectClaim: r.subject_claim === "oid" ? "oid" : "sub",
            portalClientId: r.client_id,
            portalClientSecret: await decryptSecret(s.secret_enc, s.iv),
          });
        }
        return out;
      })();
      providersCache = { at: Date.now(), value };
      value.catch(() => { if (providersCache?.value === value) providersCache = null; });
      return value;
    },
    async agentIdentity(agentId, providerId) {
      const { data } = await admin.from("agent_idp_identities")
        .select("client_id, secret_enc, iv, user_scope").eq("agent_id", agentId).eq("provider_id", providerId).maybeSingle();
      const r = data as { client_id: string; secret_enc: string; iv: string; user_scope: string | null } | null;
      return r ? { client_id: r.client_id, client_secret: await decryptSecret(r.secret_enc, r.iv), user_scope: r.user_scope } : null;
    },
    async agentIdentities(providerId) {
      const { data } = await admin.from("agent_idp_identities")
        .select("client_id, secret_enc, iv, user_scope").eq("provider_id", providerId);
      const rows = (data ?? []) as Array<{ client_id: string; secret_enc: string; iv: string; user_scope: string | null }>;
      return await Promise.all(rows.map(async (r) => ({ client_id: r.client_id, client_secret: await decryptSecret(r.secret_enc, r.iv), user_scope: r.user_scope })));
    },
  };
}

/**
 * Le fournisseur qui délègue. `provider` (auth_ref) le désigne quand
 * plusieurs délèguent ; sans lui, il faut qu'il n'y en ait qu'un.
 * Null : rien de configuré, ni en base ni par variables.
 */
export async function resolveIdpConfig(directory: IdpDirectory | null, provider?: string | null): Promise<IdpConfig | null> {
  const fromDb = directory ? await directory.providers() : [];
  if (provider) {
    const hit = fromDb.find((p) => p.provider === provider);
    if (hit) return hit;
    const env = idpConfig();
    return env && env.provider === provider ? env : null;
  }
  if (fromDb.length === 1) return fromDb[0];
  if (fromDb.length > 1) {
    throw new IdpError("ambiguous_provider", `Plusieurs fournisseurs délèguent (${fromDb.map((p) => p.provider).join(", ")}) : précisez-le sur la connexion.`);
  }
  return idpConfig();
}

// ── Repli par variables : AGENT_IDP_CLIENTS ──────────────────────────────────

let envClientsCache: Record<string, AgentIdentity> | null = null;

export function envAgentClients(): Record<string, AgentIdentity> {
  if (envClientsCache) return envClientsCache;
  const raw = (Deno.env.get("AGENT_IDP_CLIENTS") ?? "").trim();
  let parsed: unknown = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new IdpError("config", "AGENT_IDP_CLIENTS n'est pas un JSON valide."); }
  const out: Record<string, AgentIdentity> = {};
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    const c = v as Partial<AgentIdentity>;
    if (typeof c?.client_id === "string" && typeof c?.client_secret === "string") {
      out[key] = { client_id: c.client_id, client_secret: c.client_secret, user_scope: typeof c.user_scope === "string" ? c.user_scope : null };
    }
  }
  envClientsCache = out;
  return out;
}

export function resetEnvAgentClients(): void {
  envClientsCache = null;
}

/** Le client de l'agent pour ce fournisseur : en base, sinon AGENT_IDP_CLIENTS (id ou nom de l'agent). */
export async function resolveAgentIdentity(
  directory: IdpDirectory | null,
  cfg: IdpConfig,
  agent: { id: string; name?: string | null },
): Promise<AgentIdentity | null> {
  if (directory && cfg.providerId) {
    const hit = await directory.agentIdentity(agent.id, cfg.providerId);
    if (hit) return hit;
  }
  const env = envAgentClients();
  return env[agent.id] ?? (agent.name ? env[agent.name] : undefined) ?? null;
}

/** Tous les clients d'agents connus pour ce fournisseur (découverte des tools). */
export async function allAgentIdentities(directory: IdpDirectory | null, cfg: IdpConfig): Promise<AgentIdentity[]> {
  const fromDb = directory && cfg.providerId ? await directory.agentIdentities(cfg.providerId) : [];
  return fromDb.length ? fromDb : Object.values(envAgentClients());
}
