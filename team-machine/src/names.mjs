// Noms, formes et secrets — tout ce qui se vérifie sans toucher au système.
//
// La machine ne fait confiance à aucun nom reçu : chacun repasse ici avant de
// devenir un utilisateur, un groupe ou un chemin. Une forme refusée est une
// erreur, jamais une « correction » silencieuse : un nom réécrit en douce
// pourrait tomber sur celui d'un autre.

import { createHash, timingSafeEqual } from "node:crypto";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Le dossier d'une équipe sous /teams — 27 caractères au plus, pour que son
 *  groupe Linux (« eq-<clé> ») tienne dans les 32 permis. */
export const TEAM_KEY_RE = /^[a-z][a-z0-9-]{1,26}$/;
/** Un utilisateur Linux : 32 caractères au plus, une lettre en tête. */
export const USER_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** Un dossier protégé, sous /teams/<équipe>/dossiers. */
export const FOLDER_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
/** Un paquet Debian. */
export const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{1,62}$/;

/** Les identifiants d'équipe viennent du jsonb des réglages : des uuid en
 *  pratique, mais l'interface en accepte d'autres formes courtes. */
export function isTeamId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v);
}

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Minuscule, sans accent, tirets à la place du reste ; une lettre en tête. */
export function slugify(input, max = 20) {
  const base = String(input ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  if (!base) return "x";
  return /^[a-z]/.test(base) ? base : `x${base}`.slice(0, max);
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/** Un secret valable : assez long pour ne pas se deviner (32 octets en base64url). */
export function isSecret(v) {
  return typeof v === "string" && v.length >= 32 && v.length <= 256 && /^[A-Za-z0-9_\-+/=]+$/.test(v);
}

/** Compare un secret à l'empreinte gardée, sans fuiter par le temps. */
export function secretMatches(secret, hash) {
  if (!isSecret(secret) || typeof hash !== "string" || hash.length !== 64) return false;
  const a = Buffer.from(sha256Hex(secret), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Un chemin reçu pour `cwd` : absolu, sans `..`, sans octet nul. Le noyau
 *  tranche ensuite l'accès — ceci écarte seulement les formes absurdes. */
export function isSafeAbsolutePath(p) {
  return typeof p === "string" && p.startsWith("/") && p.length < 4096
    && !p.includes("\0") && !p.split("/").includes("..");
}

/** Borne un entier reçu. */
export function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
