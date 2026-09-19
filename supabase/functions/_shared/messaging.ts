// Envoyer vers Telegram, Discord et WhatsApp — les messageries servies par
// `messaging-gateway` (Slack et Teams gardent leurs propres modules).
//
// Trois API, trois formats, mais les mêmes deux gestes pour l'agent : poster un
// texte dans la conversation, et poster une demande d'autorisation avec des
// boutons. Tout est ici pour que l'exécution de l'agent (réponses, rapports de
// mission) et les demandes d'autorisation passent par UN seul chemin par
// fournisseur.
//
// Les jetons et secrets viennent de `internal_agent_channel_tokens`, table lue
// par le seul rôle service (0100, 0252).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Admin = SupabaseClient;
export type MessagingProvider = "telegram" | "discord" | "whatsapp";

export function isMessagingProvider(p: unknown): p is MessagingProvider {
  return p === "telegram" || p === "discord" || p === "whatsapp";
}

export interface ChannelCredentials {
  provider: string;
  externalTeamId: string | null;
  accessToken: string | null;
  secrets: Record<string, string>;
}

export async function loadCredentials(admin: Admin, channelId: string): Promise<ChannelCredentials | null> {
  const { data: ch } = await admin.from("internal_agent_channels")
    .select("provider, external_team_id").eq("id", channelId).maybeSingle();
  if (!ch) return null;
  const { data: tok } = await admin.from("internal_agent_channel_tokens")
    .select("access_token, secrets").eq("channel_id", channelId).maybeSingle();
  const t = tok as { access_token?: string | null; secrets?: Record<string, string> | null } | null;
  return {
    provider: String((ch as { provider: string }).provider),
    externalTeamId: (ch as { external_team_id?: string | null }).external_team_id ?? null,
    accessToken: t?.access_token ?? null,
    secrets: t?.secrets ?? {},
  };
}

/**
 * Le markdown de l'agent, rendu lisible là où il ne serait pas interprété.
 *
 * Telegram et WhatsApp ont chacun leur dialecte, et le MarkdownV2 de Telegram
 * REFUSE un message dont un seul caractère réservé n'est pas échappé — un point
 * dans un nombre suffit à faire perdre la réponse entière. On envoie donc du
 * texte brut, débarrassé de ses marqueurs : moins joli, mais toujours livré.
 */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)");
}

/** Découpe un long texte aux limites du fournisseur, sur des fins de ligne. */
function chunks(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// ── Telegram ────────────────────────────────────────────────────────────────

async function telegram(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json().catch(() => ({ ok: false }));
}

export async function telegramApi(token: string, method: string, body: Record<string, unknown>) {
  return await telegram(token, method, body);
}

// ── Discord ─────────────────────────────────────────────────────────────────

export async function discordApi(
  token: string, method: string, path: string, body?: unknown,
): Promise<Response> {
  return await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

const GRAPH = "https://graph.facebook.com/v21.0";

async function whatsapp(phoneNumberId: string, token: string, body: Record<string, unknown>) {
  return await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
}

// ── Les deux gestes ─────────────────────────────────────────────────────────

/**
 * Poste un texte dans la conversation liée. `chatRef` est le chat Telegram, le
 * salon Discord, ou le numéro WhatsApp ; `threadRef` le sujet de forum Telegram
 * le cas échéant.
 */
export async function sendMessagingText(
  admin: Admin, channelId: string, chatRef: string, threadRef: string | null, text: string,
): Promise<boolean> {
  const c = await loadCredentials(admin, channelId);
  if (!c?.accessToken || !isMessagingProvider(c.provider)) return false;
  const body = plainText(text);
  try {
    if (c.provider === "telegram") {
      for (const part of chunks(body, 4000)) {
        await telegram(c.accessToken, "sendMessage", {
          chat_id: chatRef, text: part,
          ...(threadRef ? { message_thread_id: Number(threadRef) } : {}),
        });
      }
      return true;
    }
    if (c.provider === "discord") {
      // Discord garde le markdown : on renvoie le texte d'origine.
      for (const part of chunks(text, 1900)) {
        await discordApi(c.accessToken, "POST", `/channels/${chatRef}/messages`, { content: part });
      }
      return true;
    }
    // WhatsApp : l'identifiant du numéro d'envoi est l'external_team_id.
    if (!c.externalTeamId) return false;
    for (const part of chunks(body, 4000)) {
      await whatsapp(c.externalTeamId, c.accessToken, {
        to: chatRef, type: "text", text: { body: part, preview_url: false },
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Poste une demande d'autorisation avec des boutons. L'identifiant renvoyé par
 * chaque bouton a la forme `fa:<approvalId>:<a|all|r>` — il tient dans les 64
 * octets du callback_data de Telegram, la limite la plus basse des trois.
 */
export async function sendMessagingApproval(
  admin: Admin,
  channelId: string,
  chatRef: string,
  threadRef: string | null,
  input: { approvalId: string; summary: string; note: string; decidable: boolean },
): Promise<void> {
  const c = await loadCredentials(admin, channelId);
  if (!c?.accessToken || !isMessagingProvider(c.provider)) return;
  const text = `🔐 Autorisation demandée : ${input.summary}\n${input.note}`;
  const id = (d: string) => `fa:${input.approvalId}:${d}`;

  try {
    if (c.provider === "telegram") {
      await telegram(c.accessToken, "sendMessage", {
        chat_id: chatRef, text,
        ...(threadRef ? { message_thread_id: Number(threadRef) } : {}),
        ...(input.decidable
          ? {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Autoriser", callback_data: id("a") },
                { text: "Tout autoriser", callback_data: id("all") },
                { text: "❌ Refuser", callback_data: id("r") },
              ]],
            },
          }
          : {}),
      });
      return;
    }
    if (c.provider === "discord") {
      await discordApi(c.accessToken, "POST", `/channels/${chatRef}/messages`, {
        content: text,
        components: input.decidable
          ? [{
            type: 1,
            components: [
              { type: 2, style: 3, label: "Autoriser", custom_id: id("a") },
              { type: 2, style: 2, label: "Tout autoriser", custom_id: id("all") },
              { type: 2, style: 4, label: "Refuser", custom_id: id("r") },
            ],
          }]
          : [],
      });
      return;
    }
    if (!c.externalTeamId) return;
    if (!input.decidable) {
      await whatsapp(c.externalTeamId, c.accessToken, { to: chatRef, type: "text", text: { body: plainText(text) } });
      return;
    }
    // WhatsApp : trois boutons au plus, titres de vingt caractères au plus.
    await whatsapp(c.externalTeamId, c.accessToken, {
      to: chatRef,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: plainText(text).slice(0, 1000) },
        action: {
          buttons: [
            { type: "reply", reply: { id: id("a"), title: "Autoriser" } },
            { type: "reply", reply: { id: id("all"), title: "Tout autoriser" } },
            { type: "reply", reply: { id: id("r"), title: "Refuser" } },
          ],
        },
      },
    });
  } catch { /* au mieux */ }
}

/** `fa:<approvalId>:<a|all|r>` → la demande et la décision. */
export function parseApprovalButton(
  raw: string,
): { approvalId: string; decision: "approve" | "approve_all" | "reject" } | null {
  const m = /^fa:([0-9a-f-]{36}):(a|all|r)$/i.exec(raw ?? "");
  if (!m) return null;
  return {
    approvalId: m[1],
    decision: m[2] === "a" ? "approve" : m[2] === "all" ? "approve_all" : "reject",
  };
}
