// project-accept-invitation — convert a project_invitations row into a real
// project_members row for the authenticated user.
// Body: { token }

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

    const { token } = await req.json();
    if (!token) return jsonResponse({ error: "token required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: invitation } = await admin
      .from("project_invitations")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (!invitation) return jsonResponse({ error: "Unknown token" }, { status: 404 });
    if (invitation.accepted_at) return jsonResponse({ error: "Already accepted" }, { status: 410 });
    if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
      return jsonResponse({ error: "Invitation expired" }, { status: 410 });
    }
    // The signed-in user must match the invited email.
    if (u.user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
      return jsonResponse({ error: "This invitation was sent to a different email" }, { status: 403 });
    }

    const { error } = await admin.from("project_members").upsert(
      {
        project_id: invitation.project_id,
        workspace_id: invitation.workspace_id,
        user_id: u.user.id,
        role_id: invitation.role_id,
        invited_by: invitation.invited_by,
      },
      { onConflict: "project_id,user_id" },
    );
    if (error) return jsonResponse({ error: "Could not add", detail: error.message }, { status: 500 });

    await admin
      .from("project_invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    await admin.from("activity_logs").insert({
      workspace_id: invitation.workspace_id,
      project_id: invitation.project_id,
      actor_user_id: u.user.id,
      event_type: "project.invitation_accepted",
      title: `${u.user.email} joined the project`,
      payload: { invitation_id: invitation.id },
    });

    return jsonResponse({ ok: true, project_id: invitation.project_id });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
