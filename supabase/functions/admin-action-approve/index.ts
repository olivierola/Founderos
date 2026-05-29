// admin-action-approve — approve+execute or reject a pending admin_action.
// Body: { workspace_id, action_id, decision: "approve" | "reject", reason? }
// On approve: re-dispatches to execute-admin-action with confirm:true, then
// marks the original pending row with the outcome.

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
    const userId = userData.user.id;

    const { workspace_id, action_id, decision, reason } = await req.json();
    if (!workspace_id || !action_id || !decision) {
      return jsonResponse({ error: "workspace_id, action_id, decision required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Only owners/admins can approve actions" }, { status: 403 });
    }

    const { data: action } = await admin
      .from("admin_actions")
      .select("*")
      .eq("id", action_id)
      .eq("workspace_id", workspace_id)
      .maybeSingle();
    if (!action) return jsonResponse({ error: "Action not found" }, { status: 404 });
    if (action.status !== "pending") {
      return jsonResponse({ error: `Action is not pending (status: ${action.status})` }, { status: 400 });
    }

    if (decision === "reject") {
      await admin
        .from("admin_actions")
        .update({ status: "rejected", approved_by: userId, error_message: reason ?? "Rejected by approver" })
        .eq("id", action_id);
      return jsonResponse({ ok: true, status: "rejected" });
    }

    // Approve → execute. Re-dispatch to execute-admin-action with confirm.
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await admin.from("admin_actions").update({ status: "executing", approved_by: userId }).eq("id", action_id);

    const res = await fetch(`${projectUrl}/functions/v1/execute-admin-action`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json", apikey: serviceKey },
      body: JSON.stringify({
        workspace_id,
        project_id: action.project_id,
        action_type: action.action_type,
        payload: action.payload ?? {},
        confirm: true,
      }),
    });
    const out = await res.json().catch(() => ({}));

    if (!res.ok) {
      await admin
        .from("admin_actions")
        .update({ status: "failed", executed_at: new Date().toISOString(), error_message: out?.detail ?? out?.error ?? "Execution failed" })
        .eq("id", action_id);
      return jsonResponse({ error: "Execution failed", detail: out?.detail ?? out?.error }, { status: 502 });
    }

    await admin
      .from("admin_actions")
      .update({ status: "succeeded", executed_at: new Date().toISOString(), payload: { ...(action.payload ?? {}), result: out?.result } })
      .eq("id", action_id);

    return jsonResponse({ ok: true, status: "succeeded", result: out?.result });
  } catch (err) {
    return jsonResponse(
      { error: "admin-action-approve failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
