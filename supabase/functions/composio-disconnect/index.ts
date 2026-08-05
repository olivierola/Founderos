// composio-disconnect — mirrors disconnect-provider for Composio connections.
// Body: { workspace_id, project_id, toolkit }
// Auth: workspace owner/admin.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getComposio } from "../_shared/composio.ts";

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
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized for this workspace" }, { status: 403 });
    }

    const { data: connector } = await admin
      .from("connectors")
      .select("id, composio_connected_account_id")
      .eq("workspace_id", workspace_id).eq("project_id", project_id)
      .eq("provider", toolkit).eq("source", "composio")
      .maybeSingle();
    if (!connector) return jsonResponse({ ok: true, already_gone: true });

    if (connector.composio_connected_account_id) {
      try {
        await getComposio().connectedAccounts.delete(connector.composio_connected_account_id);
      } catch {
        // Non-fatal — still drop our local row so the UI reflects "disconnected".
      }
    }

    await admin.from("connectors").delete().eq("id", connector.id);
    await admin.from("activity_logs").insert({
      workspace_id, project_id,
      actor_user_id: userData.user.id,
      event_type: "composio_connector.disconnected",
      title: `${toolkit} disconnected (Composio)`,
      payload: { toolkit },
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
