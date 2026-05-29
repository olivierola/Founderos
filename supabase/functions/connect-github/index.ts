// connect-github
// Stores a user's GitHub Personal Access Token (PAT) encrypted in encrypted_credentials.
// Body: { workspace_id, project_id, token }
// Validates the PAT against /user, then upserts a connector + encrypted credentials.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { encryptSecret } from "../_shared/crypto.ts";

interface ConnectBody {
  workspace_id: string;
  project_id: string;
  token: string;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = (await req.json()) as Partial<ConnectBody>;
    if (!body.workspace_id || !body.project_id || !body.token) {
      return jsonResponse({ error: "workspace_id, project_id and token are required" }, { status: 400 });
    }

    // Membership check (service client to bypass RLS read on workspace_members for own row)
    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", body.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized for this workspace" }, { status: 403 });
    }

    // Validate the PAT against GitHub
    const ghRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${body.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "FounderOS-Scanner",
      },
    });
    if (!ghRes.ok) {
      return jsonResponse({ error: "Invalid GitHub token" }, { status: 400 });
    }
    const ghUser = (await ghRes.json()) as { login: string; id: number };

    // Upsert connector
    const { data: connector, error: connErr } = await admin
      .from("connectors")
      .upsert(
        {
          workspace_id: body.workspace_id,
          project_id: body.project_id,
          provider: "github",
          status: "connected",
          permissions: "read_only",
          metadata: { github_login: ghUser.login, github_user_id: ghUser.id },
        },
        { onConflict: "workspace_id,project_id,provider" },
      )
      .select()
      .single();
    if (connErr || !connector) {
      return jsonResponse({ error: "Could not save connector", detail: connErr?.message }, { status: 500 });
    }

    // Encrypt + store the token
    const { ciphertext, iv } = await encryptSecret(body.token);
    // Remove any previous credential rows for this connector
    await admin.from("encrypted_credentials").delete().eq("connector_id", connector.id);
    const { error: credErr } = await admin.from("encrypted_credentials").insert({
      workspace_id: body.workspace_id,
      connector_id: connector.id,
      encrypted_payload: ciphertext,
      iv,
      key_version: "v1",
    });
    if (credErr) {
      return jsonResponse({ error: "Could not save credential", detail: credErr.message }, { status: 500 });
    }

    await admin.from("activity_logs").insert({
      workspace_id: body.workspace_id,
      project_id: body.project_id,
      actor_user_id: userId,
      event_type: "connector.connected",
      title: `GitHub connected as ${ghUser.login}`,
      payload: { provider: "github", github_login: ghUser.login },
    });

    return jsonResponse({ ok: true, connector_id: connector.id, github_login: ghUser.login });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
