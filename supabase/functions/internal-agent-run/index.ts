// internal-agent-run — execute an internal agent in either "chat" or "mission" mode.
//
// Body: { agent_id, mode: "chat" | "mission", conversation_id?, run_id? }
//
// Chat mode:
//   - Loads the conversation history + the agent's persona/instructions/tools
//   - Calls the LLM, persists the assistant message, returns it
//
// Mission mode:
//   - Loads the mission brief + acceptance criteria + expected deliverables
//   - Updates the run to "running", calls the LLM, writes events + final output
//   - Materialises deliverables based on the LLM's structured response
//
// This is the v1 worker: a single-shot LLM call. Tool execution (web search,
// DB read, edge function call) is left as a hook — when a tool is invoked
// by the LLM, we record it as an event but don't yet execute it.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";

interface AgentRow {
  id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  model: string;
  temperature: number;
  workspace_id: string;
  project_id: string;
}

interface ToolRow {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

// Rough per-1k-token rates (USD). Adjust as providers change pricing.
const RATES: Record<string, { in: number; out: number }> = {
  groq: { in: 0.00005, out: 0.0001 },
  deepseek: { in: 0.00014, out: 0.00028 },
};
function estimateCost(usage: { prompt_tokens: number; completion_tokens: number } | undefined, provider: "groq" | "deepseek"): number {
  if (!usage) return 0;
  const r = RATES[provider] ?? { in: 0, out: 0 };
  return (usage.prompt_tokens * r.in + usage.completion_tokens * r.out) / 1000;
}

function buildSystemPrompt(agent: AgentRow, tools: ToolRow[]): string {
  const lines: string[] = [];
  lines.push(`You are ${agent.persona || agent.name}, an internal agent for a SaaS agency.`);
  if (agent.instructions) {
    lines.push("");
    lines.push("Your detailed instructions:");
    lines.push(agent.instructions);
  }
  const enabledTools = tools.filter((t) => t.enabled);
  if (enabledTools.length > 0) {
    lines.push("");
    lines.push("Tools available to you (mention them by name when you need them):");
    for (const t of enabledTools) {
      lines.push(`- ${t.name} (${t.kind})${t.description ? ` — ${t.description}` : ""}`);
    }
    lines.push("Note: tool execution is not yet wired. Describe your intended tool calls in plain text and continue with your best reasoning.");
  }
  lines.push("");
  lines.push("Respond in concise markdown. Avoid filler.");
  return lines.join("\n");
}

async function loadAgentAndTools(agentId: string) {
  const admin = createServiceClient();
  const [{ data: agent, error: agentErr }, { data: tools }] = await Promise.all([
    admin
      .from("internal_agents")
      .select("id, name, persona, instructions, model, temperature, workspace_id, project_id")
      .eq("id", agentId)
      .maybeSingle(),
    admin
      .from("internal_agent_tools")
      .select("id, kind, name, description, config, enabled")
      .eq("agent_id", agentId),
  ]);
  if (agentErr || !agent) throw new Error("Agent not found");
  return { agent: agent as AgentRow, tools: (tools ?? []) as ToolRow[] };
}

async function runChat(agent: AgentRow, tools: ToolRow[], conversationId: string) {
  const admin = createServiceClient();
  // Load the recent message history (last 20).
  const { data: history } = await admin
    .from("internal_agent_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(20);

  const systemPrompt = buildSystemPrompt(agent, tools);
  const userMessages = (history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const result = await callAi({
    task: "chat_simple",
    systemPrompt,
    userPrompt: userMessages || "Greet the user.",
    temperature: agent.temperature,
    maxTokens: 1200,
  });

  // Persist assistant reply with cost accounting.
  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId,
    agent_id: agent.id,
    role: "assistant",
    content: result.content,
    tokens_in: result.usage?.prompt_tokens ?? 0,
    tokens_out: result.usage?.completion_tokens ?? 0,
    cost_usd: estimateCost(result.usage, result.provider),
  });

  return jsonResponse({ ok: true, content: result.content });
}

async function runMission(agent: AgentRow, tools: ToolRow[], runId: string) {
  const admin = createServiceClient();
  const startedAt = new Date().toISOString();
  await admin
    .from("internal_agent_runs")
    .update({ status: "running", started_at: startedAt })
    .eq("id", runId);

  // Load the mission.
  const { data: run } = await admin
    .from("internal_agent_runs")
    .select("mission_id")
    .eq("id", runId)
    .maybeSingle();
  if (!run) throw new Error("Run not found");

  const { data: mission } = await admin
    .from("internal_agent_missions")
    .select("title, brief, acceptance_criteria, expected_deliverables")
    .eq("id", run.mission_id)
    .maybeSingle();
  if (!mission) throw new Error("Mission not found");

  const systemPrompt = buildSystemPrompt(agent, tools);
  const deliverablesSpec = (mission.expected_deliverables ?? [])
    .map((d: any) => `- ${d.kind}: ${d.name}${d.description ? ` — ${d.description}` : ""}`)
    .join("\n");

  const userPrompt = `# Mission: ${mission.title}

## Brief
${mission.brief ?? "(no brief provided)"}

${mission.acceptance_criteria ? `## Acceptance criteria\n${mission.acceptance_criteria}\n` : ""}
${deliverablesSpec ? `## Expected deliverables\n${deliverablesSpec}\n` : ""}

Produce the mission output as a complete markdown document. After the document,
add a separator line "---DELIVERABLES---" followed by a JSON array describing
the deliverables you produced. Each entry: { "kind": "markdown"|"json"|"code", "name": string, "content": string }.`;

  try {
    const result = await callAi({
      task: "content_generation",
      systemPrompt,
      userPrompt,
      temperature: agent.temperature,
      maxTokens: 4000,
    });

    // Split final answer from deliverables block.
    const parts = result.content.split(/---DELIVERABLES---/i);
    const finalOutput = parts[0]?.trim() ?? result.content;
    let deliverables: Array<{ kind: string; name: string; content: string }> = [];
    if (parts.length > 1) {
      const jsonMatch = parts[1].match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try { deliverables = JSON.parse(jsonMatch[0]); } catch { /* ignore parse errors */ }
      }
    }

    // Record an LLM event.
    await admin.from("internal_agent_run_events").insert({
      run_id: runId,
      agent_id: agent.id,
      kind: "llm_call",
      payload: { model: result.model ?? agent.model },
      tokens_in: result.usage?.prompt_tokens ?? 0,
      tokens_out: result.usage?.completion_tokens ?? 0,
      cost_usd: estimateCost(result.usage, result.provider),
    });

    // Materialise each deliverable.
    for (const d of deliverables) {
      await admin.from("internal_agent_deliverables").insert({
        run_id: runId,
        mission_id: run.mission_id,
        agent_id: agent.id,
        kind: d.kind || "markdown",
        name: d.name || "Output",
        content: d.content || "",
      });
    }
    // If no deliverables were declared, store the whole answer as a single markdown deliverable.
    if (deliverables.length === 0) {
      await admin.from("internal_agent_deliverables").insert({
        run_id: runId,
        mission_id: run.mission_id,
        agent_id: agent.id,
        kind: "markdown",
        name: "Mission output",
        content: finalOutput,
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
        cost_usd: estimateCost(result.usage, result.provider),
        action_count: 1, // single LLM call for v1; will grow when tool loop lands
      })
      .eq("id", runId);

    return jsonResponse({ ok: true, run_id: runId });
  } catch (e: any) {
    await admin
      .from("internal_agent_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: e?.message ?? "Unknown error",
      })
      .eq("id", runId);
    await admin.from("internal_agent_run_events").insert({
      run_id: runId,
      agent_id: agent.id,
      kind: "error",
      payload: { error: e?.message ?? String(e) },
    });
    return jsonResponse({ ok: false, error: e?.message ?? "Run failed" }, { status: 500 });
  }
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const body = await req.json();
    const { agent_id, mode, conversation_id, run_id } = body;
    if (!agent_id || !mode) {
      return jsonResponse({ error: "Missing agent_id or mode" }, { status: 400 });
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
  } catch (e: any) {
    return jsonResponse({ error: e?.message ?? "Internal error" }, { status: 500 });
  }
});
