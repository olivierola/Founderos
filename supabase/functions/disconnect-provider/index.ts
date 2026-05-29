// disconnect-provider — removes a connector and its encrypted credentials.
// Body: { workspace_id, project_id, provider }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

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

    const { workspace_id, project_id, provider } = await req.json();
    if (!workspace_id || !project_id || !provider) {
      return jsonResponse({ error: "workspace_id, project_id, provider required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const { data: connector } = await admin
      .from("connectors")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("project_id", project_id)
      .eq("provider", provider)
      .maybeSingle();
    if (!connector) return jsonResponse({ ok: true, already_gone: true });

    await admin.from("encrypted_credentials").delete().eq("connector_id", connector.id);
    await admin.from("connectors").delete().eq("id", connector.id);

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userId,
      event_type: "connector.disconnected",
      title: `${provider} disconnected`,
      payload: { provider },
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
