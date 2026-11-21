// L'identité d'une requête d'API : le JWT de `Authorization`, sinon la clé
// `apikey` (elle-même un JWT, anon ou service_role), sinon anon — l'ordre de
// Supabase (Kong puis PostgREST).

import type { Request } from "express";
import type { JwtClaims } from "../db.ts";
import { JwtError, verifyJwt } from "../jwt.ts";
import type { Platform } from "../platform.ts";
import { ApiError } from "../rest/parse.ts";

export function bearer(req: Request): string | null {
  const h = String(req.headers.authorization ?? "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function claimsFromRequest(p: Platform, req: Request): JwtClaims {
  const token = bearer(req) ?? (typeof req.headers.apikey === "string" ? req.headers.apikey : null);
  let claims: JwtClaims = { role: "anon" };
  if (token) {
    try {
      claims = verifyJwt(token, p.jwtSecret) as JwtClaims;
    } catch (e) {
      const expired = e instanceof JwtError && /expired/i.test(e.message);
      throw new ApiError(401, expired ? "PGRST303" : "PGRST301", expired ? "JWT expired" : (e as Error).message);
    }
  }
  (req as Request & { platformClaims?: JwtClaims }).platformClaims = claims;
  return claims;
}
