// project-invite-member — invite someone to a project with a specific role.
// Body: { workspace_id, project_id, email, role_id }
// Requires `settings.team.manage` on the project.

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
    const { workspace_id, project_id, email, role_id } = body as {
      workspace_id?: string;
      project_id?: string;
      email?: string;
      role_id?: string;
    };
    if (!workspace_id || !project_id || !email || !role_id) {
      return jsonResponse({ error: "workspace_id, project_id, email, role_id required" }, { status: 400 });
    }

    const admin = createServiceClient();

    // Authorization: inviter must hold settings.team.manage.
    const { data: ok } = await admin.rpc("has_permission", {
      p_user: u.user.id,
      p_project: project_id,
      p_perm: "settings.team.manage",
    });
    if (!ok) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // Validate the role: must be a built-in role OR belong to this workspace.
    const { data: role } = await admin
      .from("roles")
      .select("id, workspace_id, slug")
      .eq("id", role_id)
      .maybeSingle();
    if (!role) return jsonResponse({ error: "Unknown role" }, { status: 400 });
    if (role.workspace_id && role.workspace_id !== workspace_id) {
      return jsonResponse({ error: "Role belongs to a different workspace" }, { status: 400 });
    }

    // If the user already exists, add them directly. Otherwise create an
    // invitation row that they can accept after sign-up.
    const { data: existingUser } = await admin
      .from("auth.users" as any)
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (existingUser?.id) {
      const { error } = await admin
        .from("project_members")
        .upsert(
          {
            project_id,
            workspace_id,
            user_id: existingUser.id,
            role_id,
            invited_by: u.user.id,
          },
          { onConflict: "project_id,user_id" },
        );
      if (error) {
        return jsonResponse({ error: "Could not add member", detail: error.message }, { status: 500 });
      }
      await admin.from("activity_logs").insert({
        workspace_id,
        project_id,
        actor_user_id: u.user.id,
        event_type: "project.member_added",
        title: `Added ${email} as ${role.slug}`,
        payload: { user_id: existingUser.id, role_id },
      });
      return jsonResponse({ ok: true, kind: "added", user_id: existingUser.id });
    }

    // Pending invitation
    const { data: invite, error: inviteErr } = await admin
      .from("project_invitations")
      .insert({
        workspace_id,
        project_id,
        email: email.toLowerCase(),
        role_id,
        invited_by: u.user.id,
      })
      .select("token")
      .single();
    if (inviteErr || !invite) {
      return jsonResponse({ error: "Could not create invitation", detail: inviteErr?.message }, { status: 500 });
    }
    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: u.user.id,
      event_type: "project.member_invited",
      title: `Invited ${email} as ${role.slug}`,
      payload: { email, role_id },
    });
    return jsonResponse({ ok: true, kind: "invited", token: invite.token });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
