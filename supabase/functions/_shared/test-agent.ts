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

export interface BrowserAction {
  // What the runner should do next.
  type: "navigate" | "click" | "fill" | "select" | "scroll" | "press" | "wait"
      | "assert" | "ask_user" | "pass" | "fail";
  selector?: string;       // CSS/text selector for click/fill/select/assert
  value?: string;          // text to type, option to select, url to navigate
  key?: string;            // key for press (e.g. "Enter")
  direction?: "up" | "down"; // for scroll
  amount?: number;         // px for scroll, ms for wait
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

const SYSTEM = `You are an autonomous end-to-end test agent. You drive a real browser (Playwright) against a web app to verify a scenario.

You receive the test instructions, the current page URL and a trimmed DOM/accessibility snapshot. You decide ONE next action at a time.

Rules:
- Prefer robust selectors: visible text, roles, aria-labels, name/id attributes. Avoid brittle nth-child chains.
- Only fill data you were given (fixtures) or that the user provided. If you need information you don't have (a real OTP, a coupon, which of several options to pick), use "ask_user" with a precise question — do NOT invent secrets.
- Work in small steps. Navigate, then read the DOM, then act.
- When the expected outcome is clearly satisfied, return type "pass" with a one-line "assertion". If the app is in a state that proves the test failed, return "fail" with the reason.
- Never perform destructive actions beyond what the test asks.

Respond with STRICT JSON for the single next action, no prose:
{ "type": "...", "selector": "...", "value": "...", "key": "...", "direction": "...", "amount": 0, "question": "...", "assertion": "...", "reason": "..." }
Only include the fields relevant to the chosen type.`;

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
    const res = await callAi({
      task: "json_extraction",
      systemPrompt: "You plan browser E2E tests. Output strict JSON only.",
      userPrompt,
      jsonMode: true,
      maxTokens: 600,
    });
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
  const userPrompt = `Test instructions:
"""${ctx.instructions}"""
Expected outcome: ${ctx.expected_outcome ?? "(infer)"}
Fixtures: ${JSON.stringify(ctx.fixtures ?? {})}
${ctx.user_answers.length ? `User-provided answers so far: ${JSON.stringify(ctx.user_answers)}` : ""}

Current URL: ${ctx.current_url ?? ctx.app_url}
Steps already taken (most recent last):
${ctx.history.slice(-15).map((h, i) => `${i + 1}. ${h.kind}${h.label ? ` — ${h.label}` : ""}`).join("\n") || "(none yet)"}

Current DOM / accessibility snapshot (trimmed):
"""${dom || "(empty — page may not be loaded yet; consider navigate)"}"""

Decide the single next action as strict JSON.`;
  const res = await callAi({
    task: "json_extraction",
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    maxTokens: 400,
    temperature: 0.1,
  });
  logLlmUsage({ ...scope, provider: res.provider, model: res.model, task: "json_extraction", feature: "e2e_testing_action", usage: res.usage });
  const action = safeParseJson<BrowserAction>(res.content);
  if (!action || !action.type) {
    return { type: "ask_user", question: "I couldn't determine the next step. What should I do next?", reason: "agent returned no action" };
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
