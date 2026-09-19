// teams-gateway — connect internal agents to Microsoft Teams (Bot Framework).
//
// Azure Bot posts inbound activities here (the bot's "messaging endpoint"). We
// verify the Bot Framework JWT, route the message to the agent bound to that
// tenant, keep one internal conversation per Teams thread, and fire a durable
// chat run. The agent's reply is posted back proactively by internal-agent-run's
// finalizer via the connector API (teamsSendMessage), using the serviceUrl we
// cache on the channel. Mirrors slack-gateway.
//
// Setup (done by the operator, once): register an Azure Bot → set its messaging
// endpoint to this function's URL → set MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD
// secrets → publish a Teams app manifest for the bot. Then bind an agent to a
// tenant from the agent's Channels tab.

import { jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { decideApprovalFromChannel } from "../_shared/channel-approval.ts";
import { teamsSendMessage } from "../_shared/teams.ts";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Bot Framework signs channel→bot tokens; verify against its JWKS.
const JWKS = createRemoteJWKSet(new URL("https://login.botframework.com/v1/keys"));

async function verifyBotToken(authHeader: string | null): Promise<boolean> {
  const appId = Deno.env.get("MICROSOFT_APP_ID");
  if (!appId) return false;
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  try {
    await jwtVerify(token, JWKS, { issuer: "https://api.botframework.com", audience: appId });
    return true;
  } catch {
    return false;
  }
}

function cleanText(raw: string): string {
  return String(raw ?? "").replace(/<at>[\s\S]*?<\/at>/gi, "").replace(/\s+/g, " ").trim();
}

// Turn a Teams "mission: …" request into a real tracked mission + launch it.
async function createMissionFromTeams(
  admin: ReturnType<typeof createServiceClient>,
  channel: { id: string; agent_id: string; workspace_id: string; project_id: string; service_url: string | null },
  brief: string,
  conversationId: string,
) {
  const title = brief.replace(/\s+/g, " ").slice(0, 80) || "Mission";
  const { data: mission } = await admin.from("internal_agent_missions").insert({
    agent_id: channel.agent_id, workspace_id: channel.workspace_id, project_id: channel.project_id,
    title, brief, status: "active", board_column: "todo",
    channel_id: channel.id, external_channel_ref: conversationId,
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
  await teamsSendMessage(channel.service_url, conversationId,
    `🚀 Mission créée : **${mission.title}**\nJe m'y mets — je posterai le résultat ici quand ce sera terminé. (Suivi dans l'onglet *Missions*.)`);
}

async function handleActivity(raw: string): Promise<Response> {
  let a: any;
  try { a = JSON.parse(raw); } catch { return jsonResponse({ ok: false }, { status: 400 }); }

  // Only react to user messages.
  if (a?.type !== "message") return jsonResponse({ ok: true });

  const admin = createServiceClient();

  const tenantId = String(a.channelData?.tenant?.id ?? a.conversation?.tenantId ?? "");
  const serviceUrl = String(a.serviceUrl ?? "");
  const conversationId = String(a.conversation?.id ?? "");
  const botId = String(a.recipient?.id ?? "");
  const fromId = String(a.from?.id ?? "");
  const fromName = String(a.from?.name ?? "user");
  if (!tenantId || !conversationId) return jsonResponse({ ok: true });

  // Dedup (Bot Framework may retry). activity.id is unique per delivery.
  const eventId = `teams:${String(a.id ?? `${conversationId}:${Date.now()}`)}`;
  const { error: dupErr } = await admin.from("internal_agent_channel_events").insert({ event_id: eventId });
  if (dupErr) return jsonResponse({ ok: true });

  // Route to the agent bound to this tenant (prefer the addressed bot).
  const { data: channels } = await admin.from("internal_agent_channels")
    .select("id, agent_id, workspace_id, project_id, bot_user_id, service_url, enabled")
    .eq("provider", "teams").eq("external_team_id", tenantId).eq("enabled", true);
  if (!channels || channels.length === 0) return jsonResponse({ ok: true });
  const channel = (botId && channels.find((c) => c.bot_user_id === botId)) || channels[0];
  if (fromId && fromId === channel.bot_user_id) return jsonResponse({ ok: true }); // ignore self

  // Keep the channel's serviceUrl / bot id fresh (needed to reply proactively).
  if (serviceUrl !== channel.service_url || (botId && botId !== channel.bot_user_id)) {
    await admin.from("internal_agent_channels")
      .update({ service_url: serviceUrl || channel.service_url, bot_user_id: botId || channel.bot_user_id })
      .eq("id", channel.id);
    channel.service_url = serviceUrl || channel.service_url;
  }

  // L'identifiant STABLE de l'auteur — son objet Azure AD. Le nom affiché ne
  // prouve rien : deux personnes peuvent le porter.
  const fromRef = String(a.from?.aadObjectId ?? a.from?.id ?? "");

  // Un clic sur un bouton de carte adaptative arrive comme un message SANS
  // texte, avec les données du bouton dans `value`. On le traite avant le
  // texte, qui serait vide et ferait ignorer le clic.
  if (a.value && typeof a.value === "object" && a.value.fos_approval) {
    const d = a.value.decision;
    const decision = d === "approve" || d === "approve_all" || d === "reject" ? d : null;
    if (decision) {
      const outcome = await decideApprovalFromChannel(admin, {
        approvalId: String(a.value.fos_approval), decision, provider: "teams", clickerRef: fromRef,
      });
      await teamsSendMessage(channel.service_url ?? serviceUrl, conversationId, `${outcome.message} — par ${fromName}`);
    }
    return jsonResponse({ ok: true });
  }

  const text = cleanText(a.text);
  if (!text) return jsonResponse({ ok: true });

  // Mission intent: "mission: <brief>".
  const missionMatch = text.match(/^\s*mission\b[\s:–—-]*([\s\S]{5,})$/i);
  if (missionMatch) {
    await createMissionFromTeams(admin, { ...channel, service_url: channel.service_url ?? serviceUrl }, missionMatch[1].trim(), conversationId);
    return jsonResponse({ ok: true, mission: true });
  }

  // Reuse one internal conversation per Teams conversation/thread.
  const title = `teams:${conversationId}`;
  let conversationRowId: string | null = null;
  const { data: existing } = await admin.from("internal_agent_conversations").select("id")
    .eq("agent_id", channel.agent_id).eq("title", title).maybeSingle();
  if (existing) {
    conversationRowId = existing.id;
    await admin.from("internal_agent_conversations")
      .update({ channel_id: channel.id, external_channel_ref: conversationId, external_thread_ref: null, external_user_ref: fromRef || null })
      .eq("id", conversationRowId);
  } else {
    const { data: created } = await admin.from("internal_agent_conversations").insert({
      agent_id: channel.agent_id, workspace_id: channel.workspace_id, project_id: channel.project_id,
      title, channel_id: channel.id, external_channel_ref: conversationId, external_thread_ref: null,
    external_user_ref: fromRef || null,
  }).select("id").single();
    conversationRowId = created?.id ?? null;
  }
  if (!conversationRowId) return jsonResponse({ ok: true });

  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationRowId, agent_id: channel.agent_id, role: "user",
    content: `[${fromName} in Teams] ${text}`,
  });

  // Fire the durable chat run; the reply is posted back by the finalizer.
  if (SUPABASE_URL && SERVICE_KEY) {
    fetch(`${SUPABASE_URL}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: channel.agent_id, mode: "chat", conversation_id: conversationRowId }),
    }).catch(() => {});
  }
  return jsonResponse({ ok: true });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "GET") return jsonResponse({ ok: true, service: "teams-gateway" });
    if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, { status: 405 });
    const raw = await req.text();
    const ok = await verifyBotToken(req.headers.get("authorization"));
    if (!ok) return jsonResponse({ error: "unauthorized" }, { status: 401 });
    return await handleActivity(raw);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
