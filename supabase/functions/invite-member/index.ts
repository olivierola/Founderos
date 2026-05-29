// invite-member — creates a team invitation token + sends an email via Resend if configured.
// Body: { workspace_id, email, role }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

async function sendResendEmail(apiKey: string, to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "FounderOS <noreply@founderos.app>", to, subject, html }),
  });
  return res.ok;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, email, role } = await req.json();
    if (!workspace_id || !email) return jsonResponse({ error: "workspace_id, email required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m || !["owner", "admin"].includes(m.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    const { data: inv, error } = await admin
      .from("team_invitations")
      .insert({
        workspace_id,
        email,
        role: role ?? "member",
        token,
        invited_by: userData.user.id,
      })
      .select()
      .single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });

    // Try Resend if configured
    let emailSent = false;
    try {
      const { payload } = await getConnectorCredential(workspace_id, workspace_id, "resend").catch(() => ({ payload: { api_key: "" } } as { payload: { api_key: string } }));
      if (payload.api_key) {
        const link = `${Deno.env.get("APP_URL") ?? "http://localhost:5173"}/accept-invite?token=${token}`;
        emailSent = await sendResendEmail(
          payload.api_key,
          email,
          "You've been invited to a FounderOS workspace",
          `<p>You've been invited as <b>${role ?? "member"}</b>.</p><p><a href="${link}">Accept invite</a></p>`,
        );
      }
    } catch {
      /* ignore */
    }

    return jsonResponse({ ok: true, invitation: inv, email_sent: emailSent });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
