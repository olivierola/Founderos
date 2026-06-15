// send-email — sends a transactional email via Resend using the workspace's connector.
// Body: { workspace_id, project_id, to, subject, html?, text?, from? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });

    const { workspace_id, project_id, to, subject, html, text, from } = await req.json();
    if (!workspace_id || !project_id || !to || !subject || (!html && !text)) {
      return jsonResponse({ error: "workspace_id, project_id, to, subject, html|text required" }, { status: 400 });
    }

    const admin = createServiceClient();
    // Allow the agent worker (service role) or a workspace owner/admin.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!(serviceKey && authHeader === `Bearer ${serviceKey}`)) {
      const userClient = createUserClient(authHeader);
      const { data: userData } = await userClient.auth.getUser();
      if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const { data: m } = await admin
        .from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
      if (!m || !["owner", "admin"].includes(m.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    const { payload } = await getConnectorCredential(workspace_id, project_id, "resend");
    const apiKey = payload.api_key;
    if (!apiKey) return jsonResponse({ error: "Resend api_key missing" }, { status: 400 });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: from ?? "FounderOS <noreply@founderos.app>",
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html ?? undefined,
        text: text ?? undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return jsonResponse({ error: "Resend rejected", detail: data }, { status: 502 });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userData.user.id,
      event_type: "email.sent",
      title: `Email sent to ${Array.isArray(to) ? to.join(", ") : to}`,
      payload: { subject, provider: "resend" },
    });

    return jsonResponse({ ok: true, resend: data });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
