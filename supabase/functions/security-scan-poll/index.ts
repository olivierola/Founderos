// security-scan-poll — endpoint the runner uses for ACTIVE security scans.
// Auth: X-Runner-Token (global PLATFORM_RUNNER_TOKEN or a per-project ops token).
//
// Modes:
//   { mode: "claim", runner_id } → next queued ACTIVE scan whose target has
//       recorded consent (double-guarded by claim_security_scan). Returns the
//       scan (id, scan_type, target_host) or null.
//   { mode: "complete", scan_id, status, findings?, error_message? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authed(req: Request): Promise<boolean> {
  const token = req.headers.get("x-runner-token");
  if (!token) return false;
  const platform = Deno.env.get("PLATFORM_RUNNER_TOKEN");
  if (platform && token === platform) return true;
  const admin = createServiceClient();
  const { data } = await admin.from("ops_settings").select("project_id").eq("runner_token_hash", await sha256Hex(token)).maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (!(await authed(req))) return jsonResponse({ ok: false, message: "Unknown runner token" }, { status: 401 });

  const admin = createServiceClient();
  try {
    const body = await req.json();
    const mode = body.mode as string;

    if (mode === "claim") {
      const runnerId = String(body.runner_id ?? "");
      if (!runnerId) return jsonResponse({ ok: false, message: "runner_id required" }, { status: 400 });
      const { data: scan } = await admin.rpc("claim_security_scan", { p_runner_id: runnerId });
      if (!scan) return jsonResponse({ ok: true, scan: null });
      return jsonResponse({ ok: true, scan: { id: scan.id, scan_type: scan.scan_type, target_host: scan.target_host } });
    }

    if (mode === "complete") {
      const scanId = String(body.scan_id ?? "");
      const status = ["completed", "failed"].includes(body.status) ? body.status : "completed";
      const { data: scan } = await admin.from("security_scans").select("workspace_id, project_id").eq("id", scanId).maybeSingle();
      if (!scan) return jsonResponse({ ok: false, message: "Scan not found" }, { status: 404 });

      const findings = Array.isArray(body.findings) ? body.findings : [];
      if (findings.length) {
        await admin.from("security_scan_findings").insert(
          findings.slice(0, 200).map((f: Record<string, unknown>) => ({
            scan_id: scanId, workspace_id: scan.workspace_id, project_id: scan.project_id,
            severity: ["info", "low", "medium", "high", "critical"].includes(String(f.severity)) ? f.severity : "info",
            title: String(f.title ?? "Finding").slice(0, 200),
            detail: f.detail ? String(f.detail) : null,
            evidence: (f.evidence && typeof f.evidence === "object") ? f.evidence : {},
            remediation: f.remediation ? String(f.remediation) : null,
          })),
        );
      }
      await admin.from("security_scans").update({
        status, finished_at: new Date().toISOString(),
        error_message: body.error_message ? String(body.error_message) : null,
        result: { count: findings.length },
      }).eq("id", scanId);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, message: `Unknown mode ${mode}` }, { status: 400 });
  } catch (err) {
    return jsonResponse({ ok: false, message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
