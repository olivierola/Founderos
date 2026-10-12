// Jeton d'approbation : signé par FounderOS après validation par un détenteur du
// rôle ai-ops-prd-approver, rejoué dans l'en-tête X-Approval-Token. Il vaut
// 5 minutes et pour UNE action : tool, cluster cible et empreinte des paramètres.
//
// Vérifié ici AVANT l'appel à OPA (signature, expiration, liaison à l'appel) ;
// OPA vérifie ensuite que l'approbateur n'est pas le demandeur.
//
// Revendications attendues (FounderOS, docs/openshift-implementation.md D6) :
//   iss  FOUNDEROS_APPROVAL_ISSUER     aud  l'audience de ce serveur MCP
//   sub  le demandeur (sub du jeton d'appel)   approver  l'approbateur
//   jti  l'identifiant de la demande   tool, target_cluster, params_hash
//   iat, exp (exp - iat ≤ 300)
//   approvers  (facultatif, G3) tous les approbateurs d'une règle à quorum ;
//              approver en fait partie. Absent : [approver].

import { readFileSync, statSync } from "node:fs";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

export interface VerifiedApproval {
  id: string;
  tool: string;
  target_cluster: string;
  params_hash: string;
  approver: string;
  /** Tous les approbateurs (règle à quorum, G3) ; [approver] pour un jeton d'avant. */
  approvers: string[];
}

export interface ApprovalVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  /** JWKS dans un fichier (ConfigMap) : pour un cluster qui ne joint pas FounderOS. */
  jwksFile?: string;
  jwks?: JWTVerifyGetKey;
}

/**
 * JWKS lu dans un fichier, relu quand il change : une ConfigMap mise à jour
 * (rotation de la clé de signature) est prise en compte sans redémarrage.
 * La date de modification est vérifiée au plus toutes les `recheckMs`.
 */
export function fileJwks(path: string, recheckMs = 30_000): JWTVerifyGetKey {
  let mtime = -1;
  let checkedAt = 0;
  let current: JWTVerifyGetKey | null = null;
  const load = () => {
    const m = statSync(path).mtimeMs;
    if (m !== mtime || !current) {
      const set = JSON.parse(readFileSync(path, "utf8")) as JSONWebKeySet;
      if (!Array.isArray(set?.keys)) throw new ApprovalError(`${path} n'est pas un JWKS`);
      current = createLocalJWKSet(set);
      mtime = m;
    }
    checkedAt = Date.now();
    return current;
  };
  load();
  return (header, token) => {
    const getKey = Date.now() - checkedAt > recheckMs ? load() : current!;
    return getKey(header, token);
  };
}

export type ApprovalVerifier = (
  token: string,
  expected: { requester: string; tool: string; targetCluster: string; paramsHash: string },
) => Promise<VerifiedApproval>;

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export function createApprovalVerifier(opts: ApprovalVerifierOptions): ApprovalVerifier {
  const jwks = opts.jwks
    ?? (opts.jwksFile ? fileJwks(opts.jwksFile) : null)
    ?? (opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null);
  return async (token, expected) => {
    if (!jwks) throw new ApprovalError("jeton d'approbation reçu, mais aucun JWKS d'approbation n'est configuré");
    let p;
    try {
      ({ payload: p } = await jwtVerify(token, jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
        requiredClaims: ["sub", "jti", "exp", "iat"],
        clockTolerance: 15,
        // Un contexte utilisateur signé par FounderOS (typ fos-ctx+jwt), même clé :
        // jamais accepté comme approbation.
        typ: "JWT",
      }));
    } catch (err) {
      throw new ApprovalError(`jeton d'approbation refusé : ${(err as Error).message}`);
    }
    if ((p.exp as number) - (p.iat as number) > 300) throw new ApprovalError("jeton d'approbation valable plus de 5 minutes");
    if (p.sub !== expected.requester) throw new ApprovalError("jeton d'approbation émis pour un autre demandeur");
    if (p.tool !== expected.tool) throw new ApprovalError("jeton d'approbation émis pour un autre tool");
    if (p.target_cluster !== expected.targetCluster) throw new ApprovalError("jeton d'approbation émis pour un autre cluster");
    if (p.params_hash !== expected.paramsHash) throw new ApprovalError("jeton d'approbation émis pour d'autres paramètres");
    if (typeof p.approver !== "string" || !p.approver) throw new ApprovalError("jeton d'approbation sans approbateur");
    let approvers = [p.approver];
    if (p.approvers !== undefined) {
      const list = p.approvers;
      if (!Array.isArray(list) || list.length < 1 || list.length > 10
          || !list.every((a) => typeof a === "string" && a.length > 0 && a.length <= 300)) {
        throw new ApprovalError("jeton d'approbation : liste d'approbateurs mal formée");
      }
      if (!list.includes(p.approver)) throw new ApprovalError("jeton d'approbation : l'approbateur n'est pas dans la liste");
      approvers = [...new Set(list as string[])];
    }
    return {
      id: p.jti as string,
      tool: p.tool as string,
      target_cluster: p.target_cluster as string,
      params_hash: p.params_hash as string,
      approver: p.approver,
      approvers,
    };
  };
}
