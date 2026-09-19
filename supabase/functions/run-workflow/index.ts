// run-workflow — the workflow API, for BOTH generations.
//
//   • agent_workflows (0196) — blocks assembled on a canvas, compiled into a
//     `workflow.md` playbook. Starting one hands that playbook to the service's
//     ASSISTANT, which reads it and decides who does what; the agent runtime
//     does the rest, so there is no per-step orchestration here.
//   • workflows (0006) — the v1 flat `steps` array. Still executed here because
//     automation-receiver and the assistant's tool list point at this endpoint;
//     an id that is not a playbook falls through to it unchanged.
//
// Actions: (default) start · cancel · sync_schedule.
// Body: { workflow_id, trigger_payload?, action?, run_id? }
//
// It lives in the v1 function rather than a new one on purpose: the project sits
// two slots from Supabase's 100-function ceiling, and this is precisely the
// endpoint the new system replaces.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import {
  startWorkflowRun, syncWorkflowSchedule, syncEventTrigger, removeEventTrigger,
} from "../_shared/workflow-engine.ts";

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

    /**
     * Deux appelants, deux preuves d'identité.
     *
     * Un humain arrive avec sa session : on vérifie qu'il est membre du
     * workspace. Le RUNTIME arrive avec la clé de service — c'est lui qui
     * exécute déjà les agents, et c'est par là qu'un agent lance une procédure
     * (`use_procedure(mode="run")`).
     *
     * Cette porte n'existait pas : `auth.getUser()` échoue sur une clé de
     * service, donc toute demande venue du runtime repartait en « Invalid
     * session ». Une procédure ne pouvait être lancée que par un humain
     * cliquant sur « Tester » — ce qui rendait impossible ce pour quoi les
     * procédures existent : que les agents s'en servent.
     *
     * La comparaison est EXACTE et faite sur l'en-tête entier : rien qui
     * ressemble à un jeton d'utilisateur ne peut la satisfaire.
     */
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isService = !!serviceKey && authHeader === `Bearer ${serviceKey}`;

    let userId: string | null = null;
    if (!isService) {
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      userId = userData.user.id;
    }

    const body = await req.json().catch(() => ({}));
    const { workflow_id, trigger_payload, action, run_id } = body as Record<string, unknown>;
    const admin = createServiceClient();

    /** Membership check — every action below mutates a workspace's runs. Le
     *  runtime n'a pas de compte : son droit vient de la clé, déjà vérifiée. */
    const canTouch = async (workspaceId: string) => {
      if (isService) return true;
      const { data } = await admin.from("workspace_members").select("role")
        .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
      return Boolean(data);
    };

    // Re-derive schedule/next_run_at from the graph. Called by the canvas on
    // activate/pause and after a save, so the scheduler never acts on a stale
    // copy of what the trigger node says.
    if (action === "sync_schedule") {
      if (!workflow_id) return jsonResponse({ error: "workflow_id required" }, { status: 400 });
      const { data: w } = await admin.from("agent_workflows")
        .select("workspace_id").eq("id", String(workflow_id)).maybeSingle();
      if (!w) return jsonResponse({ error: "Workflow not found" }, { status: 404 });
      if (!(await canTouch((w as { workspace_id: string }).workspace_id))) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
      await syncWorkflowSchedule(admin, String(workflow_id));
      return jsonResponse({ ok: true });
    }

    // ── Event subscriptions (0198) ───────────────────────────────────────────
    // The row is written by the client under RLS; this only creates or drops
    // the subscription upstream and reports its status back.
    if (action === "sync_trigger" || action === "remove_trigger") {
      const triggerId = String((body as Record<string, unknown>).trigger_id ?? "");
      if (!triggerId) return jsonResponse({ error: "trigger_id required" }, { status: 400 });
      const { data: t } = await admin.from("agent_workflow_triggers")
        .select("workspace_id").eq("id", triggerId).maybeSingle();
      if (!t) return jsonResponse({ error: "Trigger not found" }, { status: 404 });
      if (!(await canTouch((t as { workspace_id: string }).workspace_id))) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
      if (action === "remove_trigger") await removeEventTrigger(admin, triggerId);
      else await syncEventTrigger(admin, triggerId);
      return jsonResponse({ ok: true });
    }

    // ── Playbook workflows (0196) ────────────────────────────────────────────
    // Cancelling stops the ASSISTANT's run; the workflow run closes with it via
    // the tick engine's terminal reporting, so there is nothing to cancel twice.
    if (action === "cancel") {
      if (!run_id) return jsonResponse({ error: "run_id required" }, { status: 400 });
      const { data: run } = await admin.from("agent_workflow_runs")
        .select("id, workspace_id, agent_run_id").eq("id", String(run_id)).maybeSingle();
      if (!run) return jsonResponse({ error: "Run not found" }, { status: 404 });
      const r = run as { id: string; workspace_id: string; agent_run_id: string | null };
      if (!(await canTouch(r.workspace_id))) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      if (r.agent_run_id) {
        await admin.from("internal_agent_runs")
          .update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", r.agent_run_id);
      }
      await admin.from("agent_workflow_runs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", r.id);
      return jsonResponse({ ok: true });
    }

    if (!workflow_id) return jsonResponse({ error: "workflow_id required" }, { status: 400 });

    // Looked up FIRST: the two tables share no ids, so a hit here is unambiguous.
    const { data: graphWf } = await admin.from("agent_workflows")
      .select("id, workspace_id, status").eq("id", String(workflow_id)).maybeSingle();
    if (graphWf) {
      const g = graphWf as { id: string; workspace_id: string; status: string };
      if (!(await canTouch(g.workspace_id))) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      if (g.status === "archived") return jsonResponse({ error: "Workflow archivé" }, { status: 400 });
      const started = await startWorkflowRun(admin, {
        workflowId: g.id,
        trigger: String((trigger_payload as Record<string, unknown> | undefined)?.trigger ?? "manual"),
        payload: (trigger_payload as Record<string, unknown>) ?? {},
        triggeredBy: userId,
      });
      if ("error" in started) return jsonResponse({ error: started.error }, { status: started.status });
      return jsonResponse({ ok: true, run_id: started.runId });
    }

    // ── v1 workflows (0006) ──────────────────────────────────────────────────
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
