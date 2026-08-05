// composio-connection-status — polled by the frontend while a Composio
// connect dialog is open. Body: { workspace_id, project_id, toolkit }
// Auth: workspace member.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getComposio, mapConnectionStatus } from "../_shared/composio.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id, toolkit } = body as {
      workspace_id?: string; project_id?: string; toolkit?: string;
    };
    if (!workspace_id || !project_id || !toolkit) {
      return jsonResponse({ error: "workspace_id, project_id, toolkit required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized for this workspace" }, { status: 403 });

    const { data: connector } = await admin
      .from("connectors")
      .select("id, status, composio_connected_account_id")
      .eq("workspace_id", workspace_id).eq("project_id", project_id)
      .eq("provider", toolkit).eq("source", "composio")
      .maybeSingle();
    if (!connector?.composio_connected_account_id) {
      return jsonResponse({ status: "not_connected" });
    }

    const composio = getComposio();
    const account = await composio.connectedAccounts.get(connector.composio_connected_account_id);
    const status = mapConnectionStatus((account as { status?: string }).status);

    await admin.from("connectors").update({ status }).eq("id", connector.id);

    return jsonResponse({ status });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
