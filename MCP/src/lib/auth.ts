// Vérification du jeton d'appel : émis par l'IdP de l'entreprise au nom d'une
// personne ET d'un agent, pour UN serveur MCP (`aud`). Deux familles :
//   · Keycloak, Okta… (échange de jeton RFC 8693) : `sub`, `azp`, `scope`,
//     `realm_access.roles`, 5 minutes ;
//   · Entra ID (On-Behalf-Of) : `oid` (stable, quand `sub` change d'une
//     application à l'autre), `azp` ou `appid`, `scp`, `roles`, 60 à 90 minutes
//     sauf politique de durée de vie (maxLifetimeSeconds à régler).
//
// Signature (JWKS de Keycloak), `iss`, `aud`, `exp` ; durée de vie bornée ;
// agent dans la liste autorisée si elle est fournie. Ce jeton n'est jamais
// relayé vers l'outil.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface CallerIdentity {
  /** L'utilisateur au nom duquel l'agent agit : `oid` s'il existe (Entra ID), sinon `sub`. */
  sub: string;
  /** L'agent : le client de l'IdP qui a demandé le jeton (`azp`, ou `appid` chez Entra v1). */
  azp: string;
  username?: string;
  scopes: string[];
  roles: string[];
  exp: number;
  /** Mode jeton d'API : l'identifiant du jeton présenté (audit, révocation). */
  tokenId?: string;
}

export interface AccessTokenVerifierOptions {
  issuer: string;
  audience: string;
  /** Défaut : JWKS de Keycloak, <issuer>/protocol/openid-connect/certs. */
  jwks?: JWTVerifyGetKey;
  /** Agents (azp) acceptés ; vide = tous ceux que Keycloak a autorisés pour cette audience. */
  allowedAgents?: string[];
  /** Durée de vie maximale acceptée, en secondes (défaut 300 + 60 de tolérance). */
  maxLifetimeSeconds?: number;
}

/**
 * `asserted` : la personne et l'agent affirmés par FounderOS (X-FounderOS-User,
 * X-FounderOS-Agent). Seul le mode jeton d'API s'en sert : un jeton émis par un
 * IdP porte déjà la personne et l'agent, signés.
 */
export type AccessTokenVerifier = (token: string, asserted?: { user?: string; agent?: string }) => Promise<CallerIdentity>;

export function createAccessTokenVerifier(opts: AccessTokenVerifierOptions): AccessTokenVerifier {
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`${opts.issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`));
  const maxLifetime = opts.maxLifetimeSeconds ?? 360;
  const allowed = new Set(opts.allowedAgents ?? []);

  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 30,
      }));
    } catch (err) {
      throw new AuthError(`jeton refusé : ${(err as Error).message}`);
    }
    const azp = typeof payload.azp === "string" ? payload.azp : typeof payload.appid === "string" ? payload.appid : "";
    if (!azp) throw new AuthError("jeton refusé : azp absent (l'agent n'est pas identifié)");
    if (allowed.size && !allowed.has(azp)) throw new AuthError(`jeton refusé : agent ${azp} non autorisé sur ce serveur`);
    if ((payload.exp as number) - (payload.iat as number) > maxLifetime) {
      throw new AuthError("jeton refusé : durée de vie trop longue pour un jeton d'appel");
    }
    const realmRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles = [...(Array.isArray(realmRoles) ? realmRoles : []), ...(Array.isArray(payload.roles) ? payload.roles : [])];
    const scope = typeof payload.scope === "string" ? payload.scope : typeof payload.scp === "string" ? payload.scp : "";
    return {
      sub: typeof payload.oid === "string" && payload.oid ? payload.oid : payload.sub as string,
      azp,
      username: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
      scopes: scope.split(" ").filter(Boolean),
      roles: [...new Set(roles.filter((r): r is string => typeof r === "string"))],
      exp: payload.exp as number,
    };
  };
}
