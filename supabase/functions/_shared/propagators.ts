// Propagators: push (key, value) to a customer's backend secrets store.
// Each propagator receives the credential payload of the target connector
// (e.g. the Supabase access_token + project_url) plus the secret to push.

import { getConnectorCredential } from "./credentials.ts";

export type PropagationTarget =
  | "supabase"
  | "vercel"
  | "railway"
  | "render"
  | "cloudflare"
  | "aws-s3"
  | "runpod"
  | "firebase";

export interface PropagationInput {
  workspaceId: string;
  projectId: string;
  key: string;       // e.g. STRIPE_SECRET_KEY
  value: string;     // plaintext, only held in memory
  envName: string;   // name in the target (often = key)
  metadata?: Record<string, unknown>;
}

export interface PropagationResult {
  ok: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

/* -------------------------------------------------------------------- */
/*  Supabase Secrets (Edge Function secrets) via Management API         */
/* -------------------------------------------------------------------- */

async function propagateSupabase(input: PropagationInput): Promise<PropagationResult> {
  const { workspaceId, projectId, envName, value } = input;
  const { payload } = await getConnectorCredential(workspaceId, projectId, "supabase");
  const token = payload.access_token;
  const projectUrl = payload.project_url;
  if (!token || !projectUrl) {
    return { ok: false, error: "Supabase connector missing access_token or project_url" };
  }
  // Extract project_ref from URL: https://<ref>.supabase.co
  const ref = new URL(projectUrl).hostname.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ name: envName, value }]),
  });
  if (!res.ok) {
    return { ok: false, error: `Supabase API ${res.status}: ${await res.text()}` };
  }
  return { ok: true, metadata: { project_ref: ref } };
}

/* -------------------------------------------------------------------- */
/*  Vercel env vars                                                     */
/* -------------------------------------------------------------------- */

async function propagateVercel(input: PropagationInput): Promise<PropagationResult> {
  const { workspaceId, projectId, envName, value, metadata } = input;
  const { payload } = await getConnectorCredential(workspaceId, projectId, "vercel");
  const token = payload.token;
  const teamId = payload.team_id;
  const vercelProjectId = metadata?.vercel_project_id as string | undefined;
  if (!token || !vercelProjectId) {
    return { ok: false, error: "Vercel connector missing token or vercel_project_id" };
  }
  const teamQuery = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const targets = (metadata?.targets as string[] | undefined) ?? ["production", "preview", "development"];
  const body = {
    key: envName,
    value,
    type: "encrypted",
    target: targets,
  };
  const res = await fetch(`https://api.vercel.com/v10/projects/${vercelProjectId}/env${teamQuery}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // 409 = already exists → PATCH to overwrite.
    if (res.status === 409) {
      const existing = await fetch(`https://api.vercel.com/v9/projects/${vercelProjectId}/env${teamQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      const found = (existing?.envs ?? []).find((e: { key: string }) => e.key === envName);
      if (found) {
        const patch = await fetch(
          `https://api.vercel.com/v9/projects/${vercelProjectId}/env/${found.id}${teamQuery}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ value, target: targets }),
          },
        );
        if (!patch.ok) return { ok: false, error: `Vercel PATCH ${patch.status}: ${await patch.text()}` };
        return { ok: true, metadata: { env_var_id: found.id } };
      }
    }
    return { ok: false, error: `Vercel POST ${res.status}: ${text}` };
  }
  const json = await res.json();
  return { ok: true, metadata: { env_var_id: json?.id } };
}

/* -------------------------------------------------------------------- */
/*  Railway (GraphQL)                                                   */
/* -------------------------------------------------------------------- */

async function propagateRailway(input: PropagationInput): Promise<PropagationResult> {
  const { workspaceId, projectId, envName, value, metadata } = input;
  const { payload } = await getConnectorCredential(workspaceId, projectId, "railway");
  const token = payload.api_key;
  const railwayProjectId = metadata?.railway_project_id as string | undefined;
  const environmentId = metadata?.railway_environment_id as string | undefined;
  if (!token || !railwayProjectId || !environmentId) {
    return { ok: false, error: "Railway connector missing api_key, project_id or environment_id" };
  }
  const mutation = `mutation upsertVar($input: VariableUpsertInput!) { variableUpsert(input: $input) }`;
  const res = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: mutation,
      variables: { input: { projectId: railwayProjectId, environmentId, name: envName, value } },
    }),
  });
  if (!res.ok) return { ok: false, error: `Railway ${res.status}: ${await res.text()}` };
  const json = await res.json();
  if (json.errors) return { ok: false, error: JSON.stringify(json.errors) };
  return { ok: true };
}

/* -------------------------------------------------------------------- */
/*  Render env vars                                                     */
/* -------------------------------------------------------------------- */

async function propagateRender(input: PropagationInput): Promise<PropagationResult> {
  const { workspaceId, projectId, envName, value, metadata } = input;
  const { payload } = await getConnectorCredential(workspaceId, projectId, "render");
  const token = payload.api_key;
  const serviceId = metadata?.render_service_id as string | undefined;
  if (!token || !serviceId) {
    return { ok: false, error: "Render connector missing api_key or service_id" };
  }
  const res = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ key: envName, value }]),
  });
  if (!res.ok) return { ok: false, error: `Render ${res.status}: ${await res.text()}` };
  return { ok: true };
}

/* -------------------------------------------------------------------- */
/*  Cloudflare Workers secrets                                          */
/* -------------------------------------------------------------------- */

async function propagateCloudflare(input: PropagationInput): Promise<PropagationResult> {
  const { workspaceId, projectId, envName, value, metadata } = input;
  const { payload } = await getConnectorCredential(workspaceId, projectId, "cloudflare");
  const token = payload.api_key;
  const accountId = metadata?.account_id as string | undefined;
  const scriptName = metadata?.script_name as string | undefined;
  if (!token || !accountId || !scriptName) {
    return { ok: false, error: "Cloudflare missing token, account_id or script_name" };
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: envName, text: value, type: "secret_text" }),
    },
  );
  if (!res.ok) return { ok: false, error: `Cloudflare ${res.status}: ${await res.text()}` };
  return { ok: true };
}

/* -------------------------------------------------------------------- */
/*  AWS Systems Manager Parameter Store (SecureString)                  */
/* -------------------------------------------------------------------- */

async function propagateAws(input: PropagationInput): Promise<PropagationResult> {
  const { workspaceId, projectId, envName, value } = input;
  const { payload } = await getConnectorCredential(workspaceId, projectId, "aws-s3");
  const accessKey = payload.access_key_id;
  const secretKey = payload.secret_access_key;
  const region = payload.region ?? "us-east-1";
  if (!accessKey || !secretKey) {
    return { ok: false, error: "AWS credentials incomplete (access_key_id / secret_access_key)" };
  }
  // Signing SigV4 by hand here would be lengthy; we PUT via SSM REST endpoint.
  // The user can ship their own Lambda relay if signing is too costly to inline.
  // Minimal implementation: rely on signed presigned helper if/when added.
  return {
    ok: false,
    error:
      "AWS SSM propagation requires SigV4 signing. Use a Lambda relay or set the secret manually for now.",
    metadata: { region, target: `ssm:/${envName}` },
  };
}

/* -------------------------------------------------------------------- */
/*  RunPod (env vars on pods)                                           */
/* -------------------------------------------------------------------- */

async function propagateRunpod(input: PropagationInput): Promise<PropagationResult> {
  const { envName, value } = input;
  // RunPod doesn't expose a project-level secrets API; env vars are set per-pod.
  // We surface this as a manual step until a target pod is selected.
  return {
    ok: false,
    error: "RunPod has no project-level secret API. Add this variable to your pod template manually.",
    metadata: { instructions: `Add env var ${envName}=*** in your pod template` },
  };
}

/* -------------------------------------------------------------------- */
/*  Firebase Functions config                                           */
/* -------------------------------------------------------------------- */

async function propagateFirebase(input: PropagationInput): Promise<PropagationResult> {
  const { envName } = input;
  // Firebase functions config requires gcloud CLI or admin SDK with a service
  // account — not safe to inline without explicit credentials.
  return {
    ok: false,
    error: "Firebase propagation needs a service account JSON. Connect Firebase first.",
    metadata: { suggestion: `gcloud secrets create ${envName} --replication-policy=automatic` },
  };
}

const PROPAGATORS: Record<PropagationTarget, (i: PropagationInput) => Promise<PropagationResult>> = {
  supabase: propagateSupabase,
  vercel: propagateVercel,
  railway: propagateRailway,
  render: propagateRender,
  cloudflare: propagateCloudflare,
  "aws-s3": propagateAws,
  runpod: propagateRunpod,
  firebase: propagateFirebase,
};

export async function runPropagator(
  target: PropagationTarget,
  input: PropagationInput,
): Promise<PropagationResult> {
  const fn = PROPAGATORS[target];
  if (!fn) return { ok: false, error: `Unknown target: ${target}` };
  try {
    return await fn(input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
