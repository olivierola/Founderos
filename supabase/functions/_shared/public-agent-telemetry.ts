// Télémétrie d'une conversation d'agent public (migration 0217).
//
// Deux responsabilités, volontairement séparées de rag-chat : d'où vient le
// visiteur, et comment s'est terminé le tour qu'on vient de jouer. Tout ce qui
// est écrit ici est un signal RÉEL observé pendant la requête — aucune
// classification a posteriori, aucun LLM juge : les pages Performance et
// Audience doivent pouvoir être défendues ligne à ligne devant un client.

import { TZ_COUNTRY } from "./tz-country.ts";

export type Outcome = "resolved" | "unresolved" | "escalated" | "abandoned";

export interface VisitorContext {
  country: string | null;
  timezone: string | null;
  locale: string | null;
  device: "desktop" | "mobile" | "tablet" | null;
  referrer: string | null;
  page_url: string | null;
}

/** En-têtes géo posés par les CDN devant l'edge, dans l'ordre de confiance. */
const GEO_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "x-country-code", "x-geo-country"];

function normCountry(v: string | null | undefined): string | null {
  if (!v) return null;
  const c = v.trim().toUpperCase();
  // "XX" et "T1" (Tor) sont les non-réponses de Cloudflare.
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return null;
  return c;
}

/** Tronque une URL à son origine + chemin : ni query ni fragment ne doivent
 *  entrer en base — c'est là que se cachent tokens et identifiants clients. */
function safeUrl(v: unknown, max = 300): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v);
    return `${u.origin}${u.pathname}`.slice(0, max);
  } catch {
    return null;
  }
}

function safeOrigin(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    return new URL(v).origin.slice(0, 200);
  } catch {
    return null;
  }
}

/**
 * Contexte du visiteur : en-tête géo du CDN d'abord, fuseau horaire annoncé par
 * le navigateur ensuite. Le fuseau est une approximation (un Français en
 * déplacement compte pour son fuseau), assumée comme telle dans l'UI — et c'est
 * le prix à payer pour ne pas stocker d'IP.
 */
export function visitorContext(req: Request, body: Record<string, unknown>): VisitorContext {
  const ctx = (body.client_context ?? {}) as Record<string, unknown>;

  let country: string | null = null;
  for (const h of GEO_HEADERS) {
    country = normCountry(req.headers.get(h));
    if (country) break;
  }
  const timezone = typeof ctx.timezone === "string" ? ctx.timezone.slice(0, 60) : null;
  if (!country && timezone) country = normCountry(TZ_COUNTRY[timezone]);

  const rawDevice = typeof ctx.device === "string" ? ctx.device : "";
  const device = rawDevice === "mobile" || rawDevice === "tablet" || rawDevice === "desktop"
    ? rawDevice
    : deviceFromUA(req.headers.get("user-agent"));

  return {
    country,
    timezone,
    locale: typeof ctx.locale === "string" ? ctx.locale.slice(0, 20) : null,
    device,
    // Le referrer utile ici est le SITE hôte, pas la page : savoir que le widget
    // tourne sur boutique.example.com renseigne, connaître /panier/etape-2 non.
    referrer: safeOrigin(ctx.referrer) ?? safeOrigin(req.headers.get("origin")),
    page_url: safeUrl(ctx.page_url),
  };
}

function deviceFromUA(ua: string | null): "desktop" | "mobile" | "tablet" | null {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/.test(s)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|windows phone/.test(s)) return "mobile";
  return "desktop";
}

// ── Demande d'humain ────────────────────────────────────────────────────────
// Une escalade n'est pas déduite d'un ton ni d'un score : c'est le visiteur qui
// réclame explicitement quelqu'un. FR + EN, les deux langues que servent les
// widgets déployés aujourd'hui.
const HUMAN_PATTERNS = [
  /\b(parler|discuter)\s+(à|a|avec)\s+(un|une|quelqu.?un|d.?un)?\s*(vrai\s+)?(humain|personne|conseiller|agent\s+humain|opérateur)\b/i,
  /\b(un|une)\s+(vrai\s+)?(humain|conseiller|opérateur|téléconseiller)\b/i,
  // « service client » seul ne suffit pas : « votre service client ouvre à
  // quelle heure ? » est une question, pas une demande d’escalade — il faut
  // le verbe d’intention devant.
  /\b(joindre|contacter|appeler|parler\s+(au|à)|passer\s+au|passez[- ]moi)\s+(le\s+)?service\s+client\b/i,
  /\b(passe|passez|transfère|transferez|transférez|mets)[- ]moi\b.*\b(humain|conseiller|agent|quelqu.?un)\b/i,
  /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(real\s+)?(human|person|agent|someone|representative)\b/i,
  /\b(human|live)\s+(agent|support|person)\b/i,
];

export function asksForHuman(message: string): boolean {
  return HUMAN_PATTERNS.some((re) => re.test(message));
}

// ── Issue du tour ───────────────────────────────────────────────────────────
export interface TurnSignals {
  message: string;
  /** Nombre de chunks du corpus réellement cités dans la réponse. */
  groundedChunks: number;
  /** Appels d'outils MCP joués pendant le tour, et combien ont échoué. */
  toolCalls: number;
  toolErrors: number;
  /** Rang du tour dans la conversation (1 = premier). */
  turnIndex: number;
  firstResponseMs: number;
}

export interface TurnVerdict {
  outcome: Outcome;
  reason: string;
}

/**
 * Verdict d'un tour, à partir des seuls signaux observés.
 *
 * `resolved` ne prétend pas que le visiteur est satisfait — seul son vote le
 * dit, et il vote rarement. Il dit : l'agent avait de la matière (source du
 * corpus ou outil qui a répondu) et rien n'a cassé. C'est exactement la
 * définition qu'affiche l'UI, pour que le chiffre ne soit jamais lu comme un
 * CSAT déguisé.
 */
export function judgeTurn(s: TurnSignals): TurnVerdict {
  if (asksForHuman(s.message)) return { outcome: "escalated", reason: "human_requested" };
  if (s.toolErrors > 0) return { outcome: "unresolved", reason: "tool_failure" };

  const hadMatter = s.groundedChunks > 0 || s.toolCalls > 0;
  if (!hadMatter) return { outcome: "unresolved", reason: "no_knowledge" };

  // Quatre questions ou plus sur le même fil : le visiteur a dû s'accrocher.
  // La réponse finale peut être bonne, l'effort demandé reste un motif.
  if (s.turnIndex >= 4) return { outcome: "resolved", reason: "user_effort" };
  if (s.turnIndex <= 2 && s.firstResponseMs > 0 && s.firstResponseMs < 4000) {
    return { outcome: "resolved", reason: "quick_resolution" };
  }
  return { outcome: "resolved", reason: "answer_quality" };
}
