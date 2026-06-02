// ops-create-job — enqueue an arbitrary Ops job for the runner.
//
// Body: {
//   server_id, job_type, input?, risk_level?, autonomy_mode?,
//   requires_approval?, bundle_id?, parent_job_id?
// }
//
// If requires_approval is true (or the job is high-risk), the job starts in
// 'awaiting_approval'. Otherwise it goes straight to 'queued' for the runner.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const body = await req.json();
    const {
      server_id, job_type, input, risk_level, autonomy_mode,
      requires_approval, bundle_id, parent_job_id,
    } = body;
    if (!job_type) {
      return jsonResponse({ ok: false, message: "job_type required" }, { status: 400 });
    }

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();

    // Resolve workspace + project from the server.
    let workspaceId: string | null = null;
    let projectId: string | null = null;
    if (server_id) {
      const { data: server } = await admin
        .from("ops_servers")
        .select("workspace_id, project_id")
        .eq("id", server_id)
        .maybeSingle();
      if (server) {
        workspaceId = server.workspace_id;
        projectId = server.project_id;
      }
    }
    // Fallback for jobs without a server (e.g. project-wide checks): allow caller to pass them.
    if (!workspaceId) workspaceId = body.workspace_id;
    if (!projectId) projectId = body.project_id;
    if (!workspaceId || !projectId) {
      return jsonResponse({ ok: false, message: "Could not resolve workspace/project" }, { status: 400 });
    }

    // Look up the project's Ops settings to apply the autonomy default + denylist check.
    const { data: settings } = await admin
      .from("ops_settings")
      .select("default_autonomy_mode, command_denylist")
      .eq("project_id", projectId)
      .maybeSingle();

    const effectiveAutonomy = autonomy_mode ?? settings?.default_autonomy_mode ?? "assisted";
    const risk = risk_level ?? "medium";

    // Approval policy: ask for approval if explicitly requested, OR if risk is
    // high/critical and the autonomy mode is not 'autopilot'.
    let approvalRequired = requires_approval ?? false;
    if ((risk === "high" || risk === "critical") && effectiveAutonomy !== "autopilot") {
      approvalRequired = true;
    }
    // In 'advisor' mode, no automatic execution at all.
    if (effectiveAutonomy === "advisor") approvalRequired = true;

    // Sanity: scan inline commands against the denylist (best-effort).
    if (settings?.command_denylist && Array.isArray(input?.commands)) {
      const joined = (input.commands as any[]).map((c) => c.run ?? "").join("\n");
      for (const pat of settings.command_denylist) {
        try {
          const re = new RegExp(pat);
          if (re.test(joined)) {
            return jsonResponse({
              ok: false,
              message: `Job rejected — command matches denylist pattern: ${pat}`,
            }, { status: 403 });
          }
        } catch { /* ignore invalid regex */ }
      }
    }

    const initialStatus = approvalRequired ? "awaiting_approval" : "queued";

    const { data: job, error } = await admin
      .from("ops_jobs")
      .insert({
        workspace_id: workspaceId,
        project_id: projectId,
        server_id: server_id ?? null,
        bundle_id: bundle_id ?? null,
        parent_job_id: parent_job_id ?? null,
        job_type,
        autonomy_mode: effectiveAutonomy,
        risk_level: risk,
        status: initialStatus,
        requires_approval: approvalRequired,
        input: input ?? {},
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw error;

    // Log the creation as a job event.
    await admin.from("ops_job_logs").insert({
      job_id: job.id,
      level: "info",
      step: "lifecycle",
      message: `Job created by user (${effectiveAutonomy} mode, risk=${risk}, approval=${approvalRequired})`,
    });

    return jsonResponse({ ok: true, job_id: job.id, status: initialStatus });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
