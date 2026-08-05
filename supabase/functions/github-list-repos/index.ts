// github-list-repos
// Returns the GitHub repositories accessible with the user's stored PAT.
// Body: { workspace_id, project_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { listUserRepos, type GitHubRepo } from "../_shared/github.ts";
import { resolveGithubToken, getComposioGithubAccount, listReposViaComposio } from "../_shared/github-token.ts";

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

    // Resolve a usable token (legacy PAT, or a Composio-exposed OAuth token).
    const resolved = await resolveGithubToken(admin, workspace_id, project_id);
    // Composio connection (used to proxy the listing when the token is masked).
    const composioAcct = await getComposioGithubAccount(admin, workspace_id, project_id);

    if (!resolved && !composioAcct) {
      return jsonResponse({ error: "GitHub not connected" }, { status: 400 });
    }

    let repos: GitHubRepo[] | null = null;
    let tokenErr = "";
    if (resolved) {
      try {
        repos = await listUserRepos(resolved.token);
      } catch (e) {
        // A stale legacy PAT ("Bad credentials") shouldn't block a valid
        // Composio connection — fall through to the Composio path below.
        tokenErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (!repos && composioAcct) {
      repos = await listReposViaComposio(composioAcct, project_id);
      // Self-heal: a successful live listing proves the Composio connection is
      // active, so reconcile our cached status (it may be stuck at "pending"
      // when the connect dialog closed before its poll confirmed).
      if (repos) {
        await admin.from("connectors")
          .update({ status: "connected" })
          .eq("composio_connected_account_id", composioAcct)
          .then(() => {}, () => {});
      }
    }
    if (!repos) {
      return jsonResponse(
        { error: tokenErr || "Impossible de lister les dépôts GitHub.", detail: "list_failed" },
        { status: 502 },
      );
    }

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
