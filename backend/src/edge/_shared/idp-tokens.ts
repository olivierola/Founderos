// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/idp-tokens.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno } from "../../compat/index.ts";

// Le jeton de la personne auprès de l'IdP de l'entreprise, conservé côté serveur
// (docs/openshift-implementation.md D2, généralisé par docs/enterprise-generalisation.md G1).
//
// La connexion passe par Supabase Auth, qui reçoit les jetons de l'IdP et ne
// les garde pas. Au retour du SSO, le navigateur les voit une fois
// (session.provider_refresh_token) et remet le jeton de rafraîchissement au
// backend (fonction idp-token), qui :
//   · le rafraîchit aussitôt — preuve qu'il est valide, et rotation : celui que
//     le navigateur a vu ne sert plus ;
//   · vérifie que la personne de l'IdP (`sub`, ou `oid` chez Entra ID) est
//     celle de l'identité de l'utilisateur connecté, pour qu'on ne puisse pas
//     déposer le jeton de quelqu'un d'autre ;
//   · le garde chiffré (user_idp_tokens), jamais renvoyé au navigateur.
//
// Ensuite, chaque appel d'outil obtient un jeton d'accès frais par
// rafraîchissement (le client du portail, celui de Supabase Auth), mis en cache
// jusqu'à 30 s de son expiration. Beaucoup d'IdP font tourner le jeton de
// rafraîchissement à chaque usage ; deux répliques qui rafraîchissent en même
// temps se départagent par relecture de la ligne.
//
// Le fournisseur qui délègue se règle dans l'interface (Authentification →
// Délégation aux agents, idp-directory.ts). Les variables d'environnement
// restent un repli, pour une installation réglée ainsi (Keycloak) :
//   KEYCLOAK_ISSUER            https://keycloak…/realms/platform
//   KEYCLOAK_PROVIDER          fournisseur dans Supabase Auth (défaut custom:keycloak)
//   KEYCLOAK_PORTAL_CLIENT_ID  client confidentiel utilisé par Supabase Auth (défaut ai-portal)
//   KEYCLOAK_PORTAL_SECRET     son secret

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "./crypto.ts";

/** Comment l'IdP émet un jeton au nom d'une personne pour un outil. */
export type Delegation = "token_exchange" | "entra_obo";

export interface IdpConfig {
  /** Le fournisseur dans Supabase Auth (« custom:keycloak »). */
  provider: string;
  issuer: string;
  tokenEndpoint: string;
  delegation: Delegation;
  /** Claim qui identifie la personne : `sub`, ou `oid` chez Entra ID. */
  subjectClaim: "sub" | "oid";
  portalClientId: string;
  portalClientSecret: string;
  /** La ligne enterprise_sso_providers ; absente pour la configuration par variables. */
  providerId?: string;
  /** Point de révocation, s'il est connu (Keycloak). Sinon : document de découverte. */
  revocationEndpoint?: string;
}

/** Repli par variables d'environnement (Keycloak). Null : rien de configuré ainsi. */
export function idpConfig(): IdpConfig | null {
  const issuer = (Deno.env.get("KEYCLOAK_ISSUER") ?? "").trim().replace(/\/+$/, "");
  const secret = (Deno.env.get("KEYCLOAK_PORTAL_SECRET") ?? "").trim();
  if (!issuer || !secret) return null;
  return {
    issuer,
    provider: (Deno.env.get("KEYCLOAK_PROVIDER") ?? "").trim() || "custom:keycloak",
    tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
    revocationEndpoint: `${issuer}/protocol/openid-connect/revoke`,
    delegation: "token_exchange",
    subjectClaim: "sub",
    portalClientId: (Deno.env.get("KEYCLOAK_PORTAL_CLIENT_ID") ?? "").trim() || "ai-portal",
    portalClientSecret: secret,
  };
}

export class IdpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IdpError";
  }
}

export const tokenEndpoint = (cfg: IdpConfig) => cfg.tokenEndpoint;

/** Charge utile d'un JWT, sans vérification : seulement pour un jeton que l'on vient de recevoir de l'IdP. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST x-www-form-urlencoded vers le point de jeton ; l'erreur OAuth est remontée telle quelle. */
export async function postToken(cfg: IdpConfig, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    // Entra ID renvoie aussi `error_codes` ; le message lisible est error_description.
    throw new IdpError(String(json.error ?? `http_${res.status}`), String(json.error_description ?? json.error ?? `IdP ${res.status}`).slice(0, 500));
  }
  return json;
}

/**
 * La personne désignée par un jeton d'appel : `oid` s'il existe (Entra ID, dont
 * le `sub` change d'une application à l'autre), sinon `sub`. Les serveurs MCP
 * lisent la même chose (MCP/src/lib/auth.ts) : la règle des quatre yeux compare
 * des identités comparables.
 */
export function subjectOfClaims(claims: Record<string, unknown>): string {
  if (typeof claims.oid === "string" && claims.oid) return claims.oid;
  return typeof claims.sub === "string" ? claims.sub : "";
}

/** Rôles d'un jeton : `realm_access.roles` (Keycloak) et `roles` (Entra ID, rôles d'application). */
export function idpRolesOf(token: string): string[] {
  const p = decodeJwtPayload(token);
  const realm = (p.realm_access as { roles?: unknown } | undefined)?.roles;
  const all = [...(Array.isArray(realm) ? realm : []), ...(Array.isArray(p.roles) ? p.roles : [])];
  return [...new Set(all.filter((r): r is string => typeof r === "string"))];
}

/** Ancien nom, gardé pour les appelants existants. */
export const realmRolesOf = idpRolesOf;

/**
 * Les rôles ET les groupes (claim `groups` : chemins Keycloak « /Ops », objets
 * Entra) : ce qu'une règle d'approbation peut nommer (G3). À ne pas confondre
 * avec idpRolesOf, qui doit rester ce que le serveur MCP et OPA lisent.
 */
export function idpRolesAndGroupsOf(token: string): string[] {
  const groups = decodeJwtPayload(token).groups;
  const all = [...idpRolesOf(token), ...(Array.isArray(groups) ? groups : [])];
  return [...new Set(all.filter((r): r is string => typeof r === "string" && r.length > 0))].slice(0, 200);
}

// ── Stockage ────────────────────────────────────────────────────────────────

export interface StoredIdpToken {
  refresh_enc: string;
  iv: string;
  source_hash: string | null;
  idp_subject: string;
}

export interface IdpTokenStore {
  get(userId: string, provider: string): Promise<StoredIdpToken | null>;
  put(userId: string, provider: string, row: StoredIdpToken & { refreshed: boolean }): Promise<void>;
  remove(userId: string, provider: string): Promise<void>;
  /** Rôles relevés dans un jeton d'accès frais (0275, approbateurs). */
  recordRoles?(userId: string, provider: string, roles: string[]): Promise<void>;
}

/** Au mieux : un relevé de rôles manqué ne doit pas faire échouer un appel. */
async function noteRoles(store: IdpTokenStore, userId: string, provider: string, access: string): Promise<void> {
  try { await store.recordRoles?.(userId, provider, idpRolesAndGroupsOf(access)); } catch { /* au mieux */ }
}

export function supabaseIdpTokenStore(admin: SupabaseClient): IdpTokenStore {
  return {
    async get(userId, provider) {
      const { data } = await admin.from("user_idp_tokens")
        .select("refresh_enc, iv, source_hash, idp_subject")
        .eq("user_id", userId).eq("provider", provider).maybeSingle();
      return (data as StoredIdpToken | null) ?? null;
    },
    async put(userId, provider, row) {
      const now = new Date().toISOString();
      const { error } = await admin.from("user_idp_tokens").upsert({
        user_id: userId, provider,
        refresh_enc: row.refresh_enc, iv: row.iv, source_hash: row.source_hash, idp_subject: row.idp_subject,
        updated_at: now, ...(row.refreshed ? { last_refreshed_at: now } : {}),
      });
      if (error) throw new Error(`user_idp_tokens : ${error.message}`);
    },
    async remove(userId, provider) {
      await admin.from("user_idp_tokens").delete().eq("user_id", userId).eq("provider", provider);
    },
    async recordRoles(userId, provider, roles) {
      await admin.from("user_idp_roles").upsert({
        user_id: userId, provider, roles: [...new Set(roles)].sort(), updated_at: new Date().toISOString(),
      });
    },
  };
}

// ── Jetons ───────────────────────────────────────────────────────────────────

const accessCache = new Map<string, { token: string; exp: number }>();
const inflight = new Map<string, Promise<string>>();
// Un jeton par fournisseur, personne et portée : Entra ID émet un jeton par
// ressource demandée.
const cacheKey = (cfg: IdpConfig, userId: string, scope?: string) => `${cfg.provider}|${userId}|${scope ?? ""}`;

function cacheAccess(key: string, token: string, expiresIn: unknown): void {
  const exp = Date.now() + Math.max(Number(expiresIn) || 60, 60) * 1000;
  accessCache.set(key, { token, exp });
}

/** Pour les tests et la déconnexion. */
export function forgetUserAccessToken(userId?: string): void {
  if (!userId) {
    accessCache.clear();
    return;
  }
  for (const k of [...accessCache.keys()]) if (k.split("|")[1] === userId) accessCache.delete(k);
}

async function refresh(cfg: IdpConfig, refreshToken: string, scope?: string) {
  return await postToken(cfg, {
    grant_type: "refresh_token",
    client_id: cfg.portalClientId,
    client_secret: cfg.portalClientSecret,
    refresh_token: refreshToken,
    ...(scope ? { scope } : {}),
  });
}

/** La personne désignée par une réponse de l'IdP : jeton d'identité s'il y en a un, sinon jeton d'accès. */
function subjectOf(cfg: IdpConfig, tokens: Record<string, unknown>): string {
  for (const t of [tokens.id_token, tokens.access_token]) {
    if (typeof t !== "string" || !t) continue;
    const v = decodeJwtPayload(t)[cfg.subjectClaim];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * Dépose le jeton de rafraîchissement remis par le navigateur.
 * `expectedSubject` : la personne de l'IdP selon l'identité de l'utilisateur
 * dans Supabase Auth (claim `subjectClaim`).
 */
export async function storeUserRefreshToken(
  cfg: IdpConfig,
  store: IdpTokenStore,
  userId: string,
  refreshToken: string,
  expectedSubject: string,
): Promise<{ stored: boolean; reason?: string }> {
  const sourceHash = await sha256Hex(refreshToken);
  const existing = await store.get(userId, cfg.provider);
  // Le navigateur garde la session : il peut renvoyer un jeton déjà déposé (et
  // déjà tourné). Le rafraîchir échouerait, l'écraser ferait perdre le bon.
  if (existing?.source_hash === sourceHash) return { stored: false, reason: "already_stored" };

  const tokens = await refresh(cfg, refreshToken);
  const access = String(tokens.access_token ?? "");
  const subject = subjectOf(cfg, tokens);
  if (!subject || subject !== expectedSubject) {
    throw new IdpError("subject_mismatch", "Ce jeton n'appartient pas à l'utilisateur connecté.");
  }
  const rotated = String(tokens.refresh_token ?? refreshToken);
  const { ciphertext, iv } = await encryptSecret(rotated);
  await store.put(userId, cfg.provider, { refresh_enc: ciphertext, iv, source_hash: sourceHash, idp_subject: subject, refreshed: true });
  cacheAccess(cacheKey(cfg, userId), access, tokens.expires_in);
  await noteRoles(store, userId, cfg.provider, access);
  return { stored: true };
}

/**
 * Jeton d'accès frais de la personne (client du portail). `scope` : la
 * ressource visée, quand l'IdP émet un jeton par ressource (Entra ID : le
 * jeton adressé à l'application de l'agent, avant l'On-Behalf-Of).
 */
export function getUserIdpAccessToken(cfg: IdpConfig, store: IdpTokenStore, userId: string, scope?: string): Promise<string> {
  const key = cacheKey(cfg, userId, scope);
  const hit = accessCache.get(key);
  if (hit && hit.exp - 30_000 > Date.now()) return Promise.resolve(hit.token);
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    let row = await store.get(userId, cfg.provider);
    if (!row) {
      throw new IdpError("no_session", "Aucune session SSO conservée pour cette personne : elle doit se reconnecter par le SSO de l'entreprise.");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await decryptSecret(row.refresh_enc, row.iv);
      try {
        const tokens = await refresh(cfg, current, scope);
        const access = String(tokens.access_token ?? "");
        if (tokens.refresh_token && tokens.refresh_token !== current) {
          const { ciphertext, iv } = await encryptSecret(String(tokens.refresh_token));
          await store.put(userId, cfg.provider, { refresh_enc: ciphertext, iv, source_hash: row.source_hash, idp_subject: row.idp_subject, refreshed: true });
        }
        cacheAccess(key, access, tokens.expires_in);
        await noteRoles(store, userId, cfg.provider, access);
        return access;
      } catch (err) {
        if (!(err instanceof IdpError) || err.code !== "invalid_grant") throw err;
        // Une autre réplique a peut-être déjà fait tourner le jeton : on relit.
        const reread = await store.get(userId, cfg.provider);
        if (attempt === 0 && reread && reread.refresh_enc !== row.refresh_enc) {
          row = reread;
          continue;
        }
        await store.remove(userId, cfg.provider);
        forgetUserAccessToken(userId);
        throw new IdpError("session_expired", "La session SSO de cette personne a expiré : elle doit se reconnecter.");
      }
    }
    throw new IdpError("session_expired", "La session SSO de cette personne a expiré : elle doit se reconnecter.");
  })();
  inflight.set(key, job);
  return job.finally(() => inflight.delete(key));
}

const discoveryCache = new Map<string, Promise<Record<string, unknown>>>();

/** Document de découverte OIDC de l'issuer, mis en cache par processus. */
export function discoveryOf(issuer: string): Promise<Record<string, unknown>> {
  let p = discoveryCache.get(issuer);
  if (!p) {
    p = fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    discoveryCache.set(issuer, p);
  }
  return p;
}

/** Déconnexion : on oublie le jeton, et l'IdP l'invalide s'il sait le faire. */
export async function revokeUserRefreshToken(cfg: IdpConfig, store: IdpTokenStore, userId: string): Promise<void> {
  const row = await store.get(userId, cfg.provider);
  await store.remove(userId, cfg.provider);
  forgetUserAccessToken(userId);
  if (!row) return;
  try {
    // Entra ID n'a pas de point de révocation des jetons de rafraîchissement :
    // la ligne supprimée suffit, FounderOS ne s'en servira plus.
    const endpoint = cfg.revocationEndpoint ?? String((await discoveryOf(cfg.issuer)).revocation_endpoint ?? "");
    if (!endpoint) return;
    const token = await decryptSecret(row.refresh_enc, row.iv);
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.portalClientId, client_secret: cfg.portalClientSecret, token, token_type_hint: "refresh_token" }),
    });
  } catch {
    // La ligne est déjà supprimée : FounderOS ne s'en servira plus.
  }
}
