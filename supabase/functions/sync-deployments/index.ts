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
  kind?: "deploy" | "release" | "infra_event";
  sha: string | null;
  ref: string | null;
  state: string | null;
  url: string | null;
  duration_ms?: number | null;
  author?: string | null;
  commit_message?: string | null;
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
    const SUPPORTED = [
      "vercel",
      "github",
      "netlify",
      "render",
      "cloudflare",
      "supabase",
      "firebase",
      "fly",
      "heroku",
      "railway",
      "digitalocean",
      "hetzner",
    ];
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
        // Deduplicate on the unique key to avoid PostgreSQL's
        // "ON CONFLICT DO UPDATE command cannot affect row a second time"
        // when the source API returns multiple rows for the same sha/env.
        const seen = new Set<string>();
        const dedup = rows.filter((r) => {
          const k = `${r.project_id}|${r.provider}|${r.sha ?? ""}|${r.environment}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const { data, error } = await admin
          .from("deployments")
          .upsert(dedup, { onConflict: "project_id,provider,sha,environment" })
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
    case "supabase": return await fetchSupabase(workspaceId, projectId);
    case "firebase": return await fetchFirebase(workspaceId, projectId);
    case "fly": return await fetchFly(workspaceId, projectId);
    case "heroku": return await fetchHeroku(workspaceId, projectId);
    case "railway": return await fetchRailway(workspaceId, projectId);
    case "digitalocean": return await fetchDigitalOcean(workspaceId, projectId);
    case "hetzner": return await fetchHetzner(workspaceId, projectId);
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
    buildingAt?: number;
    ready?: number;
    inspectorUrl?: string;
    aliasAssigned?: number;
    aliasError?: { message?: string };
    creator?: { username?: string; email?: string };
    meta?: {
      githubCommitSha?: string;
      githubCommitRef?: string;
      githubCommitMessage?: string;
      githubCommitAuthorName?: string;
      githubRepo?: string;
      githubOrg?: string;
    };
  }>;
  return list.map((d) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "vercel",
    kind: "deploy",
    environment: d.target ?? "production",
    sha: d.meta?.githubCommitSha ?? d.uid ?? null,
    ref: d.meta?.githubCommitRef ?? null,
    state: (d.state ?? "").toLowerCase(),
    url: d.url ? `https://${d.url}` : null,
    duration_ms: d.ready && d.buildingAt ? d.ready - d.buildingAt : null,
    author: d.creator?.username ?? d.creator?.email ?? d.meta?.githubCommitAuthorName ?? null,
    commit_message: d.meta?.githubCommitMessage ?? null,
    created_at_provider: d.created ? new Date(d.created).toISOString() : null,
    metadata: {
      name: d.name,
      uid: d.uid,
      inspector_url: d.inspectorUrl,
      ready_at: d.ready ? new Date(d.ready).toISOString() : null,
      repository:
        d.meta?.githubOrg && d.meta?.githubRepo ? `${d.meta.githubOrg}/${d.meta.githubRepo}` : null,
    },
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
    kind: "deploy",
    environment: d.environment ?? "production",
    sha: d.deployment_trigger?.metadata?.commit_hash ?? d.id,
    ref: d.deployment_trigger?.metadata?.branch ?? null,
    state: (d.latest_stage?.status ?? "").toLowerCase(),
    url: d.url ?? null,
    created_at_provider: d.created_on ?? null,
    metadata: { id: d.id, stage: d.latest_stage?.name },
  }));
}

/* -------------------------------------------------------------------- */
/*  Supabase Edge Functions — every function with its current version    */
/* -------------------------------------------------------------------- */

async function fetchSupabase(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { payload } = await getConnectorCredential(workspaceId, projectId, "supabase");
  const token = payload.access_token;
  const projectUrl = payload.project_url;
  if (!token || !projectUrl) return [];
  const ref = new URL(projectUrl).hostname.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const functions = (await res.json()) as Array<{
    id: string;
    slug: string;
    name: string;
    status?: string;
    version?: number;
    created_at?: number;
    updated_at?: number;
  }>;
  return functions.map((f) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "supabase",
    kind: "deploy",
    environment: "production",
    // Use slug + version as a stable de-dup key.
    sha: `${f.slug}@v${f.version ?? 1}`,
    ref: f.slug,
    state: (f.status ?? "active").toLowerCase(),
    url: `https://${ref}.supabase.co/functions/v1/${f.slug}`,
    author: null,
    commit_message: null,
    duration_ms: null,
    created_at_provider: f.updated_at
      ? new Date(f.updated_at).toISOString()
      : f.created_at
        ? new Date(f.created_at).toISOString()
        : null,
    metadata: { function_id: f.id, name: f.name, version: f.version, project_ref: ref },
  }));
}

/* -------------------------------------------------------------------- */
/*  Firebase Hosting releases                                            */
/* -------------------------------------------------------------------- */

async function fetchFirebase(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "firebase");
  const token = payload.access_token ?? payload.api_key;
  const site = (connector.metadata?.["firebase_site"] as string | undefined)
    ?? (payload.site as string | undefined);
  if (!token || !site) return [];
  const res = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/sites/${site}/releases?pageSize=30`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Firebase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const releases = (json.releases ?? []) as Array<{
    name?: string;
    version?: { name?: string; status?: string };
    type?: string;
    releaseTime?: string;
    releaseUser?: { email?: string };
    message?: string;
  }>;
  return releases.map((r) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "firebase",
    kind: "release",
    environment: "production",
    sha: r.name ?? r.version?.name ?? null,
    ref: r.type ?? null,
    state: (r.version?.status ?? "ready").toLowerCase(),
    url: `https://${site}.web.app`,
    author: r.releaseUser?.email ?? null,
    commit_message: r.message ?? null,
    duration_ms: null,
    created_at_provider: r.releaseTime ?? null,
    metadata: { site, version: r.version?.name },
  }));
}

/* -------------------------------------------------------------------- */
/*  Fly.io — releases per app                                            */
/* -------------------------------------------------------------------- */

async function fetchFly(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "fly");
  const token = payload.api_key ?? payload.token;
  const appName = connector.metadata?.["fly_app"] as string | undefined;
  if (!token || !appName) return [];
  const query = `query App($name: String!) {
    app(name: $name) {
      name
      releases(first: 30) {
        nodes {
          id version status reason description user { email } createdAt
        }
      }
    }
  }`;
  const res = await fetch("https://api.fly.io/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { name: appName } }),
  });
  if (!res.ok) throw new Error(`Fly ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const releases = (json?.data?.app?.releases?.nodes ?? []) as Array<{
    id: string;
    version: number;
    status?: string;
    reason?: string;
    description?: string;
    user?: { email?: string };
    createdAt?: string;
  }>;
  return releases.map((r) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "fly",
    kind: "release",
    environment: "production",
    sha: `${appName}@v${r.version}`,
    ref: r.reason ?? null,
    state: (r.status ?? "").toLowerCase(),
    url: `https://${appName}.fly.dev`,
    author: r.user?.email ?? null,
    commit_message: r.description ?? null,
    duration_ms: null,
    created_at_provider: r.createdAt ?? null,
    metadata: { release_id: r.id, version: r.version, app: appName },
  }));
}

/* -------------------------------------------------------------------- */
/*  Heroku — releases per app                                            */
/* -------------------------------------------------------------------- */

async function fetchHeroku(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "heroku");
  const token = payload.api_key ?? payload.token;
  const appName = connector.metadata?.["heroku_app"] as string | undefined;
  if (!token || !appName) return [];
  const res = await fetch(`https://api.heroku.com/apps/${appName}/releases`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.heroku+json; version=3",
      Range: "version ..; max=30, order=desc",
    },
  });
  if (!res.ok) throw new Error(`Heroku ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const list = (await res.json()) as Array<{
    id: string;
    version: number;
    description?: string;
    status?: string;
    user?: { email?: string };
    created_at?: string;
  }>;
  return list.map((r) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "heroku",
    kind: "release",
    environment: "production",
    sha: `${appName}@v${r.version}`,
    ref: null,
    state: (r.status ?? "").toLowerCase(),
    url: `https://${appName}.herokuapp.com`,
    author: r.user?.email ?? null,
    commit_message: r.description ?? null,
    duration_ms: null,
    created_at_provider: r.created_at ?? null,
    metadata: { release_id: r.id, version: r.version, app: appName },
  }));
}

/* -------------------------------------------------------------------- */
/*  Railway — deployments per service/environment                        */
/* -------------------------------------------------------------------- */

async function fetchRailway(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "railway");
  const token = payload.api_key ?? payload.token;
  const railwayProjectId = connector.metadata?.["railway_project_id"] as string | undefined;
  const environmentId = connector.metadata?.["railway_environment_id"] as string | undefined;
  if (!token || !railwayProjectId) return [];
  const query = `query Deployments($projectId: String!, $environmentId: String) {
    deployments(input: { projectId: $projectId, environmentId: $environmentId }, first: 30) {
      edges { node {
        id status createdAt updatedAt
        meta
        staticUrl
      } }
    }
  }`;
  const res = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { projectId: railwayProjectId, environmentId },
    }),
  });
  if (!res.ok) throw new Error(`Railway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 200));
  const edges = (json?.data?.deployments?.edges ?? []) as Array<{
    node: {
      id: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      meta?: Record<string, any>;
      staticUrl?: string;
    };
  }>;
  return edges.map(({ node: r }) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "railway",
    kind: "deploy",
    environment: "production",
    sha: r.meta?.commitHash ?? r.id,
    ref: r.meta?.branch ?? null,
    state: (r.status ?? "").toLowerCase(),
    url: r.staticUrl ? `https://${r.staticUrl}` : null,
    author: r.meta?.commitAuthor ?? null,
    commit_message: r.meta?.commitMessage ?? null,
    duration_ms: null,
    created_at_provider: r.createdAt ?? null,
    metadata: { id: r.id, project: railwayProjectId, environment: environmentId },
  }));
}

/* -------------------------------------------------------------------- */
/*  DigitalOcean — droplet actions = infra events                        */
/* -------------------------------------------------------------------- */

async function fetchDigitalOcean(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "digitalocean");
  const token = payload.api_key ?? payload.token;
  const dropletId = connector.metadata?.["droplet_id"] as string | undefined;
  if (!token) return [];
  const url = dropletId
    ? `https://api.digitalocean.com/v2/droplets/${dropletId}/actions?per_page=30`
    : `https://api.digitalocean.com/v2/actions?per_page=30`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`DigitalOcean ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const actions = (json.actions ?? []) as Array<{
    id: number;
    type?: string;
    status?: string;
    started_at?: string;
    completed_at?: string;
    resource_id?: number;
    resource_type?: string;
    region?: { slug?: string };
  }>;
  return actions.map((a) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "digitalocean",
    kind: "infra_event",
    environment: "production",
    sha: `do-${a.id}`,
    ref: a.type ?? null,
    state: (a.status ?? "").toLowerCase(),
    url: null,
    author: null,
    commit_message: null,
    duration_ms:
      a.started_at && a.completed_at
        ? new Date(a.completed_at).getTime() - new Date(a.started_at).getTime()
        : null,
    created_at_provider: a.started_at ?? null,
    metadata: { action_id: a.id, resource_id: a.resource_id, resource_type: a.resource_type, region: a.region?.slug },
  }));
}

/* -------------------------------------------------------------------- */
/*  Hetzner Cloud — server actions = infra events                        */
/* -------------------------------------------------------------------- */

async function fetchHetzner(workspaceId: string, projectId: string): Promise<DeploymentRow[]> {
  const { connector, payload } = await getConnectorCredential(workspaceId, projectId, "hetzner");
  const token = payload.api_key ?? payload.token;
  const serverId = connector.metadata?.["hetzner_server_id"] as string | undefined;
  if (!token) return [];
  const url = serverId
    ? `https://api.hetzner.cloud/v1/servers/${serverId}/actions?per_page=30`
    : `https://api.hetzner.cloud/v1/actions?per_page=30`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Hetzner ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const actions = (json.actions ?? []) as Array<{
    id: number;
    command?: string;
    status?: string;
    started?: string;
    finished?: string;
    resources?: Array<{ id: number; type: string }>;
    error?: { message?: string };
  }>;
  return actions.map((a) => ({
    workspace_id: workspaceId,
    project_id: projectId,
    provider: "hetzner",
    kind: "infra_event",
    environment: "production",
    sha: `hetzner-${a.id}`,
    ref: a.command ?? null,
    state: (a.status ?? "").toLowerCase(),
    url: null,
    author: null,
    commit_message: a.error?.message ?? null,
    duration_ms:
      a.started && a.finished
        ? new Date(a.finished).getTime() - new Date(a.started).getTime()
        : null,
    created_at_provider: a.started ?? null,
    metadata: { action_id: a.id, resources: a.resources },
  }));
}
