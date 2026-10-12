// Vérification du JWT « à la passerelle » — l'équivalent de `verify_jwt` chez
// Supabase.
//
// Elle exige un JWT Supabase VALIDE dans Authorization, pas une session
// utilisateur : la clé anon en est un. C'est un filet, pas une autorisation :
// chaque fonction vérifie toujours les droits de l'appelant.
//
// Deux modes (GATEWAY_VERIFY_JWT) :
//   - "production" (défaut) : les fonctions que la passerelle Supabase protège
//     RÉELLEMENT aujourd'hui. Basculer vers ce backend ne change alors rien
//     pour les appelants.
//   - "strict" : toutes les fonctions sauf les exceptions de
//     supabase/config.toml — le réglage voulu par FOS-16, qui n'est déployé
//     que sur les fonctions redéployées depuis.

import type { RequestHandler } from "express";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { env } from "../env.ts";
import { timingSafeEqual } from "./authz.ts";
import { createUserClient } from "./supabase.ts";

export type GatewayMode = "production" | "strict";

/**
 * Fonctions dont la passerelle Supabase vérifie le JWT en production, relevé le
 * 2026-10-02 (`supabase functions list --project-ref scugmxahflsjabglodyv`) :
 * 8 sur 100. simulation-prepare en fait partie, mais ce réglage y bloquait le
 * runner ; elle est désormais une exception de config.toml, qui l'emporte.
 */
export const ENFORCED_IN_PRODUCTION: ReadonlySet<string> = new Set([
  "ai-agent-chat",
  "internal-agent-a2a",
  "internal-agent-run",
  "internal-agent-scheduler",
  "rag-chat",
  "run-workflow",
  "service-room-post",
  "simulation-prepare",
]);

/** `sub` : l'utilisateur du JWT, quand c'en est un (pas la clé anon ni service). */
type Verdict = { ok: true; sub?: string } | { ok: false; code: string };

const subOf = (payload: { sub?: unknown }) =>
  typeof payload.sub === "string" && payload.sub ? { sub: payload.sub } : {};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function verifySupabaseJwt(token: string): Promise<Verdict> {
  if (timingSafeEqual(token, env.supabaseAnonKey) || timingSafeEqual(token, env.supabaseServiceRoleKey)) {
    return { ok: true };
  }
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return { ok: false, code: "UNAUTHORIZED_INVALID_JWT_FORMAT" };
  }
  try {
    if (alg === "HS256") {
      if (env.supabaseJwtSecret) {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(env.supabaseJwtSecret), { algorithms: ["HS256"] });
        return { ok: true, ...subOf(payload) };
      }
      // Sans le secret, Supabase Auth tranche — un aller-retour réseau par requête.
      const { data, error } = await createUserClient(`Bearer ${token}`).auth.getUser();
      return !error && data.user ? { ok: true, sub: data.user.id } : { ok: false, code: "UNAUTHORIZED_LEGACY_JWT" };
    }
    // Clés de signature asymétriques : vérification locale, clés publiques en cache.
    jwks ??= createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks);
    return { ok: true, ...subOf(payload) };
  } catch {
    return { ok: false, code: alg === "HS256" ? "UNAUTHORIZED_LEGACY_JWT" : "UNAUTHORIZED_INVALID_JWT" };
  }
}

export async function isValidSupabaseJwt(token: string): Promise<boolean> {
  return (await verifySupabaseJwt(token)).ok;
}

/** À monter sur `/functions/v1/:name`. `requiresJwt` dit quelles fonctions sont protégées. */
export function gatewayJwt(requiresJwt: (name: string) => boolean): RequestHandler {
  // Mêmes corps que la passerelle Supabase, plus `error` que lit callEdge.
  const refuse = (res: Parameters<RequestHandler>[1], code: string, message: string) => {
    res.status(401).json({ code, message, error: message });
  };

  return async (req, res, next) => {
    const name = req.params.name;
    if (typeof name !== "string" || !requiresJwt(name)) return next();

    const token = (req.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return refuse(res, "UNAUTHORIZED_NO_AUTH_HEADER", "Missing authorization header");

    const verdict = await verifySupabaseJwt(token);
    if (!verdict.ok) return refuse(res, verdict.code, "Invalid JWT");
    // L'utilisateur VÉRIFIÉ, pour le contexte d'appel LLM (app.ts) : jamais lu
    // dans un jeton que la passerelle n'a pas contrôlé.
    if (verdict.sub) res.locals.userId = verdict.sub;
    next();
  };
}
