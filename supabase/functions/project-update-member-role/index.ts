// project-update-member-role — change a member's role on a project.
// Body: { workspace_id, project_id, user_id, role_id }
// project-remove-member — pass `role_id: null` to remove the member.
// Requires `settings.team.manage`.

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
    const { workspace_id, project_id, user_id, role_id } = body as {
      workspace_id?: string;
      project_id?: string;
      user_id?: string;
      role_id?: string | null;
    };
    if (!workspace_id || !project_id || !user_id) {
      return jsonResponse({ error: "workspace_id, project_id, user_id required" }, { status: 400 });
    }

    const admin = createServiceClient();

    const { data: ok } = await admin.rpc("has_permission", {
      p_user: u.user.id,
      p_project: project_id,
      p_perm: "settings.team.manage",
    });
    if (!ok) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // Never let the last owner remove themselves: count owners first.
    if (!role_id) {
      const { count } = await admin
        .from("project_members")
        .select("id, role_id, roles!inner(slug)", { count: "exact", head: false })
        .eq("project_id", project_id);
      if ((count ?? 0) <= 1) {
        return jsonResponse({ error: "Cannot remove the last project member" }, { status: 400 });
      }
      const { error } = await admin
        .from("project_members")
        .delete()
        .eq("project_id", project_id)
        .eq("user_id", user_id);
      if (error) return jsonResponse({ error: "Could not remove", detail: error.message }, { status: 500 });
      await admin.from("activity_logs").insert({
        workspace_id,
        project_id,
        actor_user_id: u.user.id,
        event_type: "project.member_removed",
        title: "Member removed from project",
        payload: { user_id },
      });
      return jsonResponse({ ok: true, kind: "removed" });
    }

    // Validate the role.
    const { data: role } = await admin
      .from("roles")
      .select("id, workspace_id")
      .eq("id", role_id)
      .maybeSingle();
    if (!role) return jsonResponse({ error: "Unknown role" }, { status: 400 });
    if (role.workspace_id && role.workspace_id !== workspace_id) {
      return jsonResponse({ error: "Role belongs to a different workspace" }, { status: 400 });
    }

    const { error } = await admin
      .from("project_members")
      .update({ role_id })
      .eq("project_id", project_id)
      .eq("user_id", user_id);
    if (error) return jsonResponse({ error: "Could not update", detail: error.message }, { status: 500 });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: u.user.id,
      event_type: "project.member_role_changed",
      title: "Member role updated",
      payload: { user_id, role_id },
    });

    return jsonResponse({ ok: true, kind: "updated" });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
