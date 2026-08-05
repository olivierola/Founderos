// Parallel sub-agents (multitasking) — SHARED engine.
//
// A primary run fans INDEPENDENT subtasks out to ephemeral child runs (clones of
// the same agent) that execute concurrently, in-process. Each child gets its own
// internal_agent_runs row (run_kind='subagent', parent_run_id set) and streams
// tool_call/tool_result events to its run_id, so its live flow can be watched
// individually and its row remains as the trace once finished.
//
// The caller injects the world-specific bits (how to build a child tool context
// and its system prompt), so the SAME engine powers both the agent chat/mission
// runtime (internal-agent-run) and rooms (service-room-post).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { callAiWithTools, type ChatMessage, type EndpointOverride } from "./ai.ts";
import { buildInternalToolset, type AgentToolRow, type InternalToolContext } from "./internal-agent-tools.ts";

/** How many sub-agents run CONCURRENTLY per wave; the rest run in later waves.
 *  Bounds concurrent LLM load (NOT the total number of sub-agents). Kept modest
 *  because too many concurrent completions rate-limit the provider (429) and the
 *  children then fail with 0 actions — the total is still unbounded via waves. */
export const SUBAGENT_MAX = 6;
const SUBAGENT_ROUNDS = 6;
// Total sub-agents accepted in a single fan-out. No practical limit for real
// tasks (source N products, analyse N entities) — this is only a fork-bomb
// backstop against a hallucinated giant fan-out. Recursion is already prevented
// (a sub-agent can't spawn), so a parent fanning out N independent items is safe.
const SUBAGENT_TOTAL_CAP = 100;

export interface Subtask {
  label: string;
  brief: string;
  acceptance?: string;
}

export interface SubagentDeps {
  admin: SupabaseClient;
  /** Parent run the children attach to (parent_run_id). */
  parentRunId: string;
  agentId: string;
  workspaceId: string;
  projectId: string;
  createdBy: string | null;
  tools: AgentToolRow[];
  provider: "groq" | "deepseek";
  endpoint?: EndpointOverride;
  model?: string;
  temperature: number;
  /** Emit a status marker on the PARENT run (optional). */
  parentLogEvent?: (payload: Record<string, unknown>) => Promise<void>;
  /** Build a child InternalToolContext bound to childRunId, flagged isSubagent
   *  (so it can't fan out again). The caller decides the world (sandbox vs
   *  cloud), skills, mcp, etc. */
  makeChildContext: (childRunId: string) => InternalToolContext;
  /** Build the child's system prompt from its capability summary. */
  buildChildSystem: (capabilitySummary: string, childCtx: InternalToolContext) => string;
  /** Owner-configured wave size (how many run at once). Clamped to [2, SUBAGENT_MAX].
   *  Omitted → SUBAGENT_MAX. */
  maxConcurrency?: number;
}

function compactEventArgs(a: unknown): unknown {
  if (!a || typeof a !== "object") return a;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > 700 ? `${v.slice(0, 700)}… (+${v.length - 700} chars)` : v;
  }
  return out;
}

async function runOne(deps: SubagentDeps, subtask: Subtask): Promise<{ label: string; output: string; ok: boolean }> {
  const label = subtask.label.slice(0, 120);
  const { admin } = deps;
  const emit = (p: Record<string, unknown>) => (deps.parentLogEvent ? deps.parentLogEvent(p).catch(() => {}) : Promise.resolve());

  // Child run row — drives the instance card + is the durable trace.
  const { data: child, error: insErr } = await admin.from("internal_agent_runs").insert({
    agent_id: deps.agentId, workspace_id: deps.workspaceId, project_id: deps.projectId,
    mission_id: null, parent_run_id: deps.parentRunId, run_kind: "subagent", label, is_ephemeral: true,
    status: "running", started_at: new Date().toISOString(), triggered_by: deps.createdBy ?? null,
  }).select("id").single();
  if (insErr || !child) return { label, output: `ERROR: could not start sub-agent (${insErr?.message ?? "no row"})`, ok: false };
  const childRunId = (child as { id: string }).id;
  await emit({ type: "subagent_spawned", child_run_id: childRunId, label });

  // Stream the child's actions to its own run_id so the flow view works in
  // every world (independent of the child ctx's own logEvent behaviour).
  const logChild = async (kind: string, payload: Record<string, unknown>) => {
    await admin.from("internal_agent_run_events").insert({ run_id: childRunId, agent_id: deps.agentId, kind, payload }).then(() => {}, () => {});
  };

  const childCtx = deps.makeChildContext(childRunId);
  const { defs, executor, capabilitySummary } = buildInternalToolset(deps.tools, childCtx);
  const loggingExecutor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    await logChild("tool_call", { tool: name, args: compactEventArgs(args) });
    const r = await executor(name, args);
    const text = String(r);
    await logChild("tool_result", { tool: name, preview: text.slice(0, 1000), ok: !text.startsWith("ERROR") });
    return r;
  };

  const system = deps.buildChildSystem(capabilitySummary, childCtx);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        "You are a FOCUSED PARALLEL SUB-AGENT. Execute ONLY the single subtask below, fully, using your tools, then finish with a concise markdown summary of the result (and any deliverable you produced). You do not see the parent conversation or the other sub-agents — be self-contained. Do NOT attempt to spawn further sub-agents.\n\n" +
        `## Subtask: ${label}\n${subtask.brief}${subtask.acceptance ? `\n\nDone when: ${subtask.acceptance}` : ""}`,
    },
  ];

  try {
    const result = await callAiWithTools({
      provider: deps.provider, model: deps.model, endpoint: deps.endpoint,
      messages, tools: defs, executor: loggingExecutor,
      temperature: deps.temperature, maxTokens: 4000, maxRounds: SUBAGENT_ROUNDS,
      onNotice: async (n) => { await logChild("tool_error", { message: n.message, detail: n.detail }); },
    });
    const output = (result.content ?? "").trim() || "(sub-agent produced no textual result)";
    await admin.from("internal_agent_runs").update({
      status: "succeeded", final_output: output.slice(0, 12000), finished_at: new Date().toISOString(),
      action_count: result.toolCalls.length, tokens_in: result.usage.prompt_tokens ?? 0, tokens_out: result.usage.completion_tokens ?? 0,
    }).eq("id", childRunId);
    await emit({ type: "subagent_done", child_run_id: childRunId, label, ok: true });
    return { label, output, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("internal_agent_runs").update({ status: "failed", error_message: msg.slice(0, 500), finished_at: new Date().toISOString() }).eq("id", childRunId);
    await emit({ type: "subagent_done", child_run_id: childRunId, label, ok: false });
    return { label, output: `ERROR: ${msg}`, ok: false };
  }
}

/** Run the subtasks as parallel sub-agents (waves of SUBAGENT_MAX) and return a
 *  digest of every result for the parent to synthesise. */
export async function runParallelSubagents(deps: SubagentDeps, subtasks: Subtask[]): Promise<string> {
  const capped = subtasks.slice(0, SUBAGENT_TOTAL_CAP);
  // Wave size = the owner's swarm_max_concurrency, never above the engine cap.
  const waveSize = Math.min(Math.max(deps.maxConcurrency ?? SUBAGENT_MAX, 2), SUBAGENT_MAX);
  if (deps.parentLogEvent) {
    await deps.parentLogEvent({ message: `🧩 ${capped.length} sous-agents lancés en parallèle : ${capped.map((s) => s.label).join(" · ")}` }).catch(() => {});
  }

  const runWaves = async (tasks: Subtask[]): Promise<Array<{ label: string; output: string; ok: boolean }>> => {
    const acc: Array<{ label: string; output: string; ok: boolean }> = [];
    for (let i = 0; i < tasks.length; i += waveSize) {
      const wave = tasks.slice(i, i + waveSize);
      const settled = await Promise.allSettled(wave.map((st) => runOne(deps, st)));
      settled.forEach((s, j) => {
        if (s.status === "fulfilled") acc.push(s.value);
        else acc.push({ label: wave[j]!.label, output: `ERROR: ${String(s.reason).slice(0, 300)}`, ok: false });
      });
    }
    return acc;
  };

  let results = await runWaves(capped);
  // Resilience: a child that failed with 0 actions is almost always transient
  // (a 429 under concurrent load). Retry the failures ONCE, then keep whatever
  // stuck — so a momentary rate-limit doesn't force the parent to re-spawn the
  // whole batch (which is what produced duplicate fan-outs).
  const failedTasks = results.filter((r) => !r.ok).map((r) => capped.find((c) => c.label.slice(0, 120) === r.label)).filter(Boolean) as Subtask[];
  if (failedTasks.length > 0) {
    if (deps.parentLogEvent) await deps.parentLogEvent({ message: `↻ ${failedTasks.length} sous-agent(s) en échec — nouvelle tentative unique.` }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const retried = await runWaves(failedTasks);
    const byLabel = new Map(retried.map((r) => [r.label, r]));
    results = results.map((r) => (!r.ok && byLabel.has(r.label) && byLabel.get(r.label)!.ok ? byLabel.get(r.label)! : r));
  }

  const okCount = results.filter((r) => r.ok).length;
  const digest = results.map((r) => `### ${r.ok ? "✓" : "✗"} ${r.label}\n${r.output}`).join("\n\n");
  return `Parallel sub-agents finished — ${okCount}/${results.length} succeeded. Synthesise their results into a single coherent answer for the user (don't just paste them verbatim):\n\n${digest}`;
}
