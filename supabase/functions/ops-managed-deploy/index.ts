// ops-managed-deploy — trigger a deployment on a managed PaaS using a
// configured Connector. Creates an Ops Job for tracking + a row in the
// existing `deployments` table marked source = 'founderos_ops'.
//
// Body:
//   { server_id, action: "deploy" | "redeploy" | "rollback", input?: {...} }
//
// where server_id points to an ops_servers row with target_kind = 'managed'.
//
// Per-provider behaviour:
//   - vercel    : POST /v13/deployments (create) or /v6/deployments/:id (read)
//                 Redeploy = POST /v13/deployments?forceNew=1 with same gitSource
//                 Rollback = PATCH alias (not implemented in v1)
//   - netlify   : POST /api/v1/sites/:siteId/builds
//   - fly       : POST /v1/apps/:app/releases (placeholder)
//   - railway   : GraphQL mutation (placeholder)
//
// On success we record a public.deployments row + an ops_jobs row, both
// linked, so the Ops Overview can show the unified deployment timeline.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

interface ServerRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  target_kind: "server" | "managed";
  connector_id: string | null;
  managed_provider: string | null;
  metadata: Record<string, unknown>;
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { server_id, action, input } = await req.json();
    if (!server_id || !action) {
      return jsonResponse({ ok: false, message: "server_id and action are required" }, { status: 400 });
    }

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();
    const { data: server } = await admin
      .from("ops_servers")
      .select("id, workspace_id, project_id, name, target_kind, connector_id, managed_provider, metadata")
      .eq("id", server_id)
      .maybeSingle();
    if (!server) return jsonResponse({ ok: false, message: "Target not found" }, { status: 404 });
    const s = server as ServerRow;
    if (s.target_kind !== "managed") {
      return jsonResponse({ ok: false, message: "Target is not a managed PaaS" }, { status: 400 });
    }
    if (!s.managed_provider) {
      return jsonResponse({ ok: false, message: "Managed provider missing" }, { status: 400 });
    }

    // Create the tracking job up front.
    const jobType = ({
      deploy:   "managed_deploy",
      redeploy: "managed_redeploy",
      rollback: "managed_rollback",
    } as Record<string, string>)[action];
    if (!jobType) return jsonResponse({ ok: false, message: `Unknown action ${action}` }, { status: 400 });

    const { data: job } = await admin
      .from("ops_jobs")
      .insert({
        workspace_id: s.workspace_id,
        project_id: s.project_id,
        server_id: s.id,
        job_type: jobType,
        autonomy_mode: "assisted",
        risk_level: action === "rollback" ? "high" : "medium",
        status: "running",
        requires_approval: false,
        input: input ?? {},
        created_by: userId,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const jobId = job!.id as string;

    async function log(level: string, step: string, message: string) {
      await admin.from("ops_job_logs").insert({
        job_id: jobId, level, step, message,
      });
    }

    async function completeJob(status: "succeeded" | "failed", result: Record<string, unknown>, error?: string) {
      await admin.from("ops_jobs").update({
        status,
        result,
        error_message: error ?? null,
        finished_at: new Date().toISOString(),
      }).eq("id", jobId);
    }

    try {
      await log("info", "lifecycle", `Triggering ${action} on ${s.managed_provider}`);

      const cred = await getConnectorCredential(s.workspace_id, s.project_id, s.managed_provider);
      const meta = (s.metadata ?? {}) as Record<string, any>;

      let deploymentInfo: { provider_deployment_id?: string; url?: string; state?: string };
      switch (s.managed_provider) {
        case "vercel":
          deploymentInfo = await triggerVercel(cred.payload, cred.connector.metadata ?? {}, meta, input ?? {}, log);
          break;
        case "netlify":
          deploymentInfo = await triggerNetlify(cred.payload, cred.connector.metadata ?? {}, meta, log);
          break;
        case "fly":
          deploymentInfo = await triggerFly(cred.payload, meta, log);
          break;
        case "railway":
          deploymentInfo = await triggerRailway(cred.payload, meta, log);
          break;
        case "render":
          deploymentInfo = await triggerRender(cred.payload, cred.connector.metadata ?? {}, meta, log);
          break;
        default:
          throw new Error(`No managed-deploy implementation for provider '${s.managed_provider}'`);
      }

      // Record in public.deployments so it shows up in the deployment hub.
      await admin.from("deployments").insert({
        workspace_id: s.workspace_id,
        project_id: s.project_id,
        provider: s.managed_provider,
        environment: input?.environment ?? "production",
        sha: input?.sha ?? null,
        ref: input?.ref ?? null,
        state: deploymentInfo.state ?? "queued",
        url: deploymentInfo.url ?? null,
        metadata: { ...deploymentInfo, action },
        source: "founderos_ops",
        ops_job_id: jobId,
        ops_server_id: s.id,
        kind: "deploy",
      });

      await log("info", "lifecycle", `Deployment created${deploymentInfo.url ? ` → ${deploymentInfo.url}` : ""}`);
      await completeJob("succeeded", { ...deploymentInfo }, undefined);

      return jsonResponse({ ok: true, job_id: jobId, ...deploymentInfo });
    } catch (e: any) {
      await log("error", "lifecycle", e?.message ?? String(e));
      await completeJob("failed", {}, e?.message ?? "Unknown error");
      return jsonResponse({ ok: false, job_id: jobId, message: e?.message ?? "Internal error" }, { status: 500 });
    }
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});

// ---- Provider implementations ---------------------------------------------

interface DeploymentInfo {
  provider_deployment_id?: string;
  url?: string;
  state?: string;
}

async function triggerVercel(
  payload: Record<string, string>,
  connectorMeta: Record<string, any>,
  serverMeta: Record<string, any>,
  input: Record<string, any>,
  log: (level: string, step: string, message: string) => Promise<void>,
): Promise<DeploymentInfo> {
  const token = payload.token ?? payload.access_token;
  if (!token) throw new Error("Vercel connector has no token");

  const projectId = serverMeta.vercel_project_id ?? connectorMeta.vercel_project_id;
  const projectName = serverMeta.vercel_project_name ?? connectorMeta.vercel_project_name;
  if (!projectId && !projectName) {
    throw new Error("Vercel target needs vercel_project_id or vercel_project_name in metadata");
  }
  const teamQ = (serverMeta.vercel_team_id ?? connectorMeta.vercel_team_id)
    ? `?teamId=${encodeURIComponent(serverMeta.vercel_team_id ?? connectorMeta.vercel_team_id)}`
    : "";

  // Vercel deploy without files = redeploy latest production. With a gitSource
  // we can target a specific ref. Input.ref / input.sha override.
  const body: Record<string, any> = {
    name: projectName ?? "founderos-app",
    target: input.environment ?? "production",
  };
  if (projectId) body.project = projectId;
  if (input.ref || input.sha) {
    body.gitSource = {
      type: "github",                                  // assume github; v2 will detect from connector metadata
      ref: input.ref ?? input.sha,
      repoId: serverMeta.github_repo_id,
    };
  }

  await log("info", "vercel", `POST /v13/deployments (project=${projectId ?? projectName})`);
  const resp = await fetch(`https://api.vercel.com/v13/deployments${teamQ}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Vercel: ${json?.error?.message ?? resp.statusText}`);
  return {
    provider_deployment_id: json.id,
    url: json.url ? `https://${json.url}` : undefined,
    state: json.readyState ?? json.state ?? "queued",
  };
}

async function triggerNetlify(
  payload: Record<string, string>,
  connectorMeta: Record<string, any>,
  serverMeta: Record<string, any>,
  log: (level: string, step: string, message: string) => Promise<void>,
): Promise<DeploymentInfo> {
  const token = payload.token ?? payload.access_token;
  if (!token) throw new Error("Netlify connector has no token");
  const siteId = serverMeta.netlify_site_id ?? connectorMeta.netlify_site_id;
  if (!siteId) throw new Error("Netlify target needs netlify_site_id in metadata");

  await log("info", "netlify", `POST /api/v1/sites/${siteId}/builds`);
  const resp = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Netlify: ${json?.message ?? resp.statusText}`);
  return {
    provider_deployment_id: String(json.id ?? ""),
    url: json.deploy_ssl_url ?? json.deploy_url ?? undefined,
    state: json.state ?? "queued",
  };
}

async function triggerFly(
  payload: Record<string, string>,
  serverMeta: Record<string, any>,
  log: (level: string, step: string, message: string) => Promise<void>,
): Promise<DeploymentInfo> {
  // Fly deploys are normally driven by `flyctl deploy` against an image.
  // From an API we'd POST to /v1/apps/:app/releases, but the full Machines
  // API flow is non-trivial. We expose a stub so the UI can be wired today.
  void payload; void log;
  if (!serverMeta.fly_app) throw new Error("Fly target needs fly_app in metadata");
  throw new Error("Fly deploy not implemented yet — coming soon.");
}

async function triggerRailway(
  payload: Record<string, string>,
  serverMeta: Record<string, any>,
  log: (level: string, step: string, message: string) => Promise<void>,
): Promise<DeploymentInfo> {
  void payload; void serverMeta; void log;
  throw new Error("Railway deploy not implemented yet — coming soon.");
}

async function triggerRender(
  payload: Record<string, string>,
  connectorMeta: Record<string, any>,
  serverMeta: Record<string, any>,
  log: (level: string, step: string, message: string) => Promise<void>,
): Promise<DeploymentInfo> {
  const token = payload.token ?? payload.access_token;
  if (!token) throw new Error("Render connector has no token");
  const serviceId = serverMeta.render_service_id ?? connectorMeta.render_service_id;
  if (!serviceId) throw new Error("Render target needs render_service_id in metadata");

  await log("info", "render", `POST /v1/services/${serviceId}/deploys`);
  const resp = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Render: ${json?.message ?? resp.statusText}`);
  return {
    provider_deployment_id: json.id,
    url: json?.service?.serviceDetails?.url,
    state: json.status ?? "queued",
  };
}
