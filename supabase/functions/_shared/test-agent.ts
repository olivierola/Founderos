// Shared brain for the agentic E2E testing module. Turns a natural-language
// test into a plan, and — given the current DOM/URL — decides the next browser
// action (navigate/click/fill/scroll/assert), whether to ask the user, or
// whether the test has passed/failed.
//
// Used by both test-run-orchestrate (start/answer) and test-runner-poll
// (the runner asking "what next?").

import { callAi, safeParseJson } from "./ai.ts";
import { logLlmUsage } from "./llm-tracking.ts";
import { createServiceClient } from "./supabase-admin.ts";

type Admin = ReturnType<typeof createServiceClient>;

// The agent needs strong reasoning to drive a browser. We run it on DeepSeek
// (deepseek-chat) for reliable agentic reasoning. Override the model with
// E2E_AGENT_MODEL and the provider with E2E_AGENT_PROVIDER without redeploying.
const AGENT_PROVIDER = (Deno.env.get("E2E_AGENT_PROVIDER") as "groq" | "deepseek" | undefined) || "deepseek";
const AGENT_MODEL = Deno.env.get("E2E_AGENT_MODEL") || "deepseek-chat";

export interface BrowserAction {
  // What the runner should do next.
  type: "navigate" | "click" | "fill" | "select" | "scroll" | "press" | "wait"
      | "assert" | "say" | "ask_user" | "pass" | "fail";
  ref?: number | string;   // index of a target element from the snapshot (preferred)
  selector?: string;       // fallback CSS/text selector if no ref fits
  value?: string;          // text to type, option to select, url to navigate
  key?: string;            // key for press (e.g. "Enter")
  direction?: "up" | "down"; // for scroll
  amount?: number;         // px for scroll, ms for wait
  message?: string;        // for "say": a free-text note/explanation to the user
  question?: string;       // for ask_user
  reason?: string;         // short rationale, shown in the timeline
  assertion?: string;      // for assert/pass/fail: what was being checked
}

export interface RunContext {
  instructions: string;
  expected_outcome: string | null;
  fixtures: Record<string, unknown>;
  app_url: string;
  current_url: string | null;
  dom_excerpt: string | null;
  // Prior steps so the agent doesn't loop.
  history: Array<{ kind: string; label: string | null }>;
  // Answers the user supplied to earlier ask_user steps.
  user_answers: string[];
}

const SYSTEM = `You are an expert autonomous end-to-end test agent. You drive a real Chromium browser (Playwright) against a web app to verify a scenario, like a careful QA engineer.

Each turn you get: the test goal, the current URL, the recent steps, and a SNAPSHOT of the page. The snapshot lists every visible interactive element as a numbered ref:
  [3] button "New organisation"
  [4] input:email "Email"
  [5] a "Sign in"

HOW TO ACT — critical:
- To click/fill/select, reference the element by its NUMBER via "ref" (e.g. {"type":"click","ref":3}). This is the reliable way. DO NOT invent CSS selectors like "button > h1 + button" or "button#radix-:r9:" — they are guesses and will fail. Only use "selector" with plain visible text if truly no ref fits.
- Pick the ref whose label best matches your intent. Match by meaning, not position.
- "fill" needs a "ref" AND a non-empty "value". If you lack the value (password, OTP, email, a code, or which option to choose), use "ask_user" with a precise question. Never invent secrets, never fill empty.

THINKING:
- One small step at a time: read the snapshot, pick the single best next action.
- After acting, the next snapshot shows the result. Check it changed as expected before continuing.
- Stay on task. If the page already shows the expected outcome, STOP with "pass".

NEVER LOOP:
- Check "Steps already taken". If an action didn't change the page (same refs/URL) or failed, DO NOT repeat it. Try a different ref, scroll to reveal more, wait briefly for a dialog/animation, or ask_user.
- If "PREVIOUS ACTION FAILED" appears, the target wasn't found/clickable — choose a DIFFERENT ref or approach.
- If stuck after a couple attempts, ask_user with a specific question instead of guessing.

TALKING:
- Use "say" to explain something to the user in plain natural language — what you observe, why you chose an approach, a finding, or a short status update. After a "say" you keep control and will act on the next turn, so use it when an explanation adds value (don't narrate every trivial step).
- Use "ask_user" only when you actually need information or a decision to continue.

VERDICT:
- "pass" with a one-line "assertion" when the expected outcome is clearly visible.
- "fail" with "reason" when the app proves the test failed.
- Never do destructive actions beyond what the test asks.

Respond with STRICT JSON for the SINGLE next action, no prose:
{ "type": "...", "ref": 0, "selector": "...", "value": "...", "key": "...", "direction": "up|down", "amount": 0, "message": "...", "question": "...", "assertion": "...", "reason": "..." }
Include only fields relevant to the chosen type. For click/fill/select prefer "ref". For "fill", "value" is required. For "say", put your message in "message". Always include a short "reason".`;

// ── Structured run report ───────────────────────────────────────────────────
export interface RunReport {
  title: string;
  verdict: "pass" | "fail";
  summary: string;                        // 2-3 sentence executive summary
  metrics: Array<{ label: string; value: string; tone?: "good" | "bad" | "neutral" }>;
  steps: Array<{ label: string; status: "ok" | "fail" | "info" }>;
  findings: Array<{ severity: "info" | "warning" | "critical"; title: string; detail?: string }>;
  recommendations: string[];
}

// Produce a rich, structured report from the full run history. Best-effort: on
// any failure we synthesise a minimal report so the UI always has something.
export async function generateRunReport(
  ctx: {
    instructions: string;
    expected_outcome: string | null;
    app_url: string;
    verdict: "pass" | "fail";
    assertion?: string | null;
    failReason?: string | null;
    history: Array<{ kind: string; label: string | null; actor?: string }>;
    durationMs?: number | null;
  },
  scope: { workspace_id: string; project_id: string },
): Promise<RunReport> {
  const actionLog = ctx.history
    .filter((h) => h.kind !== "dom_snapshot")
    .map((h, i) => `${i + 1}. [${h.actor ?? "agent"}] ${h.kind}${h.label ? `: ${h.label}` : ""}`)
    .join("\n")
    .slice(0, 6000);

  const userPrompt = `Write a QA test report as STRICT JSON.

Test goal:
"""${ctx.instructions}"""
Expected outcome: ${ctx.expected_outcome ?? "(inferred)"}
App: ${ctx.app_url}
Final verdict: ${ctx.verdict.toUpperCase()}${ctx.assertion ? ` — ${ctx.assertion}` : ""}${ctx.failReason ? ` — ${ctx.failReason}` : ""}
${ctx.durationMs ? `Duration: ${Math.round(ctx.durationMs / 1000)}s` : ""}

Execution log (most recent last):
${actionLog || "(no steps)"}

Return JSON exactly in this shape:
{
  "title": "short report title",
  "verdict": "pass" | "fail",
  "summary": "2-3 sentence executive summary of what was tested and the outcome",
  "metrics": [ { "label": "Steps", "value": "12", "tone": "neutral" }, { "label": "Duration", "value": "34s" } ],
  "steps": [ { "label": "Navigated to /login", "status": "ok" } ],
  "findings": [ { "severity": "info"|"warning"|"critical", "title": "...", "detail": "..." } ],
  "recommendations": [ "actionable suggestion", ... ]
}
Base everything on the actual log. Keep it concise and useful. tone: "good" for positive metrics, "bad" for problems, else "neutral".`;

  const fallback: RunReport = {
    title: ctx.verdict === "pass" ? "Test passed" : "Test failed",
    verdict: ctx.verdict,
    summary: ctx.assertion || ctx.failReason || `The test ${ctx.verdict === "pass" ? "completed successfully" : "did not pass"}.`,
    metrics: [
      { label: "Verdict", value: ctx.verdict.toUpperCase(), tone: ctx.verdict === "pass" ? "good" : "bad" },
      { label: "Steps", value: String(ctx.history.filter((h) => ["click", "fill", "select", "navigate", "press", "scroll"].includes(h.kind)).length) },
      ...(ctx.durationMs ? [{ label: "Duration", value: `${Math.round(ctx.durationMs / 1000)}s` }] : []),
    ],
    steps: ctx.history
      .filter((h) => ["click", "fill", "select", "navigate", "press", "scroll", "assert"].includes(h.kind))
      .map((h) => ({ label: h.label || h.kind, status: "ok" as const })),
    findings: ctx.verdict === "fail"
      ? [{ severity: "critical" as const, title: "Test failed", detail: ctx.failReason ?? undefined }]
      : [],
    recommendations: [],
  };

  try {
    let res;
    try {
      res = await callAi({ task: "json_extraction", systemPrompt: "You write concise, structured QA reports as strict JSON.", userPrompt, jsonMode: true, maxTokens: 1200, provider: AGENT_PROVIDER, model: AGENT_MODEL });
    } catch (_e) {
      res = await callAi({ task: "json_extraction", systemPrompt: "You write concise, structured QA reports as strict JSON.", userPrompt, jsonMode: true, maxTokens: 1200 });
    }
    logLlmUsage({ ...scope, provider: res.provider, model: res.model, task: "json_extraction", feature: "e2e_testing_report", usage: res.usage });
    const parsed = safeParseJson<RunReport>(res.content);
    if (!parsed || !parsed.summary) return fallback;
    // Normalise + clamp.
    return {
      title: String(parsed.title ?? fallback.title).slice(0, 120),
      verdict: parsed.verdict === "fail" ? "fail" : parsed.verdict === "pass" ? "pass" : ctx.verdict,
      summary: String(parsed.summary).slice(0, 800),
      metrics: Array.isArray(parsed.metrics) ? parsed.metrics.slice(0, 8) : fallback.metrics,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 60) : fallback.steps,
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 20) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 10).map(String) : [],
    };
  } catch {
    return fallback;
  }
}

// Draft a high-level ordered plan (intents) from the NL instructions.
export async function draftPlan(
  ctx: Pick<RunContext, "instructions" | "expected_outcome" | "fixtures" | "app_url">,
  scope: { workspace_id: string; project_id: string },
): Promise<string[]> {
  const userPrompt = `App URL: ${ctx.app_url}
Test instructions:
"""${ctx.instructions}"""
Expected outcome: ${ctx.expected_outcome ?? "(infer from instructions)"}
Known fixtures (data you may use): ${JSON.stringify(ctx.fixtures ?? {})}

Produce a concise ordered plan of high-level steps (intents) to execute this test in a browser.
Respond as JSON: { "plan": ["...", "..."] }`;
  try {
    let res;
    try {
      res = await callAi({
        task: "json_extraction", systemPrompt: "You plan browser E2E tests. Output strict JSON only.",
        userPrompt, jsonMode: true, maxTokens: 600, provider: AGENT_PROVIDER, model: AGENT_MODEL,
      });
    } catch (_e) {
      res = await callAi({
        task: "json_extraction", systemPrompt: "You plan browser E2E tests. Output strict JSON only.",
        userPrompt, jsonMode: true, maxTokens: 600,
      });
    }
    logLlmUsage({ ...scope, provider: res.provider, model: res.model, task: "json_extraction", feature: "e2e_testing_plan", usage: res.usage });
    const parsed = safeParseJson<{ plan?: string[] }>(res.content);
    return Array.isArray(parsed?.plan) ? parsed!.plan!.slice(0, 20).map(String) : [];
  } catch {
    return [];
  }
}

// Decide the next concrete browser action from the current observation.
export async function decideNextAction(
  ctx: RunContext,
  scope: { workspace_id: string; project_id: string },
): Promise<BrowserAction> {
  const dom = (ctx.dom_excerpt ?? "").slice(0, 8000);
  const latestAnswer = ctx.user_answers.length ? ctx.user_answers[ctx.user_answers.length - 1] : null;
  const userPrompt = `Test instructions:
"""${ctx.instructions}"""
Expected outcome: ${ctx.expected_outcome ?? "(infer)"}
Test data (fixtures): ${JSON.stringify(ctx.fixtures ?? {})}
${latestAnswer ? `\n>>> THE USER JUST TOLD YOU WHAT TO DO NEXT — FOLLOW THIS NOW:\n"${latestAnswer}"\nFind the element in the snapshot that matches this instruction (match by its visible label/text) and act on its ref. Do not ask again.\n` : ""}${ctx.user_answers.length > 1 ? `Earlier user answers: ${JSON.stringify(ctx.user_answers.slice(0, -1))}\n` : ""}
Current URL: ${ctx.current_url ?? ctx.app_url}
Steps already taken (most recent last):
${ctx.history.slice(-15).map((h, i) => `${i + 1}. ${h.kind}${h.label ? ` — ${h.label}` : ""}`).join("\n") || "(none yet)"}

Current page snapshot — interactive elements are numbered; act with "ref":
"""${dom || "(empty — page may not be loaded yet; consider navigate)"}"""

Decide the single next action as strict JSON. When the user gave an instruction above, pick the ref whose label best matches it.`;
  // Run on the configured agent provider/model; fall back to task routing if it
  // is unavailable so a run never hard-fails.
  let res;
  try {
    res = await callAi({
      task: "json_extraction", systemPrompt: SYSTEM, userPrompt,
      jsonMode: true, maxTokens: 500, temperature: 0.1, provider: AGENT_PROVIDER, model: AGENT_MODEL,
    });
  } catch (_e) {
    res = await callAi({
      task: "json_extraction", systemPrompt: SYSTEM, userPrompt,
      jsonMode: true, maxTokens: 500, temperature: 0.1,
    });
  }
  logLlmUsage({ ...scope, provider: res.provider, model: res.model, task: "json_extraction", feature: "e2e_testing_action", usage: res.usage });
  const action = safeParseJson<BrowserAction>(res.content);
  if (!action || !action.type) {
    return { type: "ask_user", question: "I couldn't determine the next step. What should I do next?", reason: "agent returned no action" };
  }

  // Guard: don't let the agent only talk. If the last 2 steps were already
  // "say", force it to act (drop the say and re-decide would be costly, so we
  // just nudge by turning a 3rd consecutive say into a wait, prompting action
  // on the next turn).
  if (action.type === "say") {
    const tail = ctx.history.slice(-2);
    if (tail.length === 2 && tail.every((h) => h.kind === "say")) {
      return { type: "wait", amount: 300, reason: "continuing after explanation" };
    }
  }

  // Guard: a fill with no value means the agent lacks data — ask the user
  // instead of looping on an empty field.
  if (action.type === "fill" && !String(action.value ?? "").trim()) {
    const field = action.selector ?? "this field";
    return {
      type: "ask_user",
      question: `What value should I enter for ${field}?`,
      reason: "fill requested without a value",
    };
  }

  // Loop guard — but ONLY count actions taken since the last user answer. A
  // fresh directive resets the loop detector, so the agent gets to act on it
  // instead of immediately re-asking the same "I'm stuck" question.
  let lastAnswerIdx = -1;
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    if (ctx.history[i].kind === "user_answer") { lastAnswerIdx = i; break; }
  }
  const sinceAnswer = ctx.history.slice(lastAnswerIdx + 1);
  const recentAgent = sinceAnswer
    .filter((h) => ["fill", "click", "select", "press"].includes(h.kind))
    .slice(-5);
  const sameRepeats = recentAgent.filter(
    (h) => h.kind === action.type && (h.label ?? "") === (action.reason ?? action.selector ?? ""),
  ).length;
  // Only trip after the agent has actually tried several times on its own
  // (i.e. not right after a user directive).
  if (recentAgent.length >= 5 && (new Set(recentAgent.map((h) => h.label ?? h.kind)).size <= 1 || sameRepeats >= 4)) {
    return {
      type: "ask_user",
      question: "I'm not making progress here. Can you tell me exactly which element to click or what to do next?",
      reason: "possible loop detected",
    };
  }
  return action;
}

// Append a step to the run timeline and return its index.
export async function appendStep(
  admin: Admin,
  runId: string,
  step: {
    actor: "agent" | "runner" | "user" | "system";
    kind: string;
    label?: string | null;
    payload?: Record<string, unknown>;
    screenshot_url?: string | null;
    status?: string;
  },
): Promise<number> {
  const { data: last } = await admin
    .from("test_run_steps").select("idx").eq("run_id", runId)
    .order("idx", { ascending: false }).limit(1).maybeSingle();
  const idx = (last?.idx ?? -1) + 1;
  await admin.from("test_run_steps").insert({
    run_id: runId, idx,
    actor: step.actor, kind: step.kind, label: step.label ?? null,
    payload: step.payload ?? {}, screenshot_url: step.screenshot_url ?? null,
    status: step.status ?? "done",
  });
  return idx;
}

// Map a BrowserAction to a timeline step kind + label for display.
export function actionToStep(a: BrowserAction): { kind: string; label: string } {
  if (a.type === "say") return { kind: "say", label: a.message ?? a.reason ?? "" };
  switch (a.type) {
    case "navigate": return { kind: "navigate", label: a.value ? `Go to ${a.value}` : "Navigate" };
    case "click": return { kind: "click", label: a.reason ?? `Click ${a.selector ?? ""}`.trim() };
    case "fill": return { kind: "fill", label: a.reason ?? `Fill ${a.selector ?? "field"}` };
    case "select": return { kind: "select", label: a.reason ?? `Select ${a.value ?? ""}` };
    case "scroll": return { kind: "scroll", label: `Scroll ${a.direction ?? "down"}` };
    case "press": return { kind: "press", label: `Press ${a.key ?? "Enter"}` };
    case "wait": return { kind: "wait", label: `Wait ${a.amount ?? 500}ms` };
    case "assert": return { kind: "assert", label: a.assertion ?? "Assert" };
    case "ask_user": return { kind: "ask_user", label: a.question ?? "Need input" };
    case "pass": return { kind: "pass", label: a.assertion ?? "Test passed" };
    case "fail": return { kind: "fail", label: a.assertion ?? a.reason ?? "Test failed" };
    default: return { kind: "info", label: a.reason ?? a.type };
  }
}
