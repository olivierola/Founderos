// internal-agent-a2a — make an agent react autonomously to a peer's message.
//
// Body: { message_id }  — the pending A2A message the recipient should process.
//
// The recipient runs a bounded agentic turn (its full toolset, including the
// collaboration tools, so it can in turn delegate, search, or reply). Its reply
// is persisted as an A2A message back to the sender, and the original message is
// marked answered/ignored. Triggered immediately on send (fire-and-forget) and
// also swept by the scheduler as a safety net.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAiWithTools, type ChatMessage } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import {
  buildInternalToolset, type AgentToolRow, type InternalToolContext,
} from "../_shared/internal-agent-tools.ts";

function authorized(req: Request): boolean {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!token && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (!authorized(req)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  try {
    const { message_id } = await req.json();
    if (!message_id) return jsonResponse({ error: "message_id required" }, { status: 400 });

    // Claim the message (pending → processing) atomically-ish to avoid double work.
    const { data: msg } = await admin
      .from("internal_agent_a2a_messages")
      .select("id, thread_id, from_agent, to_agent, content, status, workspace_id, project_id")
      .eq("id", message_id)
      .maybeSingle();
    if (!msg) return jsonResponse({ error: "Message not found" }, { status: 404 });
    if ((msg as any).status !== "pending") return jsonResponse({ ok: true, skipped: (msg as any).status });

    const { data: claimed } = await admin
      .from("internal_agent_a2a_messages")
      .update({ status: "processing" })
      .eq("id", message_id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) return jsonResponse({ ok: true, skipped: "already claimed" });

    const recipientId = (msg as any).to_agent as string;
    const senderId = (msg as any).from_agent as string;

    // Load recipient + its tools.
    const [{ data: agent }, { data: tools }, { data: sender }] = await Promise.all([
      admin.from("internal_agents")
        .select("id, name, persona, instructions, model, temperature, max_steps, workspace_id, project_id, is_archived, collaboration_enabled")
        .eq("id", recipientId).maybeSingle(),
      admin.from("internal_agent_tools")
        .select("id, kind, name, description, config, enabled, requires_approval")
        .eq("agent_id", recipientId),
      admin.from("internal_agents").select("name").eq("id", senderId).maybeSingle(),
    ]);
    if (!agent || (agent as any).is_archived || (agent as any).collaboration_enabled === false) {
      await admin.from("internal_agent_a2a_messages").update({ status: "ignored" }).eq("id", message_id);
      return jsonResponse({ ok: true, ignored: true });
    }
    const a = agent as any;

    // Recent thread history for context.
    const { data: history } = await admin
      .from("internal_agent_a2a_messages")
      .select("from_agent, content, created_at")
      .eq("thread_id", (msg as any).thread_id)
      .order("created_at", { ascending: true })
      .limit(12);

    // Top team memory for shared context.
    const { data: teamMem } = await admin
      .from("internal_agent_team_memories")
      .select("kind, content")
      .eq("project_id", a.project_id)
      .order("is_pinned", { ascending: false })
      .order("importance", { ascending: false })
      .limit(10);
    const teamMemSection = (teamMem ?? []).map((m: any) => `- [${m.kind}] ${m.content}`).join("\n");

    const ctx: InternalToolContext = {
      admin,
      workspaceId: a.workspace_id,
      projectId: a.project_id,
      agentId: a.id,
      agentName: a.name,
      collaborationEnabled: true,
      runId: null,
      conversationId: null,
      createDeliverable: async () => {},
      requestApproval: async (r) => {
        const { data } = await admin.from("internal_agent_approvals").insert({
          agent_id: a.id, workspace_id: a.workspace_id, project_id: a.project_id,
          tool_name: r.tool_name, action_kind: r.action_kind, payload: r.payload, reason: r.reason,
        }).select("id").single();
        return (data as { id: string }).id;
      },
      logEvent: async () => {},
      isCancelled: async () => false,
    };

    const { defs, executor, capabilitySummary } = buildInternalToolset(tools as AgentToolRow[], ctx);
    const senderName = (sender as any)?.name ?? "a teammate agent";

    const systemPrompt = `You are ${a.persona || a.name}, an autonomous internal agent working as part of a TEAM.
A teammate agent (${senderName}) has messaged you. React helpfully and autonomously:
- If you can answer or help directly, do so concisely.
- Use your tools (search, data, delegate, team_memory…) as needed.
- If the request is better handled by yet another agent, delegate it.
- Keep your reply focused — it goes straight to ${senderName}.
${a.instructions ? `\nYour instructions:\n${a.instructions}` : ""}
${teamMemSection ? `\nShared team memory:\n${teamMemSection}` : ""}

Your capabilities:
${capabilitySummary}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(history ?? []).map((h: any) => ({
        role: (h.from_agent === a.id ? "assistant" : "user") as "assistant" | "user",
        content: h.content,
      })),
    ];

    const provider = a.model === "deepseek" ? "deepseek" : "groq";
    const result = await callAiWithTools({
      provider,
      messages,
      tools: defs,
      executor,
      temperature: a.temperature ?? 0.3,
      maxTokens: 1200,
      maxRounds: Math.min(a.max_steps ?? 6, 5),
    });

    const reply = result.content?.trim();
    if (reply) {
      await admin.from("internal_agent_a2a_messages").insert({
        thread_id: (msg as any).thread_id,
        workspace_id: a.workspace_id,
        project_id: a.project_id,
        from_agent: a.id,
        to_agent: senderId,
        content: reply.slice(0, 4000),
        reply_to: message_id,
      });
      await admin.from("internal_agent_a2a_messages").update({ status: "answered" }).eq("id", message_id);
    } else {
      await admin.from("internal_agent_a2a_messages").update({ status: "ignored" }).eq("id", message_id);
    }
    await admin.from("internal_agent_a2a_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", (msg as any).thread_id);

    await logLlmUsage({
      workspace_id: a.workspace_id, project_id: a.project_id,
      provider: result.provider, model: result.model,
      task: "chat_simple", feature: "internal-agent-a2a", usage: result.usage,
    });

    return jsonResponse({ ok: true, replied: !!reply });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "a2a failed" }, { status: 500 });
  }
});
