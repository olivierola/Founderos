// internal-agent-run — execute an internal (autonomous) agent in "chat" or
// "mission" mode.
//
// Body: { agent_id, mode: "chat" | "mission", conversation_id?, run_id? }
//
// v2: a real agentic loop. The agent's granted tools (internal_agent_tools)
// are compiled into executable tool definitions and the LLM iterates —
// searching the web, reading URLs, querying allowlisted project tables,
// searching the RAG knowledge base, invoking edge functions / webhooks — until
// the task is done or a budget is hit. Compared to v1:
//
//   - Tools are EXECUTED (v1 only mentioned them in the prompt).
//   - Every step is appended to internal_agent_run_events → live timeline.
//   - Runs can be cancelled mid-flight (status flips to 'cancelled').
//   - Per-agent budgets: max_steps bounds the loop, max_run_cost_usd marks
//     over-budget runs.
//   - Sensitive tools (requires_approval) are queued as approvals instead of
//     executing; internal-agent-approve runs them after a human decision.
//   - Deliverables are materialised by the agent itself via create_deliverable.
//   - Callers are authenticated: a user JWT must carry agent access; the
//     scheduler authenticates with the service-role key.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAiWithTools, type ChatMessage } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import {
  buildInternalToolset, RunCancelledError,
  type AgentToolRow, type InternalToolContext,
} from "../_shared/internal-agent-tools.ts";

interface AgentRow {
  id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  model: string;
  temperature: number;
  max_steps: number;
  max_run_cost_usd: number;
  workspace_id: string;
  project_id: string;
  is_archived: boolean;
}

// Rough per-1k-token rates (USD). Adjust as providers change pricing.
const RATES: Record<string, { in: number; out: number }> = {
  groq: { in: 0.00005, out: 0.0001 },
  deepseek: { in: 0.00014, out: 0.00028 },
};
function estimateCost(
  usage: { prompt_tokens: number; completion_tokens: number } | undefined,
  provider: "groq" | "deepseek",
): number {
  if (!usage) return 0;
  const r = RATES[provider] ?? { in: 0, out: 0 };
  return (usage.prompt_tokens * r.in + usage.completion_tokens * r.out) / 1000;
}

function providerFor(agent: AgentRow): "groq" | "deepseek" {
  return agent.model === "deepseek" ? "deepseek" : "groq";
}

function buildSystemPrompt(
  agent: AgentRow,
  capabilitySummary: string,
  mode: "chat" | "mission",
  memorySection: string,
): string {
  const lines: string[] = [];
  lines.push(`You are ${agent.persona || agent.name}, an autonomous internal agent for a SaaS team.`);
  if (agent.instructions) {
    lines.push("", "Your detailed instructions:", agent.instructions);
  }
  if (memorySection) {
    lines.push(
      "",
      "Your persistent memory (knowledge carried over from previous sessions and runs):",
      memorySection,
    );
  }
  lines.push(
    "",
    "Your capabilities (real, executable tools):",
    capabilitySummary,
    "",
    "Operating rules:",
    "- Use your tools to gather real data — never invent numbers or facts.",
    "- Some tools require human approval: calling them queues the action for review. Acknowledge the pending approval and keep going.",
    "- If a tool errors, adapt: try another approach or state the limitation clearly.",
    "- When you discover a durable fact, preference or lesson worth keeping, save it with save_memory (no transient details, no duplicates of the memory above).",
  );
  if (mode === "mission") {
    lines.push(
      "- Materialise every expected deliverable with create_deliverable before finishing.",
      "- Your final message is a concise mission report (markdown): what you did, key findings, deliverables produced, pending approvals if any.",
    );
  } else {
    lines.push("- Respond in concise markdown, in the user's language. Avoid filler.");
  }
  return lines.join("\n");
}

async function loadAgentAndTools(agentId: string) {
  const admin = createServiceClient();
  const [{ data: agent, error: agentErr }, { data: tools }] = await Promise.all([
    admin
      .from("internal_agents")
      .select("id, name, persona, instructions, model, temperature, max_steps, max_run_cost_usd, workspace_id, project_id, is_archived")
      .eq("id", agentId)
      .maybeSingle(),
    admin
      .from("internal_agent_tools")
      .select("id, kind, name, description, config, enabled, requires_approval")
      .eq("agent_id", agentId),
  ]);
  if (agentErr || !agent) throw new Error("Agent not found");
  if ((agent as AgentRow).is_archived) throw new Error("Agent is archived");
  return { agent: agent as AgentRow, tools: (tools ?? []) as AgentToolRow[] };
}

// Top-of-mind memory injected into every prompt: pinned first, then by
// importance and recency, capped so it can't crowd out the context window.
// The agent reaches older entries through search_memory.
async function loadMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<string> {
  const { data } = await admin
    .from("internal_agent_memories")
    .select("kind, content, importance, is_pinned")
    .eq("agent_id", agentId)
    .order("is_pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(25);
  if (!data || data.length === 0) return "";
  const lines: string[] = [];
  let budget = 3500;
  for (const m of data as Array<{ kind: string; content: string; importance: number; is_pinned: boolean }>) {
    const line = `- [${m.kind}${m.is_pinned ? ", pinned" : ""}] ${m.content}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

function nextRunAt(schedule: string, from: Date): string {
  const d = new Date(from);
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Tool context wiring
// ---------------------------------------------------------------------------

function makeToolContext(opts: {
  admin: ReturnType<typeof createServiceClient>;
  agent: AgentRow;
  runId: string | null;
  missionId: string | null;
  conversationId?: string | null;
}): InternalToolContext {
  const { admin, agent, runId, missionId } = opts;
  let lastCancelCheck = 0;
  let cancelled = false;
  return {
    admin,
    workspaceId: agent.workspace_id,
    projectId: agent.project_id,
    agentId: agent.id,
    runId,
    conversationId: opts.conversationId ?? null,
    createDeliverable: async (d) => {
      await admin.from("internal_agent_deliverables").insert({
        run_id: runId,
        mission_id: missionId,
        agent_id: agent.id,
        kind: d.kind,
        name: d.name,
        content: d.content,
        summary: d.summary,
      });
    },
    requestApproval: async (r) => {
      const { data, error } = await admin
        .from("internal_agent_approvals")
        .insert({
          agent_id: agent.id,
          run_id: runId,
          mission_id: missionId,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          tool_name: r.tool_name,
          action_kind: r.action_kind,
          payload: r.payload,
          reason: r.reason,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Could not queue approval: ${error.message}`);
      return (data as { id: string }).id;
    },
    logEvent: async (kind, payload) => {
      if (!runId) return;
      await admin.from("internal_agent_run_events").insert({
        run_id: runId,
        agent_id: agent.id,
        kind,
        payload,
      });
    },
    isCancelled: async () => {
      if (!runId || cancelled) return cancelled;
      // Throttle: at most one status check per 2s.
      const now = Date.now();
      if (now - lastCancelCheck < 2000) return false;
      lastCancelCheck = now;
      const { data } = await admin
        .from("internal_agent_runs")
        .select("status")
        .eq("id", runId)
        .maybeSingle();
      cancelled = data?.status === "cancelled";
      return cancelled;
    },
  };
}

// ---------------------------------------------------------------------------
// Chat mode
// ---------------------------------------------------------------------------

async function runChat(agent: AgentRow, tools: AgentToolRow[], conversationId: string) {
  const admin = createServiceClient();
  const { data: history } = await admin
    .from("internal_agent_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(30);

  const ctx = makeToolContext({ admin, agent, runId: null, missionId: null, conversationId });
  const { defs, executor, capabilitySummary } = buildInternalToolset(tools, ctx);
  const memorySection = await loadMemorySection(admin, agent.id);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(agent, capabilitySummary, "chat", memorySection) },
    ...(history ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];
  if (messages.length === 1) messages.push({ role: "user", content: "Greet the user." });

  const provider = providerFor(agent);
  const result = await callAiWithTools({
    provider,
    messages,
    tools: defs,
    executor,
    temperature: agent.temperature,
    maxTokens: 1500,
    maxRounds: Math.min(agent.max_steps, 6),
  });

  const cost = estimateCost(result.usage, provider);
  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId,
    agent_id: agent.id,
    role: "assistant",
    content: result.content?.trim() || "(no reply)",
    tool_calls: result.toolCalls,
    tokens_in: result.usage?.prompt_tokens ?? 0,
    tokens_out: result.usage?.completion_tokens ?? 0,
    cost_usd: cost,
  });

  // Bump the session so the conversation list sorts by recency.
  await admin
    .from("internal_agent_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  await logLlmUsage({
    workspace_id: agent.workspace_id,
    project_id: agent.project_id,
    provider: result.provider,
    model: result.model,
    task: "chat_simple",
    feature: "internal-agent-chat",
    usage: result.usage,
  });

  return jsonResponse({ ok: true, content: result.content, tool_calls: result.toolCalls.length });
}

// ---------------------------------------------------------------------------
// Mission mode
// ---------------------------------------------------------------------------

async function runMission(agent: AgentRow, tools: AgentToolRow[], runId: string) {
  const admin = createServiceClient();

  const { data: run } = await admin
    .from("internal_agent_runs")
    .select("id, mission_id, status")
    .eq("id", runId)
    .maybeSingle();
  if (!run) throw new Error("Run not found");
  // Idempotence: only a queued run may start (double invocations are no-ops).
  if (run.status !== "queued") {
    return jsonResponse({ ok: false, error: `Run is ${run.status}, not queued` }, { status: 409 });
  }

  const { data: mission } = await admin
    .from("internal_agent_missions")
    .select("id, title, brief, acceptance_criteria, expected_deliverables, schedule")
    .eq("id", run.mission_id)
    .maybeSingle();
  if (!mission) throw new Error("Mission not found");

  await admin
    .from("internal_agent_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", runId);

  const ctx = makeToolContext({ admin, agent, runId, missionId: mission.id });
  const { defs, executor, capabilitySummary } = buildInternalToolset(tools, ctx);
  await ctx.logEvent("log", { message: `Run started — budget: ${agent.max_steps} steps, $${agent.max_run_cost_usd}` });

  const memorySection = await loadMemorySection(admin, agent.id);

  // Continuity for re-runs (especially scheduled missions): show the agent
  // what its last successful run produced so it builds on it instead of
  // starting from scratch.
  const { data: prevRun } = await admin
    .from("internal_agent_runs")
    .select("finished_at, final_output")
    .eq("mission_id", mission.id)
    .eq("status", "succeeded")
    .neq("id", runId)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const previousRunSection = prevRun?.final_output
    ? `\n## Previous run (${prevRun.finished_at})\nYour last successful report for this mission, for continuity — focus on what changed since:\n${String(prevRun.final_output).slice(0, 2500)}\n`
    : "";

  const deliverablesSpec = (Array.isArray(mission.expected_deliverables) ? mission.expected_deliverables : [])
    .map((d: { kind: string; name: string; description?: string }) =>
      `- ${d.kind}: ${d.name}${d.description ? ` — ${d.description}` : ""}`)
    .join("\n");

  const userPrompt = `# Mission: ${mission.title}

## Brief
${mission.brief ?? "(no brief provided)"}

${mission.acceptance_criteria ? `## Acceptance criteria\n${mission.acceptance_criteria}\n` : ""}
${deliverablesSpec ? `## Expected deliverables\n${deliverablesSpec}\n` : ""}${previousRunSection}
Execute this mission now. Use your tools to gather what you need, save each expected deliverable with create_deliverable, then write your final mission report.`;

  const provider = providerFor(agent);
  try {
    const result = await callAiWithTools({
      provider,
      messages: [
        { role: "system", content: buildSystemPrompt(agent, capabilitySummary, "mission", memorySection) },
        { role: "user", content: userPrompt },
      ],
      tools: defs,
      executor,
      temperature: agent.temperature,
      maxTokens: 4000,
      maxRounds: agent.max_steps,
    });

    const cost = estimateCost(result.usage, provider);
    const finalOutput = result.content?.trim() || "(no final report)";

    await admin.from("internal_agent_run_events").insert({
      run_id: runId,
      agent_id: agent.id,
      kind: "llm_call",
      payload: {
        model: result.model,
        rounds: result.toolCalls.length,
        over_budget: cost > Number(agent.max_run_cost_usd),
      },
      tokens_in: result.usage?.prompt_tokens ?? 0,
      tokens_out: result.usage?.completion_tokens ?? 0,
      cost_usd: cost,
    });

    // Safety net: if the agent produced no deliverable, persist the report as one.
    const { count } = await admin
      .from("internal_agent_deliverables")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId);
    if (!count) {
      await admin.from("internal_agent_deliverables").insert({
        run_id: runId,
        mission_id: mission.id,
        agent_id: agent.id,
        kind: "markdown",
        name: "Mission output",
        content: finalOutput,
        summary: finalOutput.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null,
      });
    }

    await admin
      .from("internal_agent_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        final_output: finalOutput,
        tokens_in: result.usage?.prompt_tokens ?? 0,
        tokens_out: result.usage?.completion_tokens ?? 0,
        cost_usd: cost,
        action_count: result.toolCalls.length,
        steps: result.toolCalls.length,
      })
      .eq("id", runId);

    // Scheduling bookkeeping.
    const missionUpdate: Record<string, unknown> = { last_run_at: new Date().toISOString() };
    if (mission.schedule) missionUpdate.next_run_at = nextRunAt(mission.schedule, new Date());
    await admin.from("internal_agent_missions").update(missionUpdate).eq("id", mission.id);

    await logLlmUsage({
      workspace_id: agent.workspace_id,
      project_id: agent.project_id,
      provider: result.provider,
      model: result.model,
      task: "content_generation",
      feature: "internal-agent-mission",
      usage: result.usage,
    });

    return jsonResponse({ ok: true, run_id: runId, steps: result.toolCalls.length, cost_usd: cost });
  } catch (e) {
    if (e instanceof RunCancelledError) {
      await admin
        .from("internal_agent_runs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() })
        .eq("id", runId);
      await ctx.logEvent("status", { message: "Cancelled by user" }).catch(() => {});
      return jsonResponse({ ok: false, cancelled: true });
    }
    const msg = e instanceof Error ? e.message : String(e);
    await admin
      .from("internal_agent_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg })
      .eq("id", runId);
    await admin.from("internal_agent_run_events").insert({
      run_id: runId,
      agent_id: agent.id,
      kind: "error",
      payload: { error: msg },
    });
    return jsonResponse({ ok: false, error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const isService = token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const body = await req.json();
    const { agent_id, mode, conversation_id, run_id } = body as {
      agent_id?: string;
      mode?: string;
      conversation_id?: string;
      run_id?: string;
    };
    if (!agent_id || !mode) {
      return jsonResponse({ error: "Missing agent_id or mode" }, { status: 400 });
    }

    // Authenticated users must have access to this agent (creator or member).
    if (!isService) {
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const admin = createServiceClient();
      const { data: allowed } = await admin.rpc("has_internal_agent_access", {
        p_agent_id: agent_id,
        p_user_id: userData.user.id,
      });
      if (!allowed) return jsonResponse({ error: "Not authorized for this agent" }, { status: 403 });
    }

    const { agent, tools } = await loadAgentAndTools(agent_id);

    if (mode === "chat") {
      if (!conversation_id) return jsonResponse({ error: "conversation_id required for chat mode" }, { status: 400 });
      return await runChat(agent, tools, conversation_id);
    }
    if (mode === "mission") {
      if (!run_id) return jsonResponse({ error: "run_id required for mission mode" }, { status: 400 });
      return await runMission(agent, tools, run_id);
    }
    return jsonResponse({ error: "Unknown mode" }, { status: 400 });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
