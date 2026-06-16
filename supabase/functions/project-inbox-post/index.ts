// project-inbox-post — post a human message to a project channel and dispatch
// replies from any @mentioned internal agents.
//
// Body: { workspace_id, project_id, channel_id, body, mentions?: string[] }
//   mentions = internal_agents.id values @mentioned in the message.
// Auth: user session (must be a workspace member with channel access).
//
// Flow:
//   1. Insert the human message (service role).
//   2. For each mentioned agent: reuse/create a per-channel agent conversation,
//      append the human text, run the agent (chat mode), then copy its reply
//      into the channel as an `agent` message. Realtime pushes it to clients.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

async function dispatchAgent(
  admin: ReturnType<typeof createServiceClient>,
  opts: { workspaceId: string; projectId: string; channelId: string; agentId: string; humanText: string; authorName: string },
) {
  const { workspaceId, projectId, channelId, agentId, humanText, authorName } = opts;

  // The agent must exist, be in this project, and have chat enabled.
  const { data: agent } = await admin
    .from("internal_agents")
    .select("id, name, chat_enabled, is_archived")
    .eq("id", agentId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!agent || agent.is_archived || agent.chat_enabled === false) return;

  // Reuse one conversation per (agent, channel) so the agent keeps context.
  const convoTitle = `inbox:${channelId}`;
  let conversationId: string | null = null;
  const { data: existing } = await admin
    .from("internal_agent_conversations")
    .select("id")
    .eq("agent_id", agentId)
    .eq("title", convoTitle)
    .maybeSingle();
  if (existing) {
    conversationId = existing.id;
  } else {
    const { data: created } = await admin
      .from("internal_agent_conversations")
      .insert({ agent_id: agentId, workspace_id: workspaceId, project_id: projectId, title: convoTitle })
      .select("id")
      .single();
    conversationId = created?.id ?? null;
  }
  if (!conversationId) return;

  // Append the human turn (prefixed with who's speaking, for context).
  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId,
    agent_id: agentId,
    role: "user",
    content: `[${authorName} in the team chat] ${humanText}`,
  });

  // Run the agent (chat mode) — it persists an assistant message.
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  try {
    await fetch(`${base}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, mode: "chat", conversation_id: conversationId }),
    });
  } catch {
    // fall through — we still try to read whatever reply exists
  }

  // Read the latest assistant reply and mirror it into the channel.
  const { data: reply } = await admin
    .from("internal_agent_messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const text = reply?.content?.trim() || "(no reply)";
  await admin.from("project_messages").insert({
    workspace_id: workspaceId,
    project_id: projectId,
    channel_id: channelId,
    author_kind: "agent",
    agent_id: agentId,
    body: text,
  });
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = await req.json();
    const { workspace_id, project_id, channel_id, body: text } = body as {
      workspace_id?: string; project_id?: string; channel_id?: string; body?: string;
    };
    const mentions: string[] = Array.isArray(body.mentions) ? body.mentions.filter((m: unknown) => typeof m === "string") : [];
    if (!workspace_id || !project_id || !channel_id || !text || !text.trim()) {
      return jsonResponse({ error: "workspace_id, project_id, channel_id, body required" }, { status: 400 });
    }

    const admin = createServiceClient();

    // Authorize: must be a workspace member with access to the channel.
    const { data: m } = await admin
      .from("workspace_members").select("role")
      .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!m) return jsonResponse({ error: "Not authorized" }, { status: 403 });
    const { data: chan } = await admin
      .from("project_channels").select("id, is_private").eq("id", channel_id).eq("project_id", project_id).maybeSingle();
    if (!chan) return jsonResponse({ error: "Channel not found" }, { status: 404 });
    if (chan.is_private) {
      const { data: member } = await admin
        .from("project_channel_members").select("id").eq("channel_id", channel_id).eq("user_id", userId).maybeSingle();
      if (!member) return jsonResponse({ error: "Not a member of this private channel" }, { status: 403 });
    }

    // Author display name for the agent's context.
    const { data: profile } = await admin
      .from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
    const authorName = profile?.full_name || profile?.email || "A teammate";

    // 1) Persist the human message.
    const { data: msg, error: msgErr } = await admin
      .from("project_messages")
      .insert({
        workspace_id, project_id, channel_id,
        author_kind: "user", user_id: userId,
        body: text.trim(), mentions,
      })
      .select("id")
      .single();
    if (msgErr) return jsonResponse({ error: msgErr.message }, { status: 500 });

    // 2) Dispatch mentioned agents (sequentially to stay within limits).
    for (const agentId of mentions) {
      await dispatchAgent(admin, {
        workspaceId: workspace_id, projectId: project_id, channelId: channel_id,
        agentId, humanText: text.trim(), authorName,
      });
    }

    return jsonResponse({ ok: true, message_id: msg.id, dispatched: mentions.length });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
