// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/mcp-api-token.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Jeton d'API d'un serveur MCP, côté FounderOS (migrations 0278 et 0285).
//
// Collé ici une fois, à l'installation du serveur MCP : le jeton de la période
// (npm run token -- seed), ou un jeton fixe (npm run token -- generate). Gardé
// chiffré (mcp_server_secrets) et présenté à chaque appel d'un agent. En jeton
// tournant, le serveur livre ensuite lui-même chaque nouveau jeton
// (acceptPushedMcpToken). L'agent — le modèle — ne le voit jamais : il est
// ajouté côté serveur, au moment de l'appel.
//
// Avec lui, pour l'audit et la règle des quatre yeux des approbations :
//   X-FounderOS-User   la personne pour qui l'agent agit (absente : exécution planifiée)
//   X-FounderOS-Agent  l'agent
// Le serveur MCP les reçoit comme des affirmations du détenteur du jeton : elles
// ne donnent aucun droit de plus que ceux du jeton.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { traceparentFor } from "./mcp-auth.ts";

/** Un jeton du générateur FounderOS, ou tout autre jeton porteur sans espace. */
export const API_TOKEN_RE = /^[A-Za-z0-9._~+\/=-]{16,4096}$/;
const FOUNDEROS_TOKEN_RE = /^mcpt_([a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;

/** « mcpt_ab12cd34…x9Qz » : de quoi reconnaître un jeton sans le lire. */
export function tokenHint(token: string): string {
  const m = FOUNDEROS_TOKEN_RE.exec(token);
  return m ? `mcpt_${m[1]}…${token.slice(-4)}` : `…${token.slice(-4)}`;
}

/**
 * Le demandeur tel que le serveur MCP le verra : la personne affirmée, ou, sans
 * personne, le jeton lui-même (`token:<id>`, comme MCP/src/lib/api-tokens.ts).
 */
export function apiTokenSubject(token: string, userId: string | null): string {
  if (userId) return userId;
  const m = FOUNDEROS_TOKEN_RE.exec(token);
  return m ? `token:${m[1]}` : "token:externe";
}

/**
 * Le nom de l'agent dans le jeu de caractères que le serveur MCP accepte
 * (ASSERTED_RE de MCP/src/lib/api-tokens.ts) : « Opérateur PRD 🚀 » devient
 * « Operateur PRD - ». Sans cela, le serveur ignorerait un nom accentué, et un
 * caractère hors Latin-1 ferait échouer fetch avant même l'envoi.
 */
export function assertedAgentName(name: string): string | null {
  const ascii = name.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._:@\/ -]+/g, "-").trim().slice(0, 200);
  return /[A-Za-z0-9]/.test(ascii) ? ascii : null;
}

export function apiTokenHeaders(input: { token: string; userId: string | null; agentName?: string | null; runId?: string | null }): Record<string, string> {
  const agent = input.agentName ? assertedAgentName(input.agentName) : null;
  return {
    Authorization: `Bearer ${input.token}`,
    ...(input.userId ? { "X-FounderOS-User": input.userId } : {}),
    ...(agent ? { "X-FounderOS-Agent": agent } : {}),
    traceparent: traceparentFor(input.runId),
    ...(input.runId ? { "X-Session-Id": input.runId } : {}),
  };
}

/** Les jetons de plusieurs serveurs, déchiffrés (côté serveur seulement). */
export async function loadMcpApiTokens(admin: SupabaseClient, serverIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!serverIds.length) return out;
  const { data } = await admin.from("mcp_server_secrets").select("server_id, token_enc, token_iv").in("server_id", serverIds);
  for (const r of (data ?? []) as Array<{ server_id: string; token_enc: string; token_iv: string }>) {
    try { out.set(r.server_id, await decryptSecret(r.token_enc, r.token_iv)); } catch { /* clé tournée : jeton à ressaisir */ }
  }
  return out;
}

/** Empreinte SHA-256 hexadécimale : retrouver la ligne d'un jeton sans le déchiffrer (0285). */
export async function tokenSha256(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Enregistre le jeton d'un serveur, chiffré, et son indice affichable. */
export async function saveMcpApiToken(admin: SupabaseClient, serverId: string, token: string, userId: string): Promise<{ hint: string }> {
  if (!API_TOKEN_RE.test(token)) throw new Error("Jeton invalide : 16 à 4096 caractères, sans espace.");
  const { ciphertext, iv } = await encryptSecret(token);
  const now = new Date().toISOString();
  const { error } = await admin.from("mcp_server_secrets").upsert({
    server_id: serverId, token_enc: ciphertext, token_iv: iv, token_sha256: await tokenSha256(token), updated_by: userId, updated_at: now,
  });
  if (error) throw new Error(error.message);
  const hint = tokenHint(token);
  await admin.from("mcp_servers").update({ token_hint: hint, token_received_at: now, token_origin: "manual" }).eq("id", serverId);
  return { hint };
}

// ── Jeton tournant, livré par le serveur MCP (0285) ──────────────────────────
//
// Le serveur MCP change son jeton à chaque période (MCP/src/lib/rotating-token.ts)
// et l'envoie ici : POST connector-action { mode: "mcp.token_push", token: <nouveau> },
// avec en Bearer le jeton que FounderOS détient. Détenir ce jeton est la seule
// preuve demandée : c'est déjà lui qui donne accès au serveur, et le nouveau ne
// part ensuite que vers l'adresse enregistrée de la ligne (garde de 0278). Un
// jeton volé mais périmé ne permet rien : seul le jeton courant est accepté.

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Les lignes d'avant 0285 : leur empreinte, calculée une fois. */
async function backfillTokenHashes(admin: SupabaseClient): Promise<void> {
  const { data } = await admin.from("mcp_server_secrets").select("server_id, token_enc, token_iv").is("token_sha256", null).limit(500);
  for (const r of (data ?? []) as Array<{ server_id: string; token_enc: string; token_iv: string }>) {
    try {
      const token = await decryptSecret(r.token_enc, r.token_iv);
      await admin.from("mcp_server_secrets").update({ token_sha256: await tokenSha256(token) }).eq("server_id", r.server_id);
    } catch { /* clé tournée : jeton à ressaisir */ }
  }
}

export interface TokenPushResult {
  status: 200 | 400 | 401;
  body: { ok: boolean; unchanged?: boolean; updated?: number; error?: string };
  servers?: string[];
}

export async function acceptPushedMcpToken(admin: SupabaseClient, presented: string, next: string): Promise<TokenPushResult> {
  const pm = FOUNDEROS_TOKEN_RE.exec(presented);
  const nm = FOUNDEROS_TOKEN_RE.exec(next);
  if (!pm || !nm) return { status: 400, body: { ok: false, error: "Jetons mcpt_<id>_<secret> attendus (en Bearer et dans token)." } };
  if (pm[1] !== nm[1]) return { status: 400, body: { ok: false, error: "Le nouveau jeton n'est pas celui du même serveur (id différent)." } };
  await backfillTokenHashes(admin);

  // Déjà reçu (une autre réplique du serveur l'a livré) : rien à faire.
  const nextHash = await tokenSha256(next);
  const { data: already } = await admin.from("mcp_server_secrets").select("server_id").eq("token_sha256", nextHash);
  if ((already ?? []).length) return { status: 200, body: { ok: true, unchanged: true, updated: 0 } };

  const { data: rows } = await admin.from("mcp_server_secrets")
    .select("server_id, token_enc, token_iv").eq("token_sha256", await tokenSha256(presented));
  const holders: string[] = [];
  for (const r of (rows ?? []) as Array<{ server_id: string; token_enc: string; token_iv: string }>) {
    try { if (sameText(await decryptSecret(r.token_enc, r.token_iv), presented)) holders.push(r.server_id); } catch { /* illisible */ }
  }
  if (!holders.length) return { status: 401, body: { ok: false, error: "Jeton inconnu : ce n'est pas celui que FounderOS détient." } };

  const { ciphertext, iv } = await encryptSecret(next);
  const now = new Date().toISOString();
  const { error } = await admin.from("mcp_server_secrets")
    .update({ token_enc: ciphertext, token_iv: iv, token_sha256: nextHash, updated_by: null, updated_at: now }).in("server_id", holders);
  if (error) throw new Error(error.message);
  await admin.from("mcp_servers").update({ token_hint: tokenHint(next), token_received_at: now, token_origin: "push" }).in("id", holders);
  return { status: 200, body: { ok: true, updated: holders.length }, servers: holders };
}
