// ops-approve-job — approve, cancel, or rollback an Ops job.
//
// Body: { job_id, decision: "approve" | "cancel" | "rollback" }
//
// approve   → move from 'awaiting_approval' to 'queued'; record approver/time.
// cancel    → mark 'cancelled' (only if not yet started).
// rollback  → mark the original job 'rolled_back' and create a new compensating
//             job (e.g. terraform_destroy after terraform_apply, app_rollback
//             after app_deploy). The new job needs its own approval flow if
//             risk is high.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const ROLLBACK_TYPE: Record<string, string> = {
  terraform_apply: "terraform_destroy",
  app_deploy: "app_rollback",
  docker_compose_up: "docker_compose_down",
  k8s_apply: "k8s_rollback",
  k8s_rollout: "k8s_rollback",
};

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { job_id, decision } = await req.json();
    if (!job_id || !decision) {
      return jsonResponse({ ok: false, message: "job_id and decision required" }, { status: 400 });
    }

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();
    const { data: job } = await admin.from("ops_jobs").select("*").eq("id", job_id).maybeSingle();
    if (!job) return jsonResponse({ ok: false, message: "Job not found" }, { status: 404 });

    if (decision === "approve") {
      if (job.status !== "awaiting_approval") {
        return jsonResponse({ ok: false, message: `Cannot approve a job in '${job.status}' state` }, { status: 400 });
      }
      await admin
        .from("ops_jobs")
        .update({
          status: "queued",
          approved_by: userId,
          approved_at: new Date().toISOString(),
        })
        .eq("id", job_id);
      await admin.from("ops_job_logs").insert({
        job_id,
        level: "info",
        step: "lifecycle",
        message: `Approved by user ${userId}. Runner will pick up.`,
      });
      return jsonResponse({ ok: true, status: "queued" });
    }

    if (decision === "cancel") {
      if (!["draft", "awaiting_approval", "approved", "queued"].includes(job.status)) {
        return jsonResponse({ ok: false, message: `Cannot cancel a '${job.status}' job` }, { status: 400 });
      }
      await admin.from("ops_jobs").update({ status: "cancelled" }).eq("id", job_id);
      await admin.from("ops_job_logs").insert({
        job_id,
        level: "info",
        step: "lifecycle",
        message: `Cancelled by user ${userId}.`,
      });
      return jsonResponse({ ok: true, status: "cancelled" });
    }

    if (decision === "rollback") {
      if (job.status !== "succeeded" && job.status !== "failed") {
        return jsonResponse({ ok: false, message: "Can only rollback finished jobs" }, { status: 400 });
      }
      const compensType = ROLLBACK_TYPE[job.job_type];
      if (!compensType) {
        return jsonResponse({ ok: false, message: `No rollback procedure for job_type '${job.job_type}'` }, { status: 400 });
      }
      const { data: newJob, error: newErr } = await admin
        .from("ops_jobs")
        .insert({
          workspace_id: job.workspace_id,
          project_id: job.project_id,
          server_id: job.server_id,
          bundle_id: job.bundle_id,
          parent_job_id: job.id,
          job_type: compensType,
          autonomy_mode: job.autonomy_mode,
          risk_level: "high",
          status: "awaiting_approval",
          requires_approval: true,
          input: { rollback_of: job.id, original_input: job.input },
          created_by: userId,
        })
        .select("id")
        .single();
      if (newErr) throw newErr;

      await admin.from("ops_jobs")
        .update({ status: "rolled_back", rollback_job_id: newJob.id })
        .eq("id", job_id);

      await admin.from("ops_job_logs").insert({
        job_id,
        level: "info",
        step: "lifecycle",
        message: `Rollback requested. Compensating job ${newJob.id} created (awaiting approval).`,
      });

      return jsonResponse({ ok: true, status: "rolled_back", new_job_id: newJob.id });
    }

    return jsonResponse({ ok: false, message: "Unknown decision" }, { status: 400 });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
