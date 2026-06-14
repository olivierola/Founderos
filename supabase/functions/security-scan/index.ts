// security-scan — start a security scan against an authorised target.
//
// Body: { workspace_id, project_id, target, scan_type }
//   scan_type passive (headers|tls|exposure) → runs inline, returns findings.
//   scan_type active  (port_scan|surface|full) → REQUIRES recorded consent;
//     queued for the runner. Returns { scan_id, status: "queued"|"blocked" }.
//
// Auth: user session (member) OR service role (agent worker).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { runPassiveCheck } from "../_shared/security-checks.ts";

const ACTIVE = new Set(["port_scan", "surface", "full"]);
const PASSIVE = new Set(["headers", "tls", "exposure"]);

function hostOf(target: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
    return u.hostname;
  } catch { return target.replace(/^https?:\/\//, "").split("/")[0]; }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const { workspace_id, project_id, target, scan_type } = body as {
      workspace_id?: string; project_id?: string; target?: string; scan_type?: string;
    };
    if (!workspace_id || !project_id || !target || !scan_type) {
      return jsonResponse({ error: "workspace_id, project_id, target, scan_type required" }, { status: 400 });
    }

    // Auth: service role or workspace member.
    const authHeader = req.headers.get("Authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let userId: string | null = null;
    if (!(serviceKey && authHeader === `Bearer ${serviceKey}`)) {
      if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData, error } = await userClient.auth.getUser();
      if (error || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      userId = userData.user.id;
      const { data: m } = await admin.from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
      if (!m || !["owner", "admin", "member"].includes(m.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    const host = hostOf(target);

    // Find or create the target row.
    let { data: targetRow } = await admin
      .from("security_scan_targets").select("*")
      .eq("project_id", project_id).eq("target", target).maybeSingle();
    if (!targetRow) {
      const { data: created } = await admin.from("security_scan_targets")
        .insert({ workspace_id, project_id, target, created_by: userId })
        .select("*").single();
      targetRow = created;
    }

    // ── Passive: run inline, persist scan + findings, return them. ──
    if (PASSIVE.has(scan_type)) {
      const { data: scan } = await admin.from("security_scans").insert({
        workspace_id, project_id, target_id: targetRow?.id ?? null, target_host: host,
        mode: "passive", scan_type, status: "running", created_by: userId, started_at: new Date().toISOString(),
      }).select("id").single();
      const findings = await runPassiveCheck(scan_type, target);
      if (scan) {
        await admin.from("security_scan_findings").insert(
          findings.map((f) => ({ scan_id: scan.id, workspace_id, project_id, severity: f.severity, title: f.title, detail: f.detail ?? null, evidence: f.evidence ?? {}, remediation: f.remediation ?? null })),
        );
        await admin.from("security_scans").update({ status: "completed", finished_at: new Date().toISOString(), result: { count: findings.length } }).eq("id", scan.id);
      }
      return jsonResponse({ ok: true, scan_id: scan?.id, status: "completed", findings });
    }

    // ── Active: requires recorded consent. Queue for the runner or block. ──
    if (ACTIVE.has(scan_type)) {
      if (!targetRow?.consent_active) {
        // Record a blocked attempt so it's auditable + visible in the UI.
        await admin.from("security_scans").insert({
          workspace_id, project_id, target_id: targetRow?.id ?? null, target_host: host,
          mode: "active", scan_type, status: "blocked", created_by: userId,
          error_message: "No recorded consent for active scanning of this target.",
        });
        return jsonResponse({
          ok: false, status: "blocked",
          error: `Active scanning of "${target}" requires consent. Register the target and confirm you own/are authorised on it, then retry.`,
        }, { status: 403 });
      }
      const { data: scan } = await admin.from("security_scans").insert({
        workspace_id, project_id, target_id: targetRow.id, target_host: host,
        mode: "active", scan_type, status: "queued", created_by: userId,
      }).select("id").single();
      return jsonResponse({ ok: true, scan_id: scan?.id, status: "queued", note: "Queued for the runner (consent verified)." });
    }

    return jsonResponse({ error: `Unknown scan_type ${scan_type}` }, { status: 400 });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
