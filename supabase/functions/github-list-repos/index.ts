// github-list-repos
// Returns the GitHub repositories accessible with the user's stored PAT.
// Body: { workspace_id, project_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { listUserRepos } from "../_shared/github.ts";

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

    const body = await req.json().catch(() => ({}));
    const workspace_id = body.workspace_id as string | undefined;
    const project_id = body.project_id as string | undefined;
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id are required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { data: connector } = await admin
      .from("connectors")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("project_id", project_id)
      .eq("provider", "github")
      .maybeSingle();
    if (!connector) return jsonResponse({ error: "GitHub not connected" }, { status: 400 });

    const { data: cred } = await admin
      .from("encrypted_credentials")
      .select("encrypted_payload, iv")
      .eq("connector_id", connector.id)
      .maybeSingle();
    if (!cred) return jsonResponse({ error: "Missing GitHub credential" }, { status: 400 });

    const token = await decryptSecret(cred.encrypted_payload, cred.iv);
    const repos = await listUserRepos(token);

    return jsonResponse({
      repos: repos.map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        description: r.description,
        language: r.language,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
