// test-run-orchestrate — user-facing control of an agentic E2E test run.
//
// Body actions:
//   { action: "start",  workspace_id, project_id, case_id }      → create a run,
//        draft the agent plan, queue it for a runner. Returns { run_id }.
//   { action: "answer", workspace_id, project_id, run_id, answer } → resume a
//        run that paused for input; records the answer and re-queues it.
//
// The per-step "what next?" decision is made in test-runner-poll (the runner
// asks after each observation). This function owns start + human-in-the-loop.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { draftPlan, appendStep } from "../_shared/test-agent.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = await req.json();
    const { action, workspace_id, project_id } = body as {
      action?: string; workspace_id?: string; project_id?: string;
    };
    if (!action || !workspace_id || !project_id) {
      return jsonResponse({ error: "action, workspace_id, project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members").select("role")
      .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!membership || !["owner", "admin", "member"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    // ── START ────────────────────────────────────────────────────────────────
    if (action === "start") {
      const caseId = body.case_id as string | undefined;
      if (!caseId) return jsonResponse({ error: "case_id required" }, { status: 400 });

      const { data: tc } = await admin
        .from("test_cases").select("*").eq("id", caseId).eq("project_id", project_id).maybeSingle();
      if (!tc) return jsonResponse({ error: "Test case not found" }, { status: 404 });
      const { data: suite } = await admin
        .from("test_suites").select("*").eq("id", tc.suite_id).maybeSingle();
      if (!suite) return jsonResponse({ error: "Suite not found" }, { status: 404 });

      const appUrl = tc.start_url || suite.app_url;

      // Create the run in 'planning' while the agent drafts the plan.
      const { data: run, error: runErr } = await admin
        .from("test_runs").insert({
          workspace_id, project_id, suite_id: suite.id, case_id: tc.id,
          app_url: appUrl, status: "planning", created_by: userId,
        }).select().single();
      if (runErr || !run) return jsonResponse({ error: runErr?.message ?? "Could not create run" }, { status: 500 });

      await appendStep(admin, run.id, { actor: "system", kind: "info", label: `Starting test "${tc.name}" against ${appUrl}` });

      // Draft the high-level plan, then queue for a runner.
      const plan = await draftPlan(
        { instructions: tc.instructions, expected_outcome: tc.expected_outcome, fixtures: tc.fixtures ?? {}, app_url: appUrl },
        { workspace_id, project_id },
      );
      if (plan.length > 0) {
        await appendStep(admin, run.id, { actor: "agent", kind: "plan", label: `${plan.length}-step plan`, payload: { plan } });
      }
      await admin.from("test_runs").update({ plan: plan.map((intent) => ({ intent })), status: "queued" }).eq("id", run.id);

      return jsonResponse({ ok: true, run_id: run.id, plan });
    }

    // ── ANSWER (resume a paused run) ──────────────────────────────────────────
    if (action === "answer") {
      const runId = body.run_id as string | undefined;
      const answer = String(body.answer ?? "").trim();
      if (!runId || !answer) return jsonResponse({ error: "run_id and answer required" }, { status: 400 });

      const { data: run } = await admin
        .from("test_runs").select("id, status, project_id").eq("id", runId).maybeSingle();
      if (!run || run.project_id !== project_id) return jsonResponse({ error: "Run not found" }, { status: 404 });
      if (run.status !== "needs_input") {
        return jsonResponse({ error: `Run is not waiting for input (status: ${run.status})` }, { status: 409 });
      }

      await appendStep(admin, runId, { actor: "user", kind: "user_answer", label: answer });
      // Re-queue so the runner picks it up and asks the orchestrator for the
      // next action with the answer now in context.
      await admin.from("test_runs").update({ status: "queued", pending_question: null }).eq("id", runId);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: `Unknown action ${action}` }, { status: 400 });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
