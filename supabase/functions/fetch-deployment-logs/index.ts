// fetch-deployment-logs — retrieve build/runtime logs for a deployment row.
// Body: { deployment_id }
// Returns: { logs: string }

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

    const { deployment_id } = await req.json();
    if (!deployment_id) return jsonResponse({ error: "deployment_id required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: deployment } = await admin
      .from("deployments")
      .select("*")
      .eq("id", deployment_id)
      .maybeSingle();
    if (!deployment) return jsonResponse({ error: "Deployment not found" }, { status: 404 });

    // Membership check.
    const { data: mem } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", deployment.workspace_id)
      .eq("user_id", u.user.id)
      .maybeSingle();
    if (!mem) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const md = (deployment.metadata ?? {}) as Record<string, any>;
    let logs = "";

    switch (deployment.provider) {
      case "vercel": {
        const { payload } = await getConnectorCredential(
          deployment.workspace_id,
          deployment.project_id,
          "vercel",
        );
        const token = payload.token;
        const teamId = payload.team_id;
        const uid = md.uid as string | undefined;
        if (!uid || !token) {
          logs = "";
          break;
        }
        const teamQ = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
        const res = await fetch(
          `https://api.vercel.com/v3/deployments/${uid}/events${teamQ}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) {
          logs = `Vercel API ${res.status}: ${(await res.text()).slice(0, 500)}`;
          break;
        }
        const events = (await res.json()) as Array<{
          type?: string;
          created?: number;
          payload?: { text?: string };
          text?: string;
        }>;
        logs = events
          .map((e) => {
            const ts = e.created ? new Date(e.created).toISOString().slice(11, 19) : "";
            const txt = e.payload?.text ?? e.text ?? "";
            return `${ts}  ${txt}`;
          })
          .filter((l) => l.trim() !== "")
          .join("\n");
        break;
      }
      case "github": {
        const { payload } = await getConnectorCredential(
          deployment.workspace_id,
          deployment.project_id,
          "github",
        );
        const token = payload.token;
        const repo = md.repository as string | undefined;
        if (!token || !repo || !deployment.sha) {
          logs = "";
          break;
        }
        // Resolve the workflow run from the sha. GitHub doesn't expose logs
        // directly by sha so we list runs and pick the matching one.
        const runsRes = await fetch(
          `https://api.github.com/repos/${repo}/actions/runs?head_sha=${deployment.sha}&per_page=1`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
        );
        if (!runsRes.ok) {
          logs = `GitHub API ${runsRes.status}: ${(await runsRes.text()).slice(0, 200)}`;
          break;
        }
        const runsJson = await runsRes.json();
        const runId = runsJson.workflow_runs?.[0]?.id;
        if (!runId) {
          logs = "No workflow run found for this commit.";
          break;
        }
        // Download logs ZIP — we only return a hint because parsing ZIP server-side
        // is non-trivial and GitHub redirects to a signed URL.
        logs = `GitHub Actions doesn't expose plain-text logs over the API.\nOpen the workflow run directly to inspect:\nhttps://github.com/${repo}/actions/runs/${runId}`;
        break;
      }
      case "netlify": {
        const { payload } = await getConnectorCredential(
          deployment.workspace_id,
          deployment.project_id,
          "netlify",
        );
        const token = payload.api_key ?? payload.token;
        const deployId = md.id as string | undefined;
        if (!token || !deployId) {
          logs = "";
          break;
        }
        const res = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}/log`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          logs = `Netlify API ${res.status}: ${(await res.text()).slice(0, 200)}`;
          break;
        }
        logs = await res.text();
        break;
      }
      case "render": {
        const { payload } = await getConnectorCredential(
          deployment.workspace_id,
          deployment.project_id,
          "render",
        );
        const token = payload.api_key;
        const deployId = md.id as string | undefined;
        const serviceId = (await getConnectorCredential(
          deployment.workspace_id,
          deployment.project_id,
          "render",
        )).connector.metadata?.["render_service_id"] as string | undefined;
        if (!token || !deployId || !serviceId) {
          logs = "Render service ID missing from connector metadata.";
          break;
        }
        const res = await fetch(
          `https://api.render.com/v1/services/${serviceId}/deploys/${deployId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) {
          logs = `Render API ${res.status}: ${(await res.text()).slice(0, 200)}`;
          break;
        }
        logs = "Render logs are streamed only from the dashboard. Open the deployment to inspect.";
        break;
      }
      case "cloudflare": {
        logs = "Cloudflare Pages logs are not exposed via the REST API. Open the deployment in the dashboard.";
        break;
      }
      default:
        logs = "Log retrieval is not implemented for this provider yet.";
    }

    return jsonResponse({ logs });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
