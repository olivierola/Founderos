// accept-invite — accepts an invitation token, adds the user as a workspace_member.
// Body: { token }

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

    const { token } = await req.json();
    if (!token) return jsonResponse({ error: "token required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: inv } = await admin
      .from("team_invitations")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (!inv) return jsonResponse({ error: "Invitation not found" }, { status: 404 });
    if (inv.status !== "pending") return jsonResponse({ error: `Invitation ${inv.status}` }, { status: 400 });
    if (new Date(inv.expires_at) < new Date()) {
      await admin.from("team_invitations").update({ status: "expired" }).eq("id", inv.id);
      return jsonResponse({ error: "Invitation expired" }, { status: 400 });
    }
    if (inv.email.toLowerCase() !== (userData.user.email ?? "").toLowerCase()) {
      return jsonResponse({ error: "Email mismatch with current session" }, { status: 403 });
    }

    await admin
      .from("workspace_members")
      .upsert(
        { workspace_id: inv.workspace_id, user_id: userData.user.id, role: inv.role },
        { onConflict: "workspace_id,user_id" },
      );
    await admin
      .from("team_invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", inv.id);

    return jsonResponse({ ok: true, workspace_id: inv.workspace_id, role: inv.role });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
