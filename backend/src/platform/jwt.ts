// JWT HS256, au format de Supabase : les clés anon et service_role en sont, et
// les sessions de l'auth aussi. Synchrone (node:crypto) : les clés sont
// dérivées pendant la lecture de la configuration, avant tout import.

import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export class JwtError extends Error {}

/** Vérifie la signature et l'expiration ; rend les claims. */
export function verifyJwt(token: string, secret: string, now = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("JWT illisible");
  let header: { alg?: string };
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { throw new JwtError("JWT illisible"); }
  if (header.alg !== "HS256") throw new JwtError(`Algorithme refusé : ${header.alg}`);
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError("JWT invalide : signature");
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { throw new JwtError("JWT illisible"); }
  if (typeof claims.exp === "number" && claims.exp < now) throw new JwtError("JWT expired");
  return claims;
}

/** Les deux clés d'API d'une instance, comme celles que Supabase délivre. */
export function apiKeys(secret: string, issuedAt = 1_700_000_000) {
  const exp = issuedAt + 10 * 365 * 24 * 3600;
  return {
    anon: signJwt({ iss: "founderos", role: "anon", iat: issuedAt, exp }, secret),
    service: signJwt({ iss: "founderos", role: "service_role", iat: issuedAt, exp }, secret),
  };
}
