// run-workflow — executes a workflow by id. Steps are simple JSON: [{ type, ... }].
// Supported step types: 'log', 'webhook' (HTTP POST), 'create_alert', 'create_incident'.
// Body: { workflow_id, trigger_payload? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

interface Step {
  type: string;
  [k: string]: unknown;
}

async function runStep(step: Step, ctx: { admin: any; workspace_id: string; project_id: string; trigger: unknown }) {
  switch (step.type) {
    case "log":
      return { logged: step.message ?? "log" };
    case "webhook": {
      const res = await fetch(String(step.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: ctx.trigger, ...(step.body as object ?? {}) }),
      });
      return { status: res.status };
    }
    case "create_alert":
      await ctx.admin.from("alerts").insert({
        workspace_id: ctx.workspace_id,
        project_id: ctx.project_id,
        type: String(step.alert_type ?? "workflow"),
        severity: String(step.severity ?? "info"),
        title: String(step.title ?? "Workflow alert"),
        message: step.message ? String(step.message) : null,
      });
      return { alert_created: true };
    case "create_incident":
      await ctx.admin.from("incidents").insert({
        workspace_id: ctx.workspace_id,
        project_id: ctx.project_id,
        title: String(step.title ?? "Workflow incident"),
        severity: String(step.severity ?? "minor"),
        status: "open",
      });
      return { incident_created: true };
    default:
      return { error: `Unknown step type ${step.type}` };
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workflow_id, trigger_payload } = await req.json();
    if (!workflow_id) return jsonResponse({ error: "workflow_id required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: wf } = await admin.from("workflows").select("*").eq("id", workflow_id).maybeSingle();
    if (!wf) return jsonResponse({ error: "Workflow not found" }, { status: 404 });

    const { data: run } = await admin
      .from("workflow_runs")
      .insert({
        workspace_id: wf.workspace_id,
        workflow_id: wf.id,
        status: "running",
        trigger_payload: trigger_payload ?? {},
      })
      .select()
      .single();

    const results: unknown[] = [];
    try {
      for (const step of (wf.steps ?? []) as Step[]) {
        results.push(await runStep(step, { admin, workspace_id: wf.workspace_id, project_id: wf.project_id, trigger: trigger_payload }));
      }
      await admin
        .from("workflow_runs")
        .update({ status: "succeeded", finished_at: new Date().toISOString(), result: { steps: results } })
        .eq("id", run!.id);
      return jsonResponse({ ok: true, run_id: run!.id, results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await admin
        .from("workflow_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg })
        .eq("id", run!.id);
      return jsonResponse({ error: msg, run_id: run!.id }, { status: 500 });
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
