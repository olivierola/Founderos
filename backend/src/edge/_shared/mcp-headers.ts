// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/mcp-headers.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// En-têtes statiques d'un serveur MCP (migration 0280).
//
// Ils vivent dans mcp_server_headers, que seul le backend lit, chiffrés avec
// CREDENTIAL_ENCRYPTION_KEY. Le déclencheur de 0280 y dépose en clair
// (headers_plain) ce qui est écrit dans mcp_servers.headers, la base ne
// connaissant pas la clé : la première lecture les chiffre.
//
// Un en-tête que FounderOS pose lui-même (identité affirmée, approbation,
// trace, session) ne peut pas venir d'ici : il est écarté à la lecture, quel
// que soit le chemin qui l'a écrit. Et quand FounderOS ajoute son propre
// Authorization (OAuth, jeton d'API, jeton d'appel), il remplace l'en-tête
// statique du même nom, sans tenir compte de la casse (mergeMcpHeaders).

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "./crypto.ts";

export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,100}$/;
const MAX_HEADERS = 30;
const MAX_VALUE = 8192;

/** Posés par FounderOS ou par le transport : jamais par un en-tête statique. */
const RESERVED = new Set([
  "x-founderos-user", "x-founderos-agent", "x-approval-token", "traceparent", "tracestate", "x-session-id",
  "mcp-session-id", "mcp-protocol-version", "host", "content-length", "content-type", "accept", "connection",
  "transfer-encoding", "te", "upgrade",
]);

/**
 * « Bearer …x9Qz », « …x9Qz », « Bearer •••• » ou « •••• » : les 4 derniers
 * caractères ne se montrent que d'un secret d'au moins 12 caractères, schéma
 * mis à part. Même règle que public.mcp_header_hint (0280).
 */
export function headerHint(v: string): string {
  const m = /^(bearer|basic|token|bot) (.+)$/i.exec(v);
  if (m) return `${m[1]} ${m[2].length >= 12 ? `…${v.slice(-4)}` : "••••"}`;
  return v.length >= 12 ? `…${v.slice(-4)}` : "••••";
}

export function headerHints(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, headerHint(v)]));
}

/** Les en-têtes utilisables, sans les noms réservés ni les valeurs impropres. */
function usable(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEADER_NAME_RE.test(k) || RESERVED.has(k.toLowerCase())) continue;
    if (typeof v !== "string" || v.length > MAX_VALUE || /[\r\n\0]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Valide des en-têtes saisis. Une valeur vide garde la valeur enregistrée sous
 * le même nom (`stored`) ; s'il n'y en a pas, c'est une erreur.
 */
export function resolveHeaderInput(input: unknown, stored: Record<string, string> = {}): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("En-têtes : un objet { nom: valeur } est attendu.");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) throw new Error(`En-têtes : ${MAX_HEADERS} au plus.`);
  const out: Record<string, string> = {};
  for (const [k, raw] of entries) {
    if (!HEADER_NAME_RE.test(k)) throw new Error(`En-tête « ${k.slice(0, 40)} » : lettres, chiffres et tirets seulement.`);
    if (RESERVED.has(k.toLowerCase())) throw new Error(`En-tête « ${k} » : posé par FounderOS, il ne peut pas être fixé ici.`);
    const v = raw == null ? "" : String(raw);
    if (!v) {
      if (!(k in stored)) throw new Error(`En-tête « ${k} » : saisissez sa valeur.`);
      out[k] = stored[k];
      continue;
    }
    if (v.length > MAX_VALUE || /[\r\n\0]/.test(v)) throw new Error(`En-tête « ${k} » : valeur trop longue ou sur plusieurs lignes.`);
    out[k] = v;
  }
  return out;
}

/** Les en-têtes de FounderOS l'emportent sur les statiques du même nom, quelle qu'en soit la casse. */
export function mergeMcpHeaders(staticHeaders: Record<string, string>, own: Record<string, string>): Record<string, string> {
  const taken = new Set(Object.keys(own).map((k) => k.toLowerCase()));
  const kept = Object.fromEntries(Object.entries(staticHeaders).filter(([k]) => !taken.has(k.toLowerCase())));
  return { ...kept, ...own };
}

type HeaderRow = { server_id: string; headers_plain: unknown; headers_enc: string | null; headers_iv: string | null };

async function seal(admin: SupabaseClient, serverId: string, headers: Record<string, string>): Promise<void> {
  const { ciphertext, iv } = await encryptSecret(JSON.stringify(headers));
  await admin.from("mcp_server_headers")
    .update({ headers_enc: ciphertext, headers_iv: iv, headers_plain: null, updated_at: new Date().toISOString() })
    .eq("server_id", serverId);
}

/** Les en-têtes de plusieurs serveurs, déchiffrés (côté serveur seulement). Chiffre au passage ceux encore en clair. */
export async function loadMcpHeaders(admin: SupabaseClient, serverIds: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (!serverIds.length) return out;
  const { data } = await admin.from("mcp_server_headers")
    .select("server_id, headers_plain, headers_enc, headers_iv").in("server_id", serverIds);
  for (const r of (data ?? []) as HeaderRow[]) {
    if (r.headers_plain) {
      const plain = usable(r.headers_plain);
      out.set(r.server_id, plain);
      try { await seal(admin, r.server_id, plain); } catch { /* clé absente : reste en clair dans la table protégée */ }
      continue;
    }
    if (!r.headers_enc || !r.headers_iv) continue;
    try { out.set(r.server_id, usable(JSON.parse(await decryptSecret(r.headers_enc, r.headers_iv)))); } catch { /* clé tournée : à ressaisir */ }
  }
  return out;
}

/** Remplace les en-têtes d'un serveur (déjà validés) ; vide : les efface. */
export async function saveMcpHeaders(admin: SupabaseClient, serverId: string, headers: Record<string, string>): Promise<{ hints: Record<string, string> }> {
  if (!Object.keys(headers).length) {
    await admin.from("mcp_server_headers").delete().eq("server_id", serverId);
    await admin.from("mcp_servers").update({ header_hints: {} }).eq("id", serverId);
    return { hints: {} };
  }
  const { ciphertext, iv } = await encryptSecret(JSON.stringify(headers));
  const { error } = await admin.from("mcp_server_headers").upsert({
    server_id: serverId, headers_enc: ciphertext, headers_iv: iv, headers_plain: null, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  const hints = headerHints(headers);
  await admin.from("mcp_servers").update({ header_hints: hints }).eq("id", serverId);
  return { hints };
}

/** Chiffre les en-têtes encore en clair (au démarrage du backend). Renvoie le nombre de serveurs traités. */
export async function sealPendingMcpHeaders(admin: SupabaseClient, limit = 500): Promise<number> {
  const { data } = await admin.from("mcp_server_headers").select("server_id").not("headers_plain", "is", null).limit(limit);
  const ids = ((data ?? []) as Array<{ server_id: string }>).map((r) => r.server_id);
  if (ids.length) await loadMcpHeaders(admin, ids);
  return ids.length;
}

/** « https://hote:port » en minuscules, comme la garde de 0278 à 0280 ; "" si l'URL n'en a pas. */
export function urlOrigin(url: string): string {
  return (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+/.exec(url.trim())?.[0] ?? "").toLowerCase();
}
