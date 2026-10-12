// Limitation de débit des surfaces publiques — portage de
// supabase/functions/_shared/rate-limit.ts (correctif FOS-15).
//
// S'appuie sur la fonction SQL `rate_limit_hit` (migration 0240), qui incrémente
// et tranche en une seule instruction atomique. Faire le compte côté serveur —
// un select puis un update — laisserait deux requêtes simultanées lire la même
// valeur et passer toutes les deux, c'est-à-dire échouer exactement sous la
// charge où la limite est censée servir.

import type { Request } from "express";
import { HttpError } from "./http.ts";
import { createServiceClient } from "./supabase.ts";

export interface RateLimitOptions {
  /** Préfixe de la dimension comptée : "ragchat", "replay", "onboarding"… */
  scope: string;
  /** Ce qu'on compte : clé publique d'agent, id de projet, IP. */
  identity: string;
  /** Appels autorisés par fenêtre. */
  limit: number;
  /** Durée de la fenêtre, en secondes (60 par défaut). */
  windowSeconds?: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  hits: number;
  retryAfterSeconds: number;
}

/**
 * L'IP de l'appelant. Express la lit dans `x-forwarded-for` en ne faisant
 * confiance qu'au nombre de proxys déclaré par TRUST_PROXY : les entrées
 * ajoutées par le client lui-même sont ignorées.
 * À n'utiliser que comme dimension de limitation, jamais comme identité.
 */
export function callerIp(req: Request): string {
  return req.ip || "unknown";
}

export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitVerdict> {
  const key = `${opts.scope}:${opts.identity}`.slice(0, 200);
  try {
    const { data, error } = await createServiceClient().rpc("rate_limit_hit", {
      p_key: key,
      p_limit: opts.limit,
      p_window_seconds: opts.windowSeconds ?? 60,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: row?.allowed !== false,
      hits: Number(row?.hits ?? 0),
      retryAfterSeconds: Number(row?.retry_after_seconds ?? 60),
    };
  } catch (e) {
    // Panne du compteur : on LAISSE PASSER. Un compteur en défaut ne doit pas
    // couper le service d'un client — la limite est une protection contre
    // l'abus, pas un élément du chemin critique. L'incident est journalisé pour
    // que la panne ne reste pas silencieuse.
    console.error("[rate-limit] compteur indisponible, requête laissée passer:", e);
    return { allowed: true, hits: 0, retryAfterSeconds: 0 };
  }
}

/**
 * Compte, et lève une 429 (avec l'en-tête Retry-After) si le plafond est franchi.
 *
 *   await enforceRateLimit({ scope: "ragchat", identity: key, limit: 30 });
 */
export async function enforceRateLimit(opts: RateLimitOptions, message?: string): Promise<void> {
  const verdict = await checkRateLimit(opts);
  if (verdict.allowed) return;
  throw new HttpError(429, message ?? "Trop de requêtes. Merci de réessayer dans un instant.", {
    extra: { retry_after_seconds: verdict.retryAfterSeconds },
    headers: { "Retry-After": String(verdict.retryAfterSeconds) },
  });
}
