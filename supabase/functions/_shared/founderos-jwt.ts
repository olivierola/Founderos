// Jetons signés par FounderOS : approbations (D6) et contexte utilisateur (G2).
// Une clé P-256 (APPROVAL_SIGNING_KEY, PKCS#8 PEM), un JWKS public
// (GET /functions/v1/approval-jwks) ; le `typ` de l'en-tête distingue les
// usages, pour qu'aucun jeton ne puisse servir à la place d'un autre.
//
// Variables : APPROVAL_ISSUER, APPROVAL_SIGNING_KEY, APPROVAL_JWKS_EXTRA (clés
// publiques supplémentaires, rotation).

import { calculateJwkThumbprint, exportJWK, importPKCS8, SignJWT, type JWK } from "https://esm.sh/jose@5.9.6";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

interface SigningKey {
  key: CryptoKey;
  kid: string;
  publicJwk: JWK;
}

let signingCache: { pem: string; key: Promise<SigningKey> } | null = null;

function signingPem(): string {
  // Une variable d'environnement sur une ligne porte souvent des « \n » littéraux.
  return env("APPROVAL_SIGNING_KEY").replace(/\\n/g, "\n");
}

export function loadSigningKey(): Promise<SigningKey> {
  const pem = signingPem();
  if (!pem) return Promise.reject(new Error("APPROVAL_SIGNING_KEY absent : FounderOS ne peut pas signer d'approbation."));
  if (signingCache?.pem === pem) return signingCache.key;
  const key = (async () => {
    const priv = await importPKCS8(pem, "ES256", { extractable: true }) as CryptoKey;
    const { d: _private, ...pub } = await exportJWK(priv);
    const kid = await calculateJwkThumbprint(pub);
    return { key: priv, kid, publicJwk: { ...pub, kid, alg: "ES256", use: "sig" } };
  })();
  signingCache = { pem, key };
  key.catch(() => { if (signingCache?.key === key) signingCache = null; });
  return key;
}

/** Les clés publiques des jetons d'approbation, servies en JWKS. */
export async function approvalJwks(): Promise<{ keys: JWK[] }> {
  const keys: JWK[] = [];
  if (signingPem()) keys.push((await loadSigningKey()).publicJwk);
  const extra = env("APPROVAL_JWKS_EXTRA");
  if (extra) {
    let parsed: unknown;
    try { parsed = JSON.parse(extra); } catch { throw new Error("APPROVAL_JWKS_EXTRA n'est pas un JSON valide."); }
    const list = Array.isArray(parsed) ? parsed : (parsed as { keys?: unknown })?.keys;
    for (const k of Array.isArray(list) ? list : []) {
      // Jamais de partie privée dans un JWKS public, même par erreur de saisie.
      if (k && typeof k === "object" && !("d" in k) && (k as JWK).kid && !keys.some((x) => x.kid === (k as JWK).kid)) {
        keys.push(k as JWK);
      }
    }
  }
  return { keys };
}

/**
 * Un autre jeton signé par FounderOS avec la même clé (même JWKS) : contexte
 * utilisateur (user-context.ts). `typ` le distingue d'un jeton d'approbation,
 * pour qu'aucun ne puisse servir à la place de l'autre.
 */
export async function signFounderosToken(input: {
  typ: string;
  audience: string;
  subject: string;
  ttlS: number;
  claims: Record<string, unknown>;
  jti?: string;
  now?: number;
}): Promise<{ token: string; iat: number; exp: number; kid: string }> {
  const issuer = env("APPROVAL_ISSUER");
  if (!issuer) throw new Error("APPROVAL_ISSUER absent : FounderOS ne peut pas signer de jeton.");
  const { key, kid } = await loadSigningKey();
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const exp = iat + input.ttlS;
  const token = await new SignJWT(input.claims)
    .setProtectedHeader({ alg: "ES256", kid, typ: input.typ })
    .setIssuer(issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setJti(input.jti ?? crypto.randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
  return { token, iat, exp, kid };
}

