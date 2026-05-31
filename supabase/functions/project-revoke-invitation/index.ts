// project-revoke-invitation — delete a pending invitation.
// Body: { workspace_id, project_id, invitation_id }
// Requires settings.team.manage.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(auth);
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id, invitation_id } = body as {
      workspace_id?: string;
      project_id?: string;
      invitation_id?: string;
    };
    if (!workspace_id || !project_id || !invitation_id) {
      return jsonResponse({ error: "workspace_id, project_id, invitation_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: ok } = await admin.rpc("has_permission", {
      p_user: u.user.id,
      p_project: project_id,
      p_perm: "settings.team.manage",
    });
    if (!ok) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { error } = await admin
      .from("project_invitations")
      .delete()
      .eq("id", invitation_id)
      .eq("project_id", project_id);
    if (error) return jsonResponse({ error: "Could not revoke", detail: error.message }, { status: 500 });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: u.user.id,
      event_type: "project.invitation_revoked",
      title: "Invitation revoked",
      payload: { invitation_id },
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
