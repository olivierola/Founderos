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

function inviteEmail(workspaceName: string, role: string, link: string) {
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
      <h1 style="font-size:20px;margin:0 0 8px">Vous êtes invité à rejoindre ${workspaceName}</h1>
      <p style="color:#555;font-size:14px;line-height:1.5;margin:0 0 24px">
        En tant que <b>${role}</b>. Le lien expire dans 14 jours et ne fonctionne qu'avec cette adresse e-mail.
      </p>
      <a href="${link}" style="display:inline-block;background:#F86134;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
        Accepter l'invitation
      </a>
      <p style="color:#888;font-size:12px;margin:24px 0 0;word-break:break-all">${link}</p>
    </div>`;
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

    // Email delivery is opportunistic: it needs a Resend credential on the
    // workspace. Without one the invitation is still perfectly valid — the
    // caller shows the link so it can be shared by hand.
    const link = `${Deno.env.get("APP_URL") ?? new URL(req.url).origin.replace(/\.supabase\.co$/, "")}/accept-invite?token=${token}`;
    let emailSent = false;
    try {
      const { payload } = await getConnectorCredential(workspace_id, workspace_id, "resend").catch(() => ({ payload: { api_key: "" } } as { payload: { api_key: string } }));
      if (payload.api_key) {
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspace_id).maybeSingle();
        emailSent = await sendResendEmail(
          payload.api_key,
          email,
          `Invitation à rejoindre ${ws?.name ?? "une organisation"} sur FounderOS`,
          inviteEmail(ws?.name ?? "l'organisation", role ?? "member", link),
        );
      }
    } catch {
      /* email is best-effort — the invitation row is what matters */
    }

    return jsonResponse({ ok: true, invitation: inv, invite_url: link, email_sent: emailSent });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
