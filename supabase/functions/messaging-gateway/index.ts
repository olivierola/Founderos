// messaging-gateway — les agents dans Telegram, Discord et WhatsApp.
//
// Une seule fonction pour trois messageries : Supabase plafonne à cent
// fonctions, et celle-ci est la centième. Slack et Teams gardent leurs
// passerelles d'origine ; celle-ci reprend exactement leur contrat, pour que
// l'agent se comporte pareil partout :
//
//   · on lui écrit (en privé, ou en le mentionnant dans un groupe) → il répond
//     dans la même conversation, en gardant le contexte ;
//   · « mission : … » crée une mission suivie, dont le rapport revient ici ;
//   · quand il veut ÉCRIRE dans le suivi de travail, la demande d'autorisation
//     arrive dans la conversation avec des boutons, et seul l'auteur de la
//     demande peut trancher (voir _shared/channel-approval.ts).
//
// ── Les routes ─────────────────────────────────────────────────────────────
//
//   POST ?action=connect                    — depuis l'app, avec le JWT de
//                                             l'utilisateur : enregistre les
//                                             identifiants du bot.
//   POST ?provider=telegram&c=<canal>       — webhook Telegram
//   POST ?provider=discord&c=<canal>        — endpoint d'interactions Discord
//   GET  ?provider=whatsapp&c=<canal>       — vérification du webhook Meta
//   POST ?provider=whatsapp&c=<canal>       — webhook WhatsApp
//
// ── L'authentification de chaque appel entrant ─────────────────────────────
//
// La fonction est déployée SANS vérification de JWT Supabase (config.toml) :
// aucune messagerie n'en envoie. Chacune prouve son identité à sa façon, et la
// passerelle le vérifie AVANT toute lecture du contenu :
//   · Telegram — l'en-tête X-Telegram-Bot-Api-Secret-Token, égal au secret
//     tiré au hasard à la connexion et remis à Telegram par setWebhook ;
//   · Discord  — la signature Ed25519 du corps, avec la clé publique de l'app ;
//   · WhatsApp — la signature HMAC-SHA256 du corps (X-Hub-Signature-256), avec
//     le secret de l'app Meta.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { decideApprovalFromChannel } from "../_shared/channel-approval.ts";
import {
  discordApi, loadCredentials, parseApprovalButton, sendMessagingText, telegramApi,
  type MessagingProvider,
} from "../_shared/messaging.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GATEWAY = `${SUPABASE_URL}/functions/v1/messaging-gateway`;

type Admin = ReturnType<typeof createServiceClient>;

interface Channel {
  id: string;
  agent_id: string;
  workspace_id: string;
  project_id: string;
  bot_user_id: string | null;
  trigger: string;
  enabled: boolean;
}

const LABEL: Record<MessagingProvider, string> = {
  telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp",
};

// ── Outils ──────────────────────────────────────────────────────────────────

/** Comparaison à temps constant : un secret comparé caractère par caractère
 *  laisse deviner sa longueur, puis son contenu, au temps de réponse. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/** Travail à finir après la réponse (Discord exige une réponse sous 3 s). */
function background(p: Promise<unknown>) {
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p.catch(() => {}));
  else p.catch(() => {});
}

async function loadChannel(admin: Admin, id: string, provider: MessagingProvider): Promise<Channel | null> {
  const { data } = await admin.from("internal_agent_channels")
    .select("id, agent_id, workspace_id, project_id, bot_user_id, trigger, enabled, provider")
    .eq("id", id).maybeSingle();
  const c = data as (Channel & { provider: string }) | null;
  if (!c || c.provider !== provider || !c.enabled) return null;
  return c;
}

// ── Ce qui entre : un message pour l'agent ─────────────────────────────────

/**
 * Un message adressé à l'agent, quelle que soit la messagerie.
 *
 * Même contrat que slack-gateway : dédoublonnage (les trois fournisseurs
 * relivrent), « mission : … » pour une mission suivie, sinon une conversation
 * par (canal, sujet) qui garde le contexte, et l'exécution lancée sans attendre
 * — la réponse repart par le finaliseur d'internal-agent-run.
 */
async function ingest(
  admin: Admin,
  provider: MessagingProvider,
  channel: Channel,
  m: { eventId: string; chatRef: string; threadRef: string | null; userRef: string; userName: string; text: string },
): Promise<void> {
  const { error: dup } = await admin.from("internal_agent_channel_events").insert({ event_id: m.eventId });
  if (dup) return;

  const missionMatch = m.text.match(/^\s*mission\b[\s:–—-]*([\s\S]{5,})$/i);
  if (missionMatch) {
    const brief = missionMatch[1].trim();
    const title = brief.replace(/\s+/g, " ").slice(0, 80) || "Mission";
    const { data: mission } = await admin.from("internal_agent_missions").insert({
      agent_id: channel.agent_id, workspace_id: channel.workspace_id, project_id: channel.project_id,
      title, brief, status: "active", board_column: "todo",
      channel_id: channel.id, external_channel_ref: m.chatRef, external_thread_ref: m.threadRef,
    }).select("id, title").single();
    if (!mission) return;
    const { data: run } = await admin.from("internal_agent_runs").insert({
      mission_id: mission.id, agent_id: channel.agent_id, workspace_id: channel.workspace_id,
      project_id: channel.project_id, status: "queued", triggered_via: "api",
    }).select("id").single();
    if (run && SUPABASE_URL && SERVICE_KEY) {
      fetch(`${SUPABASE_URL}/functions/v1/internal-agent-run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: channel.agent_id, mode: "mission", run_id: run.id }),
      }).catch(() => {});
    }
    await sendMessagingText(admin, channel.id, m.chatRef, m.threadRef,
      `🚀 Mission créée : ${mission.title}\nJe m'y mets — je posterai le résultat ici quand ce sera terminé.`);
    return;
  }

  const title = `${provider}:${m.chatRef}:${m.threadRef ?? "main"}`;
  let conversationId: string | null = null;
  const { data: existing } = await admin.from("internal_agent_conversations").select("id")
    .eq("agent_id", channel.agent_id).eq("title", title).maybeSingle();
  const binding = {
    channel_id: channel.id, external_channel_ref: m.chatRef, external_thread_ref: m.threadRef,
    // L'auteur du DERNIER message — lui seul pourra valider ce que l'agent
    // demandera pendant ce tour (0251).
    external_user_ref: m.userRef,
  };
  if (existing) {
    conversationId = (existing as { id: string }).id;
    await admin.from("internal_agent_conversations").update(binding).eq("id", conversationId);
  } else {
    const { data: created } = await admin.from("internal_agent_conversations").insert({
      agent_id: channel.agent_id, workspace_id: channel.workspace_id, project_id: channel.project_id,
      title, ...binding,
    }).select("id").single();
    conversationId = (created as { id: string } | null)?.id ?? null;
  }
  if (!conversationId) return;

  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId, agent_id: channel.agent_id, role: "user",
    content: `[${m.userName} in ${LABEL[provider]}] ${m.text}`,
  });

  if (SUPABASE_URL && SERVICE_KEY) {
    fetch(`${SUPABASE_URL}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: channel.agent_id, mode: "chat", conversation_id: conversationId }),
    }).catch(() => {});
  }
}

// ── Telegram ────────────────────────────────────────────────────────────────

async function handleTelegram(req: Request, admin: Admin, channelId: string): Promise<Response> {
  const channel = await loadChannel(admin, channelId, "telegram");
  const creds = channel ? await loadCredentials(admin, channelId) : null;
  const expected = creds?.secrets?.webhook_secret ?? "";
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!channel || !creds?.accessToken || !expected || !safeEqual(got, expected)) {
    return jsonResponse({ ok: false }, { status: 401 });
  }

  const u = await req.json().catch(() => null);
  if (!u) return jsonResponse({ ok: true });

  // Un clic sur un bouton d'autorisation.
  if (u.callback_query) {
    const q = u.callback_query;
    const parsed = parseApprovalButton(String(q.data ?? ""));
    if (parsed) {
      const outcome = await decideApprovalFromChannel(admin, {
        approvalId: parsed.approvalId, decision: parsed.decision,
        provider: "telegram", clickerRef: String(q.from?.id ?? ""),
      });
      await telegramApi(creds.accessToken, "answerCallbackQuery", {
        callback_query_id: q.id, text: outcome.message.slice(0, 190), show_alert: !outcome.ok,
      });
      // Les boutons disparaissent une fois la demande tranchée — pour qu'on ne
      // clique pas deux fois, ni qu'un tiers la croie encore ouverte.
      if (outcome.ok && q.message) {
        await telegramApi(creds.accessToken, "editMessageReplyMarkup", {
          chat_id: q.message.chat?.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] },
        });
        await telegramApi(creds.accessToken, "sendMessage", {
          chat_id: q.message.chat?.id, text: `${outcome.message} — par ${q.from?.first_name ?? "?"}`,
          ...(q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {}),
        });
      }
    }
    return jsonResponse({ ok: true });
  }

  const msg = u.message;
  if (!msg?.text || msg.from?.is_bot) return jsonResponse({ ok: true });

  // En privé, tout message est pour l'agent. Dans un groupe, seulement s'il est
  // mentionné ou qu'on répond à l'un de ses messages — sauf si le canal a été
  // réglé pour tout écouter.
  const botName = channel.bot_user_id ?? "";
  const isPrivate = msg.chat?.type === "private";
  const mentioned = !!botName && String(msg.text).includes(`@${botName}`);
  const replyToBot = msg.reply_to_message?.from?.username === botName;
  if (!isPrivate && !mentioned && !replyToBot && channel.trigger !== "all") {
    return jsonResponse({ ok: true });
  }
  const text = String(msg.text).replace(new RegExp(`@${botName}\\b`, "gi"), "").trim();
  if (!text) return jsonResponse({ ok: true });

  await ingest(admin, "telegram", channel, {
    eventId: `tg:${channelId}:${u.update_id}`,
    chatRef: String(msg.chat.id),
    threadRef: msg.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : null,
    userRef: String(msg.from?.id ?? ""),
    userName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "user",
    text,
  });
  return jsonResponse({ ok: true });
}

// ── Discord ─────────────────────────────────────────────────────────────────

async function verifyDiscord(req: Request, raw: string, publicKeyHex: string): Promise<boolean> {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" }, key, hexToBytes(sig), new TextEncoder().encode(ts + raw),
    );
  } catch {
    return false;
  }
}

async function handleDiscord(req: Request, admin: Admin, channelId: string): Promise<Response> {
  const raw = await req.text();
  const channel = await loadChannel(admin, channelId, "discord");
  const creds = channel ? await loadCredentials(admin, channelId) : null;
  // Discord EXIGE un 401 sur une signature invalide : il envoie volontairement
  // des requêtes mal signées pour vérifier que l'endpoint les refuse.
  if (!channel || !creds || !(await verifyDiscord(req, raw, creds.secrets.public_key ?? ""))) {
    return new Response("invalid request signature", { status: 401 });
  }

  const i = JSON.parse(raw);
  if (i.type === 1) return jsonResponse({ type: 1 }); // PING

  const user = i.member?.user ?? i.user ?? {};
  const userRef = String(user.id ?? "");

  // Un clic sur un bouton d'autorisation.
  if (i.type === 3) {
    const parsed = parseApprovalButton(String(i.data?.custom_id ?? ""));
    if (!parsed) return jsonResponse({ type: 6 });
    const outcome = await decideApprovalFromChannel(admin, {
      approvalId: parsed.approvalId, decision: parsed.decision, provider: "discord", clickerRef: userRef,
    });
    return jsonResponse(outcome.ok
      // Le message d'origine devient le verdict, sans ses boutons.
      ? { type: 7, data: { content: `${outcome.message} — par <@${userRef}>`, components: [] } }
      // Un refus (mauvaise personne…) ne répond qu'à qui a cliqué.
      : { type: 4, data: { content: outcome.message, flags: 64 } });
  }

  // La commande /agent demande:<texte>.
  if (i.type === 2 && i.data?.name === "agent") {
    const opt = (i.data.options ?? []).find((o: { name: string }) => o.name === "demande");
    const text = String(opt?.value ?? "").trim();
    if (!text) return jsonResponse({ type: 4, data: { content: "Précisez votre demande.", flags: 64 } });

    // La réponse doit partir sous trois secondes : l'enregistrement et le
    // lancement de l'agent se finissent après.
    background(ingest(admin, "discord", channel, {
      eventId: `dc:${i.id}`,
      chatRef: String(i.channel_id ?? i.channel?.id ?? ""),
      threadRef: null,
      userRef,
      userName: String(user.global_name ?? user.username ?? "user"),
      text,
    }));
    return jsonResponse({
      type: 4,
      data: { content: `> ${text.slice(0, 300)}\n🧠 Je m'en occupe — je réponds ici.` },
    });
  }

  return jsonResponse({ type: 4, data: { content: "Commande inconnue.", flags: 64 } });
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

async function handleWhatsappVerify(url: URL, admin: Admin, channelId: string): Promise<Response> {
  const creds = await loadCredentials(admin, channelId);
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (url.searchParams.get("hub.mode") === "subscribe" && creds?.secrets?.verify_token
    && safeEqual(token, creds.secrets.verify_token)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

async function handleWhatsapp(req: Request, admin: Admin, channelId: string): Promise<Response> {
  const raw = await req.text();
  const channel = await loadChannel(admin, channelId, "whatsapp");
  const creds = channel ? await loadCredentials(admin, channelId) : null;
  const secret = creds?.secrets?.app_secret ?? "";
  const sig = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!channel || !secret || !sig) return jsonResponse({ ok: false }, { status: 401 });
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  if (!safeEqual(sig, expected)) return jsonResponse({ ok: false }, { status: 401 });

  const body = JSON.parse(raw);
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const name = String(v.contacts?.[0]?.profile?.name ?? "user");
      for (const msg of v.messages ?? []) {
        const from = String(msg.from ?? "");
        // Un clic sur un bouton d'autorisation.
        const buttonId = msg.interactive?.button_reply?.id ?? msg.button?.payload ?? null;
        const parsed = buttonId ? parseApprovalButton(String(buttonId)) : null;
        if (parsed) {
          const outcome = await decideApprovalFromChannel(admin, {
            approvalId: parsed.approvalId, decision: parsed.decision, provider: "whatsapp", clickerRef: from,
          });
          await sendMessagingText(admin, channel.id, from, null, outcome.message);
          continue;
        }
        const text = String(msg.text?.body ?? "").trim();
        if (!text) continue;
        await ingest(admin, "whatsapp", channel, {
          eventId: `wa:${msg.id}`, chatRef: from, threadRef: null, userRef: from, userName: name, text,
        });
      }
    }
  }
  // Meta relivre tout ce qui n'a pas reçu un 200 : on répond toujours 200 une
  // fois la signature vérifiée, le dédoublonnage évite les doubles traitements.
  return jsonResponse({ ok: true });
}

// ── La connexion, depuis l'application ─────────────────────────────────────

async function handleConnect(req: Request): Promise<Response> {
  const auth = req.headers.get("Authorization");
  if (!auth) return jsonResponse({ error: "Authentification requise" }, { status: 401 });
  const { data: u, error: ue } = await createUserClient(auth).auth.getUser();
  if (ue || !u.user) return jsonResponse({ error: "Session invalide" }, { status: 401 });
  const userId = u.user.id;

  const body = await req.json().catch(() => ({})) as Record<string, string>;
  const provider = body.provider as MessagingProvider;
  if (!["telegram", "discord", "whatsapp"].includes(provider)) {
    return jsonResponse({ error: "Messagerie inconnue" }, { status: 400 });
  }

  const admin = createServiceClient();
  // Mêmes droits que pour valider une action de l'agent : son créateur, ou un
  // éditeur. Brancher un agent sur une messagerie, c'est ouvrir une porte vers
  // lui — la même personne doit pouvoir le décider.
  const { data: agent } = await admin.from("internal_agents")
    .select("id, created_by, workspace_id, project_id").eq("id", body.agent_id ?? "").maybeSingle();
  if (!agent) return jsonResponse({ error: "Agent introuvable" }, { status: 404 });
  let allowed = (agent as { created_by?: string }).created_by === userId;
  if (!allowed) {
    const { data: member } = await admin.from("internal_agent_members")
      .select("role").eq("agent_id", body.agent_id).eq("user_id", userId).maybeSingle();
    allowed = (member as { role?: string } | null)?.role === "editor";
  }
  if (!allowed) return jsonResponse({ error: "Seul le créateur de l'agent ou un éditeur peut le brancher." }, { status: 403 });

  const a = agent as { id: string; workspace_id: string; project_id: string };

  const upsertChannel = async (externalTeamId: string, botUserId: string | null, teamName: string | null) => {
    const { data, error } = await admin.from("internal_agent_channels").upsert({
      provider, external_team_id: externalTeamId, agent_id: a.id,
      workspace_id: a.workspace_id, project_id: a.project_id,
      bot_user_id: botUserId, team_name: teamName, enabled: true, created_by: userId,
    }, { onConflict: "provider,external_team_id,agent_id" }).select("id").single();
    if (error || !data) throw new Error(error?.message ?? "Canal non enregistré");
    return (data as { id: string }).id;
  };
  const storeSecrets = async (channelId: string, accessToken: string, secrets: Record<string, string>) => {
    const { error } = await admin.from("internal_agent_channel_tokens").upsert(
      { channel_id: channelId, access_token: accessToken, secrets },
      { onConflict: "channel_id" },
    );
    if (error) throw new Error(error.message);
  };

  try {
    if (provider === "telegram") {
      const token = (body.bot_token ?? "").trim();
      const me = await telegramApi(token, "getMe", {});
      if (!me?.ok) return jsonResponse({ error: "Jeton de bot Telegram refusé par Telegram." }, { status: 400 });
      const channelId = await upsertChannel(String(me.result.id), String(me.result.username ?? ""), String(me.result.first_name ?? ""));
      const secret = randomSecret();
      await storeSecrets(channelId, token, { webhook_secret: secret });
      const hook = await telegramApi(token, "setWebhook", {
        url: `${GATEWAY}?provider=telegram&c=${channelId}`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      });
      if (!hook?.ok) return jsonResponse({ error: `Webhook refusé par Telegram : ${hook?.description ?? "?"}` }, { status: 400 });
      return jsonResponse({ ok: true, channel_id: channelId, bot_name: `@${me.result.username}` });
    }

    if (provider === "discord") {
      const token = (body.bot_token ?? "").trim();
      const appId = (body.application_id ?? "").trim();
      const publicKey = (body.public_key ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(publicKey)) return jsonResponse({ error: "Clé publique Discord invalide (64 caractères hexadécimaux)." }, { status: 400 });
      const meRes = await discordApi(token, "GET", "/users/@me");
      if (!meRes.ok) return jsonResponse({ error: "Jeton de bot Discord refusé par Discord." }, { status: 400 });
      const me = await meRes.json();
      // La commande /agent, déclarée pour toute l'application.
      const cmd = await discordApi(token, "POST", `/applications/${appId}/commands`, {
        name: "agent", type: 1,
        description: "Demander quelque chose à l'agent",
        options: [{ type: 3, name: "demande", description: "Votre demande", required: true }],
      });
      if (!cmd.ok) return jsonResponse({ error: `Commande /agent refusée par Discord (${cmd.status}). Vérifiez l'Application ID.` }, { status: 400 });
      const channelId = await upsertChannel(appId, String(me.id), String(me.username ?? ""));
      await storeSecrets(channelId, token, { public_key: publicKey });
      return jsonResponse({
        ok: true, channel_id: channelId, bot_name: String(me.username ?? ""),
        interactions_url: `${GATEWAY}?provider=discord&c=${channelId}`,
      });
    }

    // WhatsApp
    const token = (body.access_token ?? "").trim();
    const phoneId = (body.phone_number_id ?? "").trim();
    const appSecret = (body.app_secret ?? "").trim();
    if (!phoneId || !appSecret) return jsonResponse({ error: "Phone number ID et App secret requis." }, { status: 400 });
    const probe = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=display_phone_number`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!probe.ok) return jsonResponse({ error: "Identifiants WhatsApp refusés par Meta." }, { status: 400 });
    const info = await probe.json();
    const channelId = await upsertChannel(phoneId, null, String(info.display_phone_number ?? ""));
    const verifyToken = randomSecret();
    await storeSecrets(channelId, token, { app_secret: appSecret, verify_token: verifyToken });
    return jsonResponse({
      ok: true, channel_id: channelId, bot_name: String(info.display_phone_number ?? ""),
      webhook_url: `${GATEWAY}?provider=whatsapp&c=${channelId}`, verify_token: verifyToken,
    });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ── Aiguillage ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const url = new URL(req.url);

  try {
    if (url.searchParams.get("action") === "connect" && req.method === "POST") {
      return await handleConnect(req);
    }

    const provider = url.searchParams.get("provider");
    const channelId = url.searchParams.get("c") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(channelId)) return jsonResponse({ ok: true, service: "messaging-gateway" });

    const admin = createServiceClient();
    if (provider === "whatsapp" && req.method === "GET") return await handleWhatsappVerify(url, admin, channelId);
    if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, { status: 405 });
    if (provider === "telegram") return await handleTelegram(req, admin, channelId);
    if (provider === "discord") return await handleDiscord(req, admin, channelId);
    if (provider === "whatsapp") return await handleWhatsapp(req, admin, channelId);
    return jsonResponse({ error: "unknown provider" }, { status: 400 });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
