// test-runner-poll — the single endpoint the Playwright test runner talks to.
// Auth: X-Runner-Token (hashed, compared against ops_settings.runner_token_hash —
// the same runner identity used by the Ops module).
//
// Modes (in body):
//   { mode: "claim", runner_id }
//        → claims the next queued test_run project-wide. Returns the run plus
//          its test case context (instructions, fixtures, app_url) or null.
//
//   { mode: "observe", run_id, current_url, dom_excerpt, screenshot_url? }
//        → the runner reports what it sees after loading/acting; the agent
//          decides the next action and we return it:
//            { action: { type, selector, value, ... } }
//          Side effects by action.type:
//            ask_user → run.status = 'needs_input' (runner should idle-poll)
//            pass/fail → run finished (status passed/failed)
//
//   { mode: "poll", run_id }
//        → lightweight check for a paused (needs_input) run: returns
//          { resumed: bool } so the runner knows when the user answered.
//
//   { mode: "complete", run_id, status, error_message? }
//        → terminal report from the runner (e.g. crash/timeout).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import {
  decideNextAction, appendStep, actionToStep, type RunContext,
} from "../_shared/test-agent.ts";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request): Promise<{ ok: true; projectId: string } | { ok: false; reason: string }> {
  const token = req.headers.get("x-runner-token");
  if (!token) return { ok: false, reason: "Missing X-Runner-Token header" };
  const admin = createServiceClient();
  const { data } = await admin
    .from("ops_settings").select("project_id").eq("runner_token_hash", await sha256Hex(token)).maybeSingle();
  if (!data) return { ok: false, reason: "Unknown runner token" };
  return { ok: true, projectId: data.project_id };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ ok: false, message: auth.reason }, { status: 401 });
  const { projectId } = auth;
  const admin = createServiceClient();

  try {
    const body = await req.json();
    const mode = body.mode as string;

    // ── CLAIM ────────────────────────────────────────────────────────────────
    if (mode === "claim") {
      const runnerId = String(body.runner_id ?? "");
      if (!runnerId) return jsonResponse({ ok: false, message: "runner_id required" }, { status: 400 });
      const { data: run } = await admin.rpc("claim_test_run", { p_runner_id: runnerId });
      if (!run || run.project_id !== projectId) return jsonResponse({ ok: true, run: null });

      const { data: tc } = await admin
        .from("test_cases").select("name, instructions, expected_outcome, fixtures").eq("id", run.case_id).maybeSingle();
      await appendStep(admin, run.id, { actor: "runner", kind: "info", label: `Runner ${runnerId} picked up the run` });

      return jsonResponse({
        ok: true,
        run: {
          id: run.id, app_url: run.app_url, plan: run.plan,
          case: tc ?? null,
        },
      });
    }

    // ── OBSERVE → decide next action ──────────────────────────────────────────
    if (mode === "observe") {
      const runId = String(body.run_id ?? "");
      if (!runId) return jsonResponse({ ok: false, message: "run_id required" }, { status: 400 });

      const { data: run } = await admin.from("test_runs").select("*").eq("id", runId).maybeSingle();
      if (!run || run.project_id !== projectId) return jsonResponse({ ok: false, message: "Run not found" }, { status: 404 });
      if (["passed", "failed", "error", "cancelled"].includes(run.status)) {
        return jsonResponse({ ok: true, action: { type: run.status === "passed" ? "pass" : "fail" }, terminal: true });
      }

      const currentUrl = body.current_url ? String(body.current_url) : run.current_url;
      const domExcerpt = body.dom_excerpt ? String(body.dom_excerpt) : null;
      const screenshotUrl = body.screenshot_url ? String(body.screenshot_url) : null;

      // Persist the latest observation so the live view can render it.
      await admin.from("test_runs").update({
        current_url: currentUrl,
        last_dom_excerpt: domExcerpt,
        last_screenshot_url: screenshotUrl ?? run.last_screenshot_url,
        status: "running",
      }).eq("id", runId);

      // Gather context for the agent: case + history + prior user answers.
      const { data: tc } = await admin
        .from("test_cases").select("instructions, expected_outcome, fixtures").eq("id", run.case_id).maybeSingle();
      const { data: stepRows } = await admin
        .from("test_run_steps").select("kind, label, actor").eq("run_id", runId).order("idx", { ascending: true });
      const steps = stepRows ?? [];
      const userAnswers = steps.filter((s) => s.kind === "user_answer").map((s) => String(s.label ?? ""));

      const ctx: RunContext = {
        instructions: tc?.instructions ?? "",
        expected_outcome: tc?.expected_outcome ?? null,
        fixtures: (tc?.fixtures ?? {}) as Record<string, unknown>,
        app_url: run.app_url,
        current_url: currentUrl,
        dom_excerpt: domExcerpt,
        history: steps.map((s) => ({ kind: s.kind, label: s.label })),
        user_answers: userAnswers,
      };

      const action = await decideNextAction(ctx, { workspace_id: run.workspace_id, project_id: projectId });
      const step = actionToStep(action);

      // Record the agent's decision as a timeline step (carry the screenshot the
      // runner just captured so the frame lines up with the action).
      await appendStep(admin, runId, {
        actor: "agent", kind: step.kind, label: step.label, payload: action as unknown as Record<string, unknown>,
        screenshot_url: screenshotUrl,
      });

      // Terminal / pause transitions.
      if (action.type === "ask_user") {
        await admin.from("test_runs").update({ status: "needs_input", pending_question: action.question ?? "Need input" }).eq("id", runId);
        return jsonResponse({ ok: true, action, paused: true });
      }
      if (action.type === "pass" || action.type === "fail") {
        await admin.from("test_runs").update({
          status: action.type === "pass" ? "passed" : "failed",
          finished_at: new Date().toISOString(),
          result: { assertion: action.assertion ?? null },
          error_message: action.type === "fail" ? (action.reason ?? action.assertion ?? "Test failed") : null,
        }).eq("id", runId);
        return jsonResponse({ ok: true, action, terminal: true });
      }

      return jsonResponse({ ok: true, action });
    }

    // ── POLL (paused run) ─────────────────────────────────────────────────────
    if (mode === "poll") {
      const runId = String(body.run_id ?? "");
      const { data: run } = await admin.from("test_runs").select("status, project_id").eq("id", runId).maybeSingle();
      if (!run || run.project_id !== projectId) return jsonResponse({ ok: false, message: "Run not found" }, { status: 404 });
      // 'queued' again means the user answered and the orchestrator re-queued it.
      return jsonResponse({ ok: true, resumed: run.status === "queued" || run.status === "running", status: run.status });
    }

    // ── COMPLETE (terminal report) ────────────────────────────────────────────
    if (mode === "complete") {
      const runId = String(body.run_id ?? "");
      const status = ["passed", "failed", "error", "cancelled"].includes(body.status) ? body.status : "error";
      const { data: run } = await admin.from("test_runs").select("project_id").eq("id", runId).maybeSingle();
      if (!run || run.project_id !== projectId) return jsonResponse({ ok: false, message: "Run not found" }, { status: 404 });
      await admin.from("test_runs").update({
        status, finished_at: new Date().toISOString(),
        error_message: body.error_message ? String(body.error_message) : null,
      }).eq("id", runId);
      await appendStep(admin, runId, {
        actor: "runner", kind: status === "passed" ? "pass" : status === "failed" ? "fail" : "error",
        label: body.error_message ? String(body.error_message) : `Run ${status}`,
      });
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, message: `Unknown mode ${mode}` }, { status: 400 });
  } catch (err) {
    return jsonResponse({ ok: false, message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
