// send-notification — sends a message via whichever messaging connector is
// configured for the project (Slack, Discord, or Telegram). Adapts payload to
// each provider's API automatically.
// Body: { workspace_id, project_id, message, provider? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

const MESSAGING = ["slack", "discord", "telegram"];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id, message } = body;
    const requested = body.provider as string | undefined;
    if (!workspace_id || !project_id || !message) {
      return jsonResponse({ error: "workspace_id, project_id, message required" }, { status: 400 });
    }

    const admin = createServiceClient();

    // Find configured messaging connectors for this project
    const { data: connectors } = await admin
      .from("connectors")
      .select("provider")
      .eq("project_id", project_id)
      .in("provider", MESSAGING);

    const available = (connectors ?? []).map((c) => c.provider);
    if (available.length === 0) {
      return jsonResponse(
        { error: "No messaging connector", detail: "Connect Slack, Discord or Telegram in the catalog first." },
        { status: 400 },
      );
    }

    const target = requested && available.includes(requested) ? requested : available[0]!;
    const { payload } = await getConnectorCredential(workspace_id, project_id, target);

    let okSent = false;
    let detail = "";
    if (target === "slack") {
      const res = await fetch(payload.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      okSent = res.ok;
      detail = await res.text();
    } else if (target === "discord") {
      const res = await fetch(payload.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      okSent = res.ok || res.status === 204;
      detail = await res.text();
    } else if (target === "telegram") {
      const res = await fetch(`https://api.telegram.org/bot${payload.api_key}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: payload.chat_id, text: message }),
      });
      okSent = res.ok;
      detail = await res.text();
    }

    if (!okSent) return jsonResponse({ error: `Failed to send via ${target}`, detail: detail.slice(0, 200) }, { status: 502 });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userData.user.id,
      event_type: "notification.sent",
      title: `Notification sent via ${target}`,
      payload: { provider: target },
    });

    return jsonResponse({ ok: true, provider: target, available });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
