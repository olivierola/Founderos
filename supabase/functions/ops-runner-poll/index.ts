// ops-runner-poll — endpoint called by the Ops Runner to claim its next job
// and report progress.
//
// Auth: X-Runner-Token header, hashed and compared against ops_settings.runner_token_hash.
//
// Methods on a single endpoint (mode in body):
//   - { mode: "claim", runner_id }                              → return next queued job or null
//   - { mode: "log", job_id, level, step, message, metadata }    → append a log line
//   - { mode: "complete", job_id, status, result, exit_code, error_message }
//   - { mode: "update_server", server_id, patch }               → patch the server row (probe results)
//   - { mode: "credential", server_id }                         → return decrypted SSH key for the server
//
// This minimises round-trips and avoids exposing the service role anywhere outside this function.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { decryptSecret } from "../_shared/crypto.ts";

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// projectId === null means the GLOBAL platform token (serves every project).
async function authenticate(req: Request): Promise<{ ok: true; projectId: string | null } | { ok: false; reason: string }> {
  const token = req.headers.get("x-runner-token");
  if (!token) return { ok: false, reason: "Missing X-Runner-Token header" };
  const platform = Deno.env.get("PLATFORM_RUNNER_TOKEN");
  if (platform && token === platform) return { ok: true, projectId: null };
  const hash = await sha256Hex(token);
  const admin = createServiceClient();
  const { data: settings } = await admin
    .from("ops_settings")
    .select("project_id")
    .eq("runner_token_hash", hash)
    .maybeSingle();
  if (!settings) return { ok: false, reason: "Unknown token" };
  return { ok: true, projectId: settings.project_id };
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ ok: false, message: auth.reason }, { status: 401 });
  const { projectId } = auth;
  const admin = createServiceClient();

  try {
    const body = await req.json();
    const mode = body.mode as string;

    if (mode === "claim") {
      const runnerId = body.runner_id as string;
      if (!runnerId) return jsonResponse({ ok: false, message: "runner_id required" }, { status: 400 });
      // The claim_ops_job RPC atomically picks the next queued job project-wide.
      // We filter for this project after the call (since claim_ops_job is global).
      const { data: job } = await admin.rpc("claim_ops_job", { p_runner_id: runnerId });
      // Global platform token (projectId === null) takes any project's job; a
      // per-project token only takes its own.
      if (!job) return jsonResponse({ ok: true, job: null });
      if (projectId !== null && job.project_id !== projectId) {
        // Not ours — release it back to the queue for the right runner.
        await admin.from("ops_jobs").update({ status: "queued", runner_id: null }).eq("id", job.id);
        return jsonResponse({ ok: true, job: null });
      }
      return jsonResponse({ ok: true, job });
    }

    if (mode === "log") {
      const { job_id, level, step, message, metadata } = body;
      if (!job_id || !message) return jsonResponse({ ok: false, message: "job_id+message required" }, { status: 400 });
      // Scope check: only allow logs for jobs in the runner's project.
      const { data: job } = await admin.from("ops_jobs").select("project_id").eq("id", job_id).maybeSingle();
      if (!job || job.project_id !== projectId) return jsonResponse({ ok: false, message: "Job not in this project" }, { status: 403 });
      await admin.from("ops_job_logs").insert({
        job_id, level: level ?? "info", step: step ?? null, message,
        metadata: metadata ?? {},
      });
      return jsonResponse({ ok: true });
    }

    if (mode === "complete") {
      const { job_id, status, result, exit_code, error_message } = body;
      if (!job_id || !status) return jsonResponse({ ok: false, message: "job_id+status required" }, { status: 400 });
      const { data: job } = await admin.from("ops_jobs").select("project_id").eq("id", job_id).maybeSingle();
      if (!job || job.project_id !== projectId) return jsonResponse({ ok: false, message: "Job not in this project" }, { status: 403 });
      await admin.from("ops_jobs").update({
        status,
        result: result ?? {},
        exit_code: exit_code ?? null,
        error_message: error_message ?? null,
        finished_at: new Date().toISOString(),
      }).eq("id", job_id);
      return jsonResponse({ ok: true });
    }

    if (mode === "update_server") {
      const { server_id, patch } = body;
      if (!server_id || !patch) return jsonResponse({ ok: false, message: "server_id+patch required" }, { status: 400 });
      const { data: server } = await admin.from("ops_servers").select("project_id").eq("id", server_id).maybeSingle();
      if (!server || server.project_id !== projectId) return jsonResponse({ ok: false, message: "Server not in this project" }, { status: 403 });
      await admin.from("ops_servers").update({
        ...patch,
        last_checked_at: new Date().toISOString(),
      }).eq("id", server_id);
      return jsonResponse({ ok: true });
    }

    if (mode === "credential") {
      const { server_id } = body;
      if (!server_id) return jsonResponse({ ok: false, message: "server_id required" }, { status: 400 });
      const { data: server } = await admin
        .from("ops_servers")
        .select("project_id, ssh_key_secret_id, ssh_user, ssh_port, ip_address")
        .eq("id", server_id)
        .maybeSingle();
      if (!server || server.project_id !== projectId) {
        return jsonResponse({ ok: false, message: "Server not in this project" }, { status: 403 });
      }
      if (!server.ssh_key_secret_id) {
        return jsonResponse({ ok: false, message: "No SSH key registered" }, { status: 404 });
      }
      const { data: secret } = await admin
        .from("ops_secrets")
        .select("encrypted_payload, iv")
        .eq("id", server.ssh_key_secret_id)
        .maybeSingle();
      if (!secret) return jsonResponse({ ok: false, message: "Secret missing" }, { status: 404 });
      const privateKey = await decryptSecret(secret.encrypted_payload, secret.iv);
      return jsonResponse({
        ok: true,
        connection: {
          host: server.ip_address,
          port: server.ssh_port,
          user: server.ssh_user,
          private_key: privateKey,
        },
      });
    }

    if (mode === "write_node_metrics") {
      const { topology_id, node_key, server_id, metrics, raw, status, duration_ms } = body;
      if (!topology_id || !node_key) {
        return jsonResponse({ ok: false, message: "topology_id and node_key required" }, { status: 400 });
      }
      // Scope check: topology must belong to this runner's project.
      const { data: topo } = await admin
        .from("ops_topologies")
        .select("workspace_id, project_id")
        .eq("id", topology_id)
        .maybeSingle();
      if (!topo || topo.project_id !== projectId) {
        return jsonResponse({ ok: false, message: "Topology not in this project" }, { status: 403 });
      }
      await admin.from("ops_node_metrics").insert({
        workspace_id: topo.workspace_id,
        project_id: topo.project_id,
        topology_id,
        node_key,
        server_id: server_id ?? null,
        metrics: metrics ?? {},
        raw: raw ?? null,
        status: status ?? "ok",
        duration_ms: duration_ms ?? null,
      });
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, message: "Unknown mode" }, { status: 400 });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
