// Authentification des appels de la plateforme.
//
// Chaque requête porte X-Machine-Ts (secondes) et X-Machine-Signature =
// HMAC-SHA256(MACHINE_TOKEN, `${ts}.${corps brut}`) en hexadécimal. Le corps
// contient un `nonce` : une requête rejouée dans la fenêtre est refusée.
//
// La signature dit « la plateforme demande ». Elle ne suffit PAS à agir comme
// un agent ni à ouvrir un dossier : il faut en plus le secret de l'agent et
// celui de chaque dossier (voir principal.mjs). Un jeton de machine volé
// permet de créer ou d'archiver, jamais de lire le travail d'un agent.

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 120;

export function sign(token, ts, rawBody) {
  return createHmac("sha256", token).update(`${ts}.${rawBody}`).digest("hex");
}

/** Vérifie la signature et la fraîcheur ; rend une raison de refus, ou null. */
export function verifySignature({ token, ts, signature, rawBody, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!token) return "machine_not_configured";
  const t = Number(ts);
  if (!Number.isInteger(t)) return "missing_timestamp";
  if (Math.abs(nowSeconds - t) > MAX_SKEW_SECONDS) return "stale_request";
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return "missing_signature";
  const expected = Buffer.from(sign(token, t, rawBody), "hex");
  const got = Buffer.from(signature, "hex");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return "bad_signature";
  return null;
}

/** Les nonces vus dans la fenêtre de fraîcheur — au-delà, l'horodatage suffit. */
export class NonceCache {
  constructor(ttlMs = (MAX_SKEW_SECONDS * 2 + 10) * 1000, max = 50_000) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.seen = new Map();
  }

  /** true si le nonce est neuf (et le retient), false s'il a déjà servi. */
  claim(nonce, now = Date.now()) {
    if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128) return false;
    this.sweep(now);
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) {
      // Plein : on oublie les plus anciens plutôt que de tout refuser.
      const drop = Math.ceil(this.max / 10);
      for (const k of [...this.seen.keys()].slice(0, drop)) this.seen.delete(k);
    }
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [k, exp] of this.seen) {
      if (exp > now) break; // insertion ordonnée : le reste est plus récent
      this.seen.delete(k);
    }
  }
}
