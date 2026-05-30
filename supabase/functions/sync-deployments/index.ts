// sync-deployments — pull recent deployments from Vercel, GitHub Actions,
// Netlify, Render and Cloudflare into public.deployments. Auth = workspace
// member; uses the connector credentials already stored in the vault.
//
// Body: { workspace_id, project_id, providers?: string[] }
//   providers defaults to every connector available for the project.
//
// Returns: { results: [{ provider, inserted, updated, error? }] }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

interface DeploymentRow {
  workspace_id: string;
  project_id: string;
  provider: string;
  environment: string;
  sha: string | null;
  ref: string | null;
  state: string | null;
  url: string | null;
  created_at_provider: string | null;
  metadata: Record<string, unknown>;
}

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
    const { workspace_id, project_id, providers } = body as {
      workspace_id?: string;
      project_id?: string;
      providers?: string[];
    };
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id, project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", u.user.id)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    /* Resolve providers. */
    const SUPPORTED = ["vercel", "github", "netlify", "render", "cloudflare"];
    let toSync = (providers ?? []).filter((p) => SUPPORTED.includes(p));
    if (toSync.length === 0) {
      const { data: cs } = await admin
        .from("connectors")
        .select("provider")
        .eq("project_id", project_id)
        .in("provider", SUPPORTED);
      toSync = (cs ?? []).map((c) => c.provider);
    }
    if (toSync.length === 0) {
      return jsonResponse({ error: "No deployment providers connected for this project" }, { status: 400 });
    }

    const results: Array<{ provider: string; inserted: number; updated: number; error?: string }> = [];

    for (const provider of toSync) {
      try {
        const rows = await fetchDeployments(workspace_id, project_id, provider);
        if (rows.length === 0) {
          results.push({ provider, inserted: 0, updated: 0 });
          continue;
        }
        const { data, error } = await admin
          .from("deployments")
          .upsert(rows, { onConflict: "project_id,provider,sha,environment" })
          .select("id");
        if (error) {
          results.push({ provider, inserted: 0, updated: 0, error: error.message });
        } else {
          results.push({ provider, inserted: data?.length ?? rows.length, updated: 0 });
        }
      } catch (e) {
        results.push({
          provider,
          inserted: 0,
          updated: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: u.user.id,
      event_type: "deployments.synced",
      title: `Synced deployments from ${toSync.length} provider(s)`,
      payload: { results },
    });

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});

/* -------------------------------------------------------------------- */
/*  Per-provider fetchers                                               */
/* -------------------------------------------------------------------- */

async function fetchDeployments(
  workspaceId: string,
  projectId: string,
  provider: string,
): Promise<DeploymentRow[]> {
  switch (provider) {
    case "vercel": return await fetchVercel(workspaceId, projectId);
    case "github": return await fetchGithub(workspaceId, projectId);
    case "netlify": return await fetchNetlify(workspaceId, projectId);
    case "render": return await fetchRender(workspaceId, projectId);
    case "cloudflare": return await fetchCloudflare(workspaceId, projectId);
    default: return [];
  }
}

async function fetchVercel(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "vercel");
  const token = payload.token;
  const teamId = payload.team_id;
  if (!token) return [];
  const vercelProjectId = (connector.metadata?.["vercel_project_id"] as string | undefined) ?? undefined;
  const teamQ = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
  const projectQ = vercelProjectId ? `&projectId=${encodeURIComponent(vercelProjectId)}` : "";
  const url = `https://api.vercel.com/v6/deployments?limit=50${teamQ}${projectQ}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Vercel ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const list = (json.deployments ?? []) as Array<{
    uid?: string;
    name?: string;
    url?: string;
    state?: string;
    target?: string;
    created?: number;
    meta?: { githubCommitSha?: string; githubCommitRef?: string };
  }>;
  return list.map((d) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "vercel",
    environment: d.target ?? "production",
    sha: d.meta?.githubCommitSha ?? d.uid ?? null,
    ref: d.meta?.githubCommitRef ?? null,
    state: (d.state ?? "").toLowerCase(),
    url: d.url ? `https://${d.url}` : null,
    created_at_provider: d.created ? new Date(d.created).toISOString() : null,
    metadata: { name: d.name, uid: d.uid },
  }));
}

async function fetchGithub(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { payload } = await getConnectorCredential(workspaceId, projectId, "github");
  const token = payload.token;
  if (!token) return [];
  // Pull recent workflow runs from every tracked repository for this project.
  const admin = createServiceClient();
  const { data: repos } = await admin
    .from("repositories")
    .select("full_name, default_branch")
    .eq("project_id", projectId);
  if (!repos || repos.length === 0) return [];
  const all: DeploymentRow[] = [];
  for (const repo of repos.slice(0, 5)) {
    const res = await fetch(
      `https://api.github.com/repos/${repo.full_name}/actions/runs?per_page=30`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) continue;
    const json = await res.json();
    const runs = (json.workflow_runs ?? []) as Array<{
      id: number;
      name?: string;
      head_sha?: string;
      head_branch?: string;
      status?: string;
      conclusion?: string | null;
      html_url?: string;
      created_at?: string;
    }>;
    runs.forEach((r) => {
      all.push({
        workspace_id: workspaceId,
        project_id: projectId,
        provider: "github",
        environment: r.head_branch === repo.default_branch ? "production" : "preview",
        sha: r.head_sha ?? String(r.id),
        ref: r.head_branch ?? null,
        state: (r.conclusion ?? r.status ?? "").toLowerCase(),
        url: r.html_url ?? null,
        created_at_provider: r.created_at ?? null,
        metadata: { workflow: r.name, repository: repo.full_name },
      });
    });
  }
  return all;
}

async function fetchNetlify(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "netlify");
  const token = payload.api_key ?? payload.token;
  if (!token) return [];
  const siteId = connector.metadata?.["site_id"] as string | undefined;
  const endpoint = siteId
    ? `https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=30`
    : `https://api.netlify.com/api/v1/deploys?per_page=30`;
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Netlify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const list = (await res.json()) as Array<{
    id: string;
    name?: string;
    site_id?: string;
    branch?: string;
    commit_ref?: string;
    state?: string;
    context?: string;
    deploy_ssl_url?: string;
    deploy_url?: string;
    created_at?: string;
  }>;
  return list.map((d) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "netlify",
    environment: d.context ?? "production",
    sha: d.commit_ref ?? d.id,
    ref: d.branch ?? null,
    state: (d.state ?? "").toLowerCase(),
    url: d.deploy_ssl_url ?? d.deploy_url ?? null,
    created_at_provider: d.created_at ?? null,
    metadata: { id: d.id, site_id: d.site_id, name: d.name },
  }));
}

async function fetchRender(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "render");
  const token = payload.api_key;
  if (!token) return [];
  const serviceId = connector.metadata?.["render_service_id"] as string | undefined;
  if (!serviceId) return [];
  const res = await fetch(
    `https://api.render.com/v1/services/${serviceId}/deploys?limit=30`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Render ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as Array<{
    deploy: {
      id: string;
      commit?: { id?: string; message?: string };
      status?: string;
      createdAt?: string;
    };
  }>;
  return json.map((row) => {
    const d = row.deploy;
    return {
      workspace_id: workspaceId,
      project_id: projectId,
      provider: "render",
      environment: "production",
      sha: d.commit?.id ?? d.id,
      ref: null,
      state: (d.status ?? "").toLowerCase(),
      url: null,
      created_at_provider: d.createdAt ?? null,
      metadata: { id: d.id, commit_message: d.commit?.message },
    };
  });
}

async function fetchCloudflare(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "cloudflare");
  const token = payload.api_key;
  const accountId = connector.metadata?.["account_id"] as string | undefined;
  const pagesProject = connector.metadata?.["pages_project"] as string | undefined;
  if (!token || !accountId || !pagesProject) return [];
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${pagesProject}/deployments?per_page=30`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const list = (json.result ?? []) as Array<{
    id: string;
    environment?: string;
    url?: string;
    created_on?: string;
    latest_stage?: { name?: string; status?: string };
    deployment_trigger?: { metadata?: { commit_hash?: string; branch?: string } };
  }>;
  return list.map((d) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "cloudflare",
    environment: d.environment ?? "production",
    sha: d.deployment_trigger?.metadata?.commit_hash ?? d.id,
    ref: d.deployment_trigger?.metadata?.branch ?? null,
    state: (d.latest_stage?.status ?? "").toLowerCase(),
    url: d.url ?? null,
    created_at_provider: d.created_on ?? null,
    metadata: { id: d.id, stage: d.latest_stage?.name },
  }));
}
