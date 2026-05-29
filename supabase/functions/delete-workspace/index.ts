// delete-workspace — destructive deletion of a workspace and ALL related data.
// Body: { workspace_id, confirm_slug }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, confirm_slug } = await req.json();
    if (!workspace_id || !confirm_slug) {
      return jsonResponse({ error: "workspace_id, confirm_slug required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: ws } = await admin.from("workspaces").select("slug, owner_id").eq("id", workspace_id).maybeSingle();
    if (!ws) return jsonResponse({ error: "Workspace not found" }, { status: 404 });
    if (ws.owner_id !== userData.user.id) {
      return jsonResponse({ error: "Only the workspace owner can delete it" }, { status: 403 });
    }
    if (ws.slug !== confirm_slug) {
      return jsonResponse({ error: `confirm_slug must equal '${ws.slug}'` }, { status: 400 });
    }

    // Cascades handle most child rows
    const { error } = await admin.from("workspaces").delete().eq("id", workspace_id);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
