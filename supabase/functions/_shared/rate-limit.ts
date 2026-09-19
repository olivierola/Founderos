// Limitation de débit des surfaces publiques — correctif FOS-15.
//
// S'appuie sur la fonction SQL `rate_limit_hit` (migration 0240), qui incrémente
// et tranche en une seule instruction atomique. Faire le compte côté edge — un
// select puis un update — laisserait deux requêtes simultanées lire la même
// valeur et passer toutes les deux, c'est-à-dire échouer exactement sous la
// charge où la limite est censée servir.

import { jsonResponse } from "./cors.ts";
import { createServiceClient } from "./supabase-admin.ts";

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
 * L'IP de l'appelant telle que la voit la passerelle.
 * `x-forwarded-for` est falsifiable par le client, mais Supabase la réécrit en
 * bordure ; on prend la PREMIÈRE entrée, celle que la passerelle a ajoutée.
 * À n'utiliser que comme dimension de limitation, jamais comme identité.
 */
export function callerIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return first || req.headers.get("cf-connecting-ip") || "unknown";
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

/** Réponse 429 normalisée, avec l'en-tête que les clients savent lire. */
export function tooManyRequests(verdict: RateLimitVerdict, message?: string): Response {
  return jsonResponse(
    {
      error: message ?? "Trop de requêtes. Merci de réessayer dans un instant.",
      retry_after_seconds: verdict.retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
  );
}

/**
 * Raccourci : compte, et rend une 429 prête à renvoyer si le plafond est franchi.
 *
 *   const limited = await enforceRateLimit({ scope: "ragchat", identity: key, limit: 30 });
 *   if (limited) return limited;
 */
export async function enforceRateLimit(
  opts: RateLimitOptions,
  message?: string,
): Promise<Response | null> {
  const verdict = await checkRateLimit(opts);
  return verdict.allowed ? null : tooManyRequests(verdict, message);
}
