// ops-run-checks — execute enabled checks for a project.
//
// Body: { project_id, scope: "all" | "post_deploy" | "scheduled" | "definition_id", definition_id? }
//
// HTTP probes (http_status, http_contains, http_latency, ssl_valid) run
// directly here (Deno can do fetch + Deno.Conn TLS info). Probes that require
// SSH (custom_ssh, container_running, disk_usage…) are pushed as ops_jobs for
// the runner.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

interface Probe {
  id: string;
  workspace_id: string;
  project_id: string;
  server_id: string | null;
  probe_type: string;
  config: Record<string, any>;
  baseline: Record<string, any>;
  category: string;
  mode: string;
  enabled: boolean;
}

const REMOTE_PROBES = new Set([
  "custom_ssh", "container_running", "disk_usage", "memory_usage", "tcp_port",
]);

async function runHttpStatus(probe: Probe) {
  const url = probe.config.url as string;
  const expected = probe.config.expected_status ?? 200;
  const timeout = probe.config.timeout_ms ?? 5000;
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const latency = Date.now() - start;
    if (resp.status === expected) {
      return { status: "passed", measured: { status: resp.status, latency_ms: latency }, message: null };
    }
    return {
      status: "failed",
      measured: { status: resp.status, latency_ms: latency },
      message: `Expected ${expected}, got ${resp.status}.`,
    };
  } catch (e: any) {
    return { status: "failed", measured: { error: e?.message ?? String(e) }, message: e?.message ?? "Fetch failed" };
  }
}

async function runHttpContains(probe: Probe) {
  const url = probe.config.url as string;
  const mustContain = probe.config.must_contain as string;
  try {
    const resp = await fetch(url);
    const text = await resp.text();
    if (text.includes(mustContain)) {
      return { status: "passed", measured: { status: resp.status }, message: null };
    }
    return { status: "failed", measured: { status: resp.status }, message: `Response did not contain "${mustContain}"` };
  } catch (e: any) {
    return { status: "failed", measured: { error: e?.message }, message: e?.message ?? "Fetch failed" };
  }
}

async function runHttpLatency(probe: Probe) {
  const url = probe.config.url as string;
  const max = probe.config.max_latency_ms ?? 1000;
  const start = Date.now();
  try {
    const resp = await fetch(url);
    const latency = Date.now() - start;
    await resp.body?.cancel();
    if (latency <= max) {
      return { status: "passed", measured: { latency_ms: latency }, message: null };
    }
    return {
      status: latency <= max * 1.5 ? "warn" : "failed",
      measured: { latency_ms: latency },
      message: `Latency ${latency}ms exceeds budget ${max}ms.`,
    };
  } catch (e: any) {
    return { status: "failed", measured: { error: e?.message }, message: e?.message ?? "Fetch failed" };
  }
}

async function runSslValid(probe: Probe) {
  const domain = probe.config.domain as string;
  try {
    const conn = await Deno.connectTls({ hostname: domain, port: 443 });
    // ts-ignore: handshakeInfo is not in public Deno types but is available at runtime.
    const cert = (conn as any).peerCertificates?.[0];
    conn.close();
    if (!cert) {
      return { status: "warn", measured: {}, message: "Connected but could not read certificate." };
    }
    const expiry = new Date(cert.notAfter ?? cert.validTo ?? 0);
    const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86400_000);
    const minDays = probe.config.min_days_before_expiry ?? 14;
    if (daysLeft < minDays) {
      return {
        status: daysLeft < 0 ? "failed" : "warn",
        measured: { days_left: daysLeft },
        message: `SSL expires in ${daysLeft} days (threshold ${minDays}).`,
      };
    }
    return { status: "passed", measured: { days_left: daysLeft }, message: null };
  } catch (e: any) {
    return { status: "failed", measured: { error: e?.message }, message: e?.message ?? "TLS handshake failed" };
  }
}

async function runDnsResolve(probe: Probe) {
  const domain = probe.config.domain as string;
  try {
    const records = await Deno.resolveDns(domain, "A");
    if (records.length === 0) {
      return { status: "failed", measured: {}, message: "No A record." };
    }
    const expected = (probe.config.expected_ips ?? []) as string[];
    if (expected.length > 0 && !expected.some((ip) => records.includes(ip))) {
      return {
        status: "warn",
        measured: { resolved: records },
        message: `Resolved IPs ${records.join(", ")} don't match expected ${expected.join(", ")}.`,
      };
    }
    return { status: "passed", measured: { resolved: records }, message: null };
  } catch (e: any) {
    return { status: "failed", measured: { error: e?.message }, message: e?.message ?? "DNS failed" };
  }
}

function computeDelta(measured: any, baseline: any) {
  if (!baseline || Object.keys(baseline).length === 0) return {};
  const out: Record<string, number> = {};
  for (const k of Object.keys(baseline)) {
    if (typeof baseline[k] === "number" && typeof measured[k] === "number") {
      out[k] = measured[k] - baseline[k];
    }
  }
  return out;
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { project_id, scope, definition_id } = await req.json();
    if (!project_id) return jsonResponse({ ok: false, message: "project_id required" }, { status: 400 });

    const admin = createServiceClient();

    // Caller must be a member of the workspace owning the project (internal
    // callers use the service-role key, which skips this path).
    const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (authToken !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      const userClient = createUserClient(req);
      const { data: userInfo, error: authErr } = await userClient.auth.getUser();
      if (authErr || !userInfo?.user) {
        return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
      }
      const { data: proj } = await admin
        .from("projects").select("workspace_id").eq("id", project_id).maybeSingle();
      if (!proj) return jsonResponse({ ok: false, message: "Project not found" }, { status: 404 });
      const { data: membership } = await admin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", proj.workspace_id)
        .eq("user_id", userInfo.user.id)
        .maybeSingle();
      if (!membership) {
        return jsonResponse({ ok: false, message: "Not authorized for this workspace" }, { status: 403 });
      }
    }

    let q = admin.from("ops_check_definitions")
      .select("*")
      .eq("project_id", project_id)
      .eq("enabled", true);
    if (definition_id) q = q.eq("id", definition_id);
    else if (scope === "post_deploy") q = q.eq("mode", "post_deploy");
    else if (scope === "scheduled") q = q.eq("mode", "scheduled");

    const { data: probes } = await q;
    if (!probes || probes.length === 0) {
      return jsonResponse({ ok: true, executed: 0, message: "No matching checks." });
    }

    let executed = 0;
    let pushed = 0;
    for (const probe of probes as Probe[]) {
      // Probes requiring a server are pushed as jobs for the runner.
      if (REMOTE_PROBES.has(probe.probe_type) && probe.server_id) {
        await admin.from("ops_jobs").insert({
          workspace_id: probe.workspace_id,
          project_id: probe.project_id,
          server_id: probe.server_id,
          job_type: "ssh_exec",
          autonomy_mode: "assisted",
          risk_level: "low",
          status: "queued",
          requires_approval: false,
          input: { kind: "probe", probe_id: probe.id, probe_type: probe.probe_type, config: probe.config },
        });
        pushed++;
        continue;
      }

      const start = Date.now();
      let outcome: { status: string; measured: any; message: string | null };
      switch (probe.probe_type) {
        case "http_status": outcome = await runHttpStatus(probe); break;
        case "http_contains": outcome = await runHttpContains(probe); break;
        case "http_latency": outcome = await runHttpLatency(probe); break;
        case "ssl_valid": outcome = await runSslValid(probe); break;
        case "dns_resolve": outcome = await runDnsResolve(probe); break;
        default:
          outcome = { status: "skipped", measured: {}, message: `No edge handler for ${probe.probe_type}` };
      }
      const delta = computeDelta(outcome.measured, probe.baseline);

      await admin.from("ops_check_runs").insert({
        workspace_id: probe.workspace_id,
        project_id: probe.project_id,
        definition_id: probe.id,
        status: outcome.status,
        measured_value: outcome.measured,
        delta,
        message: outcome.message,
        duration_ms: Date.now() - start,
      });
      executed++;
    }

    return jsonResponse({ ok: true, executed, pushed_as_jobs: pushed });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
