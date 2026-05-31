// project-invite-member — invite someone to a project with a specific role.
// Body: { workspace_id, project_id, email, role_id }
// Requires `settings.team.manage` on the project.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

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

    // Resolve display data for the email body.
    const { data: workspace } = await admin
      .from("workspaces")
      .select("name, slug")
      .eq("id", workspace_id)
      .maybeSingle();
    const { data: project } = await admin
      .from("projects")
      .select("name, slug")
      .eq("id", project_id)
      .maybeSingle();

    // Try to send the invitation email via Resend.
    const emailResult = await sendInvitationEmail({
      workspaceId: workspace_id,
      projectId: project_id,
      to: email.toLowerCase(),
      token: invite.token,
      roleName: role.slug,
      workspaceName: workspace?.name ?? "your workspace",
      projectName: project?.name ?? "the project",
      inviterEmail: u.user.email ?? "",
    });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: u.user.id,
      event_type: "project.member_invited",
      title: `Invited ${email} as ${role.slug}`,
      payload: { email, role_id, email_sent: emailResult.ok },
    });

    return jsonResponse({
      ok: true,
      kind: "invited",
      token: invite.token,
      email_sent: emailResult.ok,
      email_error: emailResult.ok ? null : emailResult.error,
      from: emailResult.from,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});

interface SendInvitationInput {
  workspaceId: string;
  projectId: string;
  to: string;
  token: string;
  roleName: string;
  workspaceName: string;
  projectName: string;
  inviterEmail: string;
}

interface SendResult {
  ok: boolean;
  from?: string;
  error?: string;
}

/* Sends the invitation email via Resend.
 * - Uses the project's connected Resend connector if the client configured a
 *   `from_email` in its metadata.
 * - Otherwise falls back to the FounderOS system address.
 * - The Resend API key always comes from the RESEND_API_KEY edge secret. */
async function sendInvitationEmail(input: SendInvitationInput): Promise<SendResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY is not configured on the server" };
  }

  // Resolve the From address.
  const defaultFrom = "FounderOS <noreply@founderos.dev>";
  let from = defaultFrom;
  try {
    const { connector } = await getConnectorCredential(
      input.workspaceId,
      input.projectId,
      "resend",
    );
    const fromEmail = (connector.metadata?.["from_email"] as string | undefined)?.trim();
    if (fromEmail) {
      const displayName = (connector.metadata?.["from_name"] as string | undefined)?.trim();
      from = displayName ? `${displayName} <${fromEmail}>` : fromEmail;
    }
  } catch {
    // No Resend connector — keep the default From.
  }

  const appOrigin = Deno.env.get("APP_ORIGIN") ?? "https://founderos-peach.vercel.app";
  const acceptUrl = `${appOrigin}/accept-invite?token=${input.token}`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#e4e4e7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0c;padding:48px 0">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px">
        <tr><td>
          <div style="font-size:18px;font-weight:600;color:#fafafa">You've been invited.</div>
          <p style="font-size:14px;line-height:1.55;color:#a1a1aa;margin:16px 0">
            <strong style="color:#fafafa">${escapeHtml(input.inviterEmail)}</strong>
            invited you to join the project
            <strong style="color:#fafafa">${escapeHtml(input.projectName)}</strong>
            in <strong style="color:#fafafa">${escapeHtml(input.workspaceName)}</strong>
            as <strong style="color:#fafafa">${escapeHtml(input.roleName)}</strong>.
          </p>
          <p style="margin:24px 0">
            <a href="${acceptUrl}" style="display:inline-block;background:#001BB7;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500">
              Accept invitation
            </a>
          </p>
          <p style="font-size:12px;color:#71717a;margin-top:24px">
            Or paste this link in your browser:<br/>
            <span style="word-break:break-all;color:#a1a1aa">${acceptUrl}</span>
          </p>
          <hr style="border:none;border-top:1px solid #27272a;margin:32px 0"/>
          <p style="font-size:11px;color:#52525b;margin:0">
            This invitation expires in 14 days. If you weren't expecting it you can safely ignore this email.
          </p>
        </td></tr>
      </table>
      <p style="font-size:11px;color:#52525b;margin-top:16px">Sent by FounderOS · founderos.dev</p>
    </td></tr>
  </table>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.to,
      subject: `You've been invited to ${input.projectName}`,
      html,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, from, error: `Resend ${res.status}: ${detail}` };
  }
  return { ok: true, from };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
