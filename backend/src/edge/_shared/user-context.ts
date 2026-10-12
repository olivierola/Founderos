// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/user-context.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Contexte utilisateur signé par FounderOS (docs/enterprise-generalisation.md G2).
//
// Pour un outil dont l'IdP ne sait pas émettre de jeton au nom d'une personne
// (pas d'échange de jeton, pas d'On-Behalf-Of), ou un outil maison : FounderOS
// atteste lui-même qui agit, dans un JWT court, signé avec la clé des
// approbations et vérifiable par le même JWKS (GET /functions/v1/approval-jwks).
//
//   iss    APPROVAL_ISSUER          aud   l'outil (auth_config.audience)
//   sub    l'utilisateur FounderOS pour qui l'agent agit (ou service:<agent>)
//   azp    le nom de l'agent        agent_id, run_id
//   scope  le scope de l'opération (catalogue des tools, ou connecteur)
//   roles  ses rôles auprès de l'IdP de l'entreprise : relevés dans ses jetons
//          (user_idp_roles) et dans ses groupes à la connexion SSO
//   preferred_username  son e-mail
//   typ (en-tête)  fos-ctx+jwt — jamais accepté comme jeton d'approbation
//
// Le format est celui qu'attend un serveur MCP (sub, azp, scope, roles) : un
// serveur MCP FounderOS le vérifie en pointant IDP_ISSUER et IDP_JWKS_URL sur
// FounderOS. La personne est attestée par FounderOS et non par l'IdP : c'est le
// compromis de ce mode (voir le plan, section 5).

import type { SupabaseClient } from "@supabase/supabase-js";
import { signFounderosToken } from "./founderos-jwt.ts";

export const USER_CONTEXT_TYP = "fos-ctx+jwt";
export const USER_CONTEXT_TTL_S = 300;

/** Où lire un chemin pointé (« realm_access.roles ») dans les données d'identité. */
function pathValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), obj);
}

/**
 * Les rôles de la personne auprès de l'IdP de l'entreprise : ceux relevés dans
 * ses jetons (délégation, 0275) et ses groupes lus à la connexion SSO (claim
 * des groupes du fournisseur, 0272). Jamais user_metadata, que la personne peut
 * modifier elle-même.
 */
export async function userContextRoles(admin: SupabaseClient, userId: string): Promise<string[]> {
  const roles = new Set<string>();
  const { data: rows } = await admin.from("user_idp_roles").select("roles").eq("user_id", userId);
  for (const r of (rows ?? []) as Array<{ roles: string[] | null }>) for (const x of r.roles ?? []) roles.add(x);

  const [{ data: providers }, { data: u }] = await Promise.all([
    admin.from("enterprise_sso_providers").select("auth_ref, groups_claim").eq("enabled", true),
    admin.auth.admin.getUserById(userId),
  ]);
  const claimOf = new Map(((providers ?? []) as Array<{ auth_ref: string; groups_claim: string }>).map((p) => [p.auth_ref, p.groups_claim]));
  for (const ident of u?.user?.identities ?? []) {
    const claim = claimOf.get(ident.provider) ?? (ident.provider.startsWith("sso:") ? "groups" : undefined);
    if (!claim) continue;
    const v = pathValue(ident.identity_data ?? {}, claim) ?? pathValue((ident.identity_data as { custom_claims?: unknown } | undefined)?.custom_claims ?? {}, claim);
    for (const x of Array.isArray(v) ? v : typeof v === "string" ? [v] : []) if (typeof x === "string" && x) roles.add(x);
  }
  return [...roles].slice(0, 100);
}

export interface UserContextRequest {
  audience: string;
  /** La personne pour qui l'agent agit ; null : exécution planifiée. */
  userId: string | null;
  agent: { id: string; name?: string | null };
  runId?: string | null;
  scope?: string | null;
}

const cache = new Map<string, { token: string; exp: number }>();

/** Pour les tests. */
export function resetUserContextCache(): void {
  cache.clear();
}

/** Le contexte signé pour UN outil. Mis en cache jusqu'à 60 s de son expiration. */
export async function signUserContext(admin: SupabaseClient | null, req: UserContextRequest, roles?: string[]): Promise<string> {
  const key = `${req.userId ?? "service"}|${req.agent.id}|${req.audience}|${req.scope ?? ""}|${req.runId ?? ""}`;
  const hit = cache.get(key);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;

  let email: string | null = null;
  let userRoles = roles ?? [];
  if (req.userId && admin) {
    if (!roles) userRoles = await userContextRoles(admin, req.userId);
    const { data } = await admin.auth.admin.getUserById(req.userId);
    email = data?.user?.email ?? null;
  }
  const { token, exp } = await signFounderosToken({
    typ: USER_CONTEXT_TYP,
    audience: req.audience,
    subject: req.userId ?? `service:${req.agent.id}`,
    ttlS: USER_CONTEXT_TTL_S,
    claims: {
      azp: req.agent.name ?? req.agent.id,
      agent_id: req.agent.id,
      ...(req.runId ? { run_id: req.runId } : {}),
      scope: req.scope ?? "",
      roles: userRoles,
      ...(email ? { preferred_username: email } : {}),
    },
  });
  cache.set(key, { token, exp: exp * 1000 });
  return token;
}
