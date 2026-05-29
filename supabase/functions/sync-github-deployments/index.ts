// sync-github-deployments — pulls GitHub deployments for each tracked repo.
// Body: { workspace_id, project_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

interface GhDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  statuses_url: string;
}
interface GhDeploymentStatus {
  state: string;
  environment_url?: string;
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

    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) return jsonResponse({ error: "workspace_id, project_id required" }, { status: 400 });

    const admin = createServiceClient();
    const { payload } = await getConnectorCredential(workspace_id, project_id, "github");
    const token = payload.token;
    if (!token) return jsonResponse({ error: "GitHub token missing" }, { status: 400 });

    const { data: repos } = await admin
      .from("repositories")
      .select("id, full_name")
      .eq("project_id", project_id)
      .eq("provider", "github");

    let inserted = 0;
    for (const repo of repos ?? []) {
      const res = await fetch(`https://api.github.com/repos/${repo.full_name}/deployments?per_page=20`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "FounderOS-Scanner",
        },
      });
      if (!res.ok) continue;
      const list = (await res.json()) as GhDeployment[];
      for (const d of list) {
        // Fetch latest status
        let state = "unknown";
        let url: string | null = null;
        try {
          const sres = await fetch(d.statuses_url + "?per_page=1", {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "FounderOS-Scanner",
            },
          });
          if (sres.ok) {
            const arr = (await sres.json()) as GhDeploymentStatus[];
            if (arr[0]) {
              state = arr[0].state;
              url = arr[0].environment_url ?? null;
            }
          }
        } catch { /* ignore */ }

        const { error } = await admin.from("deployments").upsert(
          {
            workspace_id,
            project_id,
            provider: "github",
            environment: d.environment,
            sha: d.sha,
            ref: d.ref,
            state,
            url,
            created_at_provider: d.created_at,
            metadata: { repo: repo.full_name, external_id: d.id },
          },
          { onConflict: "project_id,provider,sha,environment" },
        );
        if (!error) inserted++;
      }
    }

    return jsonResponse({ ok: true, deployments_synced: inserted });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
