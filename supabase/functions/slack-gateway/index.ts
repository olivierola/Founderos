// slack-gateway — connect internal agents to Slack and route channel messages.
//
// One function, three entry points (Slack registers ONE URL for both OAuth and
// Events; we disambiguate by method/query):
//   • GET  ?install=1&agent_id=…&return_to=… → 302 to Slack's OAuth consent.
//   • GET  ?code=…&state=…                    → OAuth callback: exchange + store.
//   • POST (JSON, signed)                     → Slack Events API (app_mention…).
//
// Inbound mirrors project-inbox-post's dispatchAgent, MINUS the read-after-call:
// the agent's reply is posted back to the Slack thread by internal-agent-run's
// finalizeChatSuccess (the run is durable/async), using the binding we store on
// the conversation.

import { jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

const SLACK_CLIENT_ID = Deno.env.get("SLACK_CLIENT_ID") ?? "";
const SLACK_CLIENT_SECRET = Deno.env.get("SLACK_CLIENT_SECRET") ?? "";
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "").replace(/\/$/, "");

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/slack-gateway`;
const SCOPES = [
  "app_mentions:read", "chat:write", "channels:history", "channels:read",
  "groups:history", "im:history", "im:read", "users:read",
].join(",");

const b64u = {
  encode: (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))),
};

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

// ── Slack request signature (HMAC-SHA256 over `v0:{ts}:{rawBody}`) ─────────────
async function verifySlackSignature(raw: string, ts: string | null, sig: string | null): Promise<boolean> {
  if (!ts || !sig || !SLACK_SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5-min window
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const hex = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// Turn a Slack "mission: …" request into a real tracked mission + launch it.
async function createMissionFromSlack(
  admin: ReturnType<typeof createServiceClient>,
  channel: { id: string; agent_id: string; workspace_id: string; project_id: string },
  brief: string,
  slackChannel: string,
  threadRef: string,
) {
  const title = brief.replace(/\s+/g, " ").slice(0, 80) || "Mission";
  const { data: mission } = await admin.from("internal_agent_missions").insert({
    agent_id: channel.agent_id, workspace_id: channel.workspace_id, project_id: channel.project_id,
    title, brief, status: "active", board_column: "todo",
    channel_id: channel.id, external_channel_ref: slackChannel, external_thread_ref: threadRef,
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

  // Immediate ack in the thread (the completion report is posted by the run finalizer).
  const { data: tok } = await admin
    .from("internal_agent_channel_tokens").select("access_token").eq("channel_id", channel.id).maybeSingle();
  if (tok?.access_token) {
    await slackPost(tok.access_token, "chat.postMessage", {
      channel: slackChannel, thread_ts: threadRef || undefined,
      text: `🚀 Mission créée : *${mission.title}*\nJe m'y mets — je posterai le résultat ici quand ce sera terminé. (Suivi dans l'onglet *Missions*.)`,
    });
  }
}

async function slackPost(token: string, method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return await r.json().catch(() => ({}));
}

// ── OAuth: build the consent URL ──────────────────────────────────────────────
function handleInstall(url: URL): Response {
  const agentId = url.searchParams.get("agent_id") ?? "";
  const returnTo = url.searchParams.get("return_to") ?? "/";
  if (!agentId) return jsonResponse({ error: "agent_id required" }, { status: 400 });
  const state = b64u.encode(JSON.stringify({ a: agentId, r: returnTo }));
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", SLACK_CLIENT_ID);
  authorize.searchParams.set("scope", SCOPES);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("state", state);
  return redirect(authorize.toString());
}

// ── OAuth: exchange the code, store the connection + token ────────────────────
async function handleOAuthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  let agentId = "", returnTo = "/";
  try {
    const st = JSON.parse(b64u.decode(url.searchParams.get("state") ?? ""));
    agentId = String(st.a ?? ""); returnTo = String(st.r ?? "/");
  } catch { /* ignore */ }
  const backTo = (p: string) => redirect(`${APP_BASE_URL}${returnTo.startsWith("/") ? returnTo : "/"}?slack=${p}`);
  if (!code || !agentId) return backTo("error");

  const form = new URLSearchParams({
    client_id: SLACK_CLIENT_ID, client_secret: SLACK_CLIENT_SECRET, code, redirect_uri: REDIRECT_URI,
  });
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
  const j = await res.json().catch(() => ({} as any));
  if (!j.ok || !j.access_token) return backTo("error");

  const admin = createServiceClient();
  const { data: agent } = await admin
    .from("internal_agents").select("id, workspace_id, project_id, created_by")
    .eq("id", agentId).maybeSingle();
  if (!agent) return backTo("error");

  const { data: channel } = await admin
    .from("internal_agent_channels")
    .upsert({
      workspace_id: agent.workspace_id, project_id: agent.project_id, agent_id: agent.id,
      provider: "slack", external_team_id: j.team?.id ?? null, team_name: j.team?.name ?? null,
      bot_user_id: j.bot_user_id ?? null, enabled: true, created_by: agent.created_by ?? null,
    }, { onConflict: "provider,external_team_id,agent_id" })
    .select("id").single();

  if (channel) {
    await admin.from("internal_agent_channel_tokens").upsert({
      channel_id: channel.id, access_token: j.access_token, scope: j.scope ?? null,
    });
  }
  return backTo("connected");
}

// ── Events API ────────────────────────────────────────────────────────────────
async function handleEvents(raw: string): Promise<Response> {
  let body: any;
  try { body = JSON.parse(raw); } catch { return jsonResponse({ ok: false }, { status: 400 }); }

  if (body.type === "url_verification") return jsonResponse({ challenge: body.challenge });
  if (body.type !== "event_callback" || !body.event) return jsonResponse({ ok: true });

  const ev = body.event;
  // Only react to mentions (+ DMs). Ignore the bot's own messages, edits, joins…
  const isMention = ev.type === "app_mention";
  const isDm = ev.type === "message" && ev.channel_type === "im";
  if (!isMention && !isDm) return jsonResponse({ ok: true });
  if (ev.bot_id || ev.subtype) return jsonResponse({ ok: true });

  const admin = createServiceClient();

  // Dedup — Slack redelivers the same event up to 3×.
  const eventId = String(body.event_id ?? `${ev.channel}:${ev.ts}`);
  const { error: dupErr } = await admin.from("internal_agent_channel_events").insert({ event_id: eventId });
  if (dupErr) return jsonResponse({ ok: true }); // already handled

  // Resolve the connected agent for this workspace. When several agents are
  // installed, route by the mentioned bot user id (<@BOTID> in the text).
  const teamId = String(body.team_id ?? ev.team ?? "");
  const mentioned = String(ev.text ?? "").match(/<@([A-Z0-9]+)>/)?.[1] ?? null;
  let q = admin.from("internal_agent_channels")
    .select("id, agent_id, workspace_id, project_id, bot_user_id, enabled")
    .eq("provider", "slack").eq("external_team_id", teamId).eq("enabled", true);
  const { data: channels } = await q;
  if (!channels || channels.length === 0) return jsonResponse({ ok: true });
  const channel = (mentioned && channels.find((c) => c.bot_user_id === mentioned)) || channels[0];
  if (ev.user && ev.user === channel.bot_user_id) return jsonResponse({ ok: true }); // self

  // Strip the leading bot mention from the text.
  const text = String(ev.text ?? "").replace(/<@[A-Z0-9]+>\s*/i, "").trim();
  if (!text) return jsonResponse({ ok: true });

  const slackChannel = String(ev.channel ?? "");

  // Mission intent: "mission: <brief>" (or "mission <brief>") creates a tracked
  // mission that runs in the background, shows in the Missions tab, and reports
  // back to THIS thread when done. Rooted at the request message so the ack +
  // final report stay grouped.
  const missionMatch = text.match(/^\s*mission\b[\s:–—-]*([\s\S]{5,})$/i);
  if (missionMatch) {
    await createMissionFromSlack(admin, channel, missionMatch[1].trim(), slackChannel, ev.thread_ts ? String(ev.thread_ts) : String(ev.ts ?? ""));
    return jsonResponse({ ok: true, mission: true });
  }
  // Only reply IN a thread when the mention itself was in a thread. A top-level
  // channel mention (no thread_ts) → reply straight in the channel.
  const threadTs = ev.thread_ts ? String(ev.thread_ts) : null;
  const convoKey = threadTs ?? "main"; // one running conversation per channel for top-level chat

  // Reuse one internal conversation per (slack channel, thread) so the agent
  // keeps context across turns.
  const title = `slack:${slackChannel}:${convoKey}`;
  let conversationId: string | null = null;
  const { data: existing } = await admin
    .from("internal_agent_conversations").select("id")
    .eq("agent_id", channel.agent_id).eq("title", title).maybeSingle();
  if (existing) {
    conversationId = existing.id;
    // Keep the binding current (e.g. if the channel/thread ref shifted).
    await admin.from("internal_agent_conversations")
      .update({ channel_id: channel.id, external_channel_ref: slackChannel, external_thread_ref: threadTs })
      .eq("id", conversationId);
  } else {
    const { data: created } = await admin.from("internal_agent_conversations").insert({
      agent_id: channel.agent_id, workspace_id: channel.workspace_id, project_id: channel.project_id,
      title, channel_id: channel.id, external_channel_ref: slackChannel, external_thread_ref: threadTs,
    }).select("id").single();
    conversationId = created?.id ?? null;
  }
  if (!conversationId) return jsonResponse({ ok: true });

  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId, agent_id: channel.agent_id, role: "user",
    content: `[<@${ev.user}> in Slack] ${text}`,
  });

  // Fire the durable chat run (init + enqueue returns fast); the reply is posted
  // back to this Slack thread by internal-agent-run's finalizer.
  if (SUPABASE_URL && SERVICE_KEY) {
    fetch(`${SUPABASE_URL}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: channel.agent_id, mode: "chat", conversation_id: conversationId }),
    }).catch(() => {});
  }
  return jsonResponse({ ok: true });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      if (url.searchParams.has("install")) return handleInstall(url);
      if (url.searchParams.has("code")) return await handleOAuthCallback(url);
      return jsonResponse({ ok: true, service: "slack-gateway" });
    }
    if (req.method === "POST") {
      const raw = await req.text();
      // URL-verification handshake: echo the challenge immediately, BEFORE the
      // signature check. It carries no data and Slack expects a fast response
      // during setup (also avoids a chicken-and-egg with the signing secret).
      try {
        const early = JSON.parse(raw);
        if (early?.type === "url_verification") return jsonResponse({ challenge: early.challenge });
      } catch { /* not JSON — fall through */ }
      const ok = await verifySlackSignature(
        raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"),
      );
      if (!ok) return jsonResponse({ error: "bad signature" }, { status: 401 });
      return await handleEvents(raw);
    }
    return jsonResponse({ error: "method not allowed" }, { status: 405 });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
