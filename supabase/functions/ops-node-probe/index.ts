// ops-node-probe — fetch live data for a topology node by enqueueing an SSH
// probe job for the underlying server.
//
// Body: { topology_id, node_key, server_id, command?: "default" | "containers" | "service" }
//
// Behaviour:
//   - Looks up the latest cached row in ops_node_metrics — if < CACHE_TTL,
//     return it directly (saves a round-trip to the runner).
//   - Otherwise create an ssh_exec job with a small "probe pack" of commands
//     suited to the node kind, return immediately with cached={false, job_id}.
//   - The runner executes the job and writes back into ops_node_metrics via
//     a follow-up endpoint, so the UI can poll for it.
//
// Frontend usage pattern:
//   1. Right-click → POST. If cached, render it. Else mark "Probing…".
//   2. Poll ops_node_metrics for (topology_id, node_key) every 2s for ~30s.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const CACHE_TTL_MS = 15_000;

interface ProbeCommand { step: string; run: string; allow_failure?: boolean; }

function probePackForKind(kind: string, node: Record<string, unknown>): ProbeCommand[] {
  const containerName = (node?.label as string | undefined)?.replace(/[^a-z0-9_-]/gi, "") ?? "";

  switch (kind) {
    case "container":
      return [
        { step: "uptime", run: "uptime -p", allow_failure: true },
        { step: "container", run: `docker ps --filter "name=${containerName}" --format '{{.Status}}|{{.Names}}|{{.Image}}|{{.Ports}}'`, allow_failure: true },
        { step: "stats", run: `docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}' ${containerName} 2>/dev/null || echo not_found`, allow_failure: true },
        { step: "logs", run: `docker logs --tail 20 ${containerName} 2>&1 || echo no_logs`, allow_failure: true },
      ];
    case "database":
    case "cache":
    case "queue":
      return [
        { step: "uptime", run: "uptime -p", allow_failure: true },
        { step: "service", run: `systemctl is-active ${containerName} 2>/dev/null || docker ps --filter "name=${containerName}" --format '{{.Status}}'`, allow_failure: true },
        { step: "ports", run: `ss -tlnp | grep ${containerName} || echo no_match`, allow_failure: true },
        { step: "mem", run: `free -m | awk 'NR==2 {print $3"/"$2" MB"}'`, allow_failure: true },
      ];
    case "server":
      return [
        { step: "uptime", run: "uptime -p", allow_failure: true },
        { step: "load", run: "awk '{print $1, $2, $3}' /proc/loadavg", allow_failure: true },
        { step: "cpu_count", run: "nproc", allow_failure: true },
        { step: "ram", run: "free -m | awk 'NR==2 {print $3\"/\"$2}'", allow_failure: true },
        { step: "disk", run: "df -h / | awk 'NR==2 {print $3\"/\"$2\" (\"$5\")\"}'", allow_failure: true },
        { step: "docker_running", run: "docker ps --format '{{.Names}}' | wc -l", allow_failure: true },
      ];
    case "reverse_proxy":
    case "load_balancer":
      return [
        { step: "uptime", run: "uptime -p", allow_failure: true },
        { step: "nginx", run: "systemctl is-active nginx 2>/dev/null || echo unknown", allow_failure: true },
        { step: "connections", run: "ss -an | grep ':80\\|:443' | wc -l", allow_failure: true },
        { step: "access_tail", run: "tail -n 10 /var/log/nginx/access.log 2>/dev/null || echo no_access_log", allow_failure: true },
      ];
    default:
      return [
        { step: "uptime", run: "uptime -p", allow_failure: true },
        { step: "load", run: "awk '{print $1}' /proc/loadavg", allow_failure: true },
      ];
  }
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { topology_id, node_key, server_id } = await req.json();
    if (!topology_id || !node_key || !server_id) {
      return jsonResponse({ ok: false, message: "topology_id, node_key and server_id are required" }, { status: 400 });
    }

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();

    // 1. Return fresh cached value if available.
    const { data: cached } = await admin
      .from("ops_node_metrics")
      .select("*")
      .eq("topology_id", topology_id)
      .eq("node_key", node_key)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
      return jsonResponse({
        ok: true,
        cached: true,
        metrics: cached.metrics,
        raw: cached.raw,
        status: cached.status,
        fetched_at: cached.created_at,
      });
    }

    // 2. Resolve the topology + node (so we can pick the right command pack).
    const { data: topo } = await admin
      .from("ops_topologies")
      .select("workspace_id, project_id, topology")
      .eq("id", topology_id)
      .maybeSingle();
    if (!topo) return jsonResponse({ ok: false, message: "topology not found" }, { status: 404 });

    const node = (topo.topology?.nodes ?? []).find((n: any) => n.id === node_key);
    const kind = (node?.kind as string) ?? "external";

    // 3. Enqueue the probe job. The runner will:
    //    a) execute the commands
    //    b) write the parsed metrics to ops_node_metrics
    //    c) mark the job succeeded
    const commands = probePackForKind(kind, node ?? {});
    const { data: job, error: jobErr } = await admin
      .from("ops_jobs")
      .insert({
        workspace_id: topo.workspace_id,
        project_id: topo.project_id,
        server_id,
        job_type: "ssh_exec",
        autonomy_mode: "assisted",
        risk_level: "low",
        status: "queued",
        requires_approval: false,
        input: {
          kind: "node_probe",
          topology_id, node_key,
          node_kind: kind,
          commands,
        },
        created_by: userId,
      })
      .select("id")
      .single();
    if (jobErr) throw jobErr;

    return jsonResponse({
      ok: true,
      cached: false,
      job_id: job.id,
      message: "Probe queued. Poll ops_node_metrics for the result.",
    });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
