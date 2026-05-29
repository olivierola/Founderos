// rag-chat — answer a question using the agent's vectorized knowledge base.
// Auth modes:
//   - Authenticated (playground): { workspace_id, project_id, agent_id, message, conversation_id? }
//   - Public widget: { public_key, message, conversation_id?, visitor_id? }  (no JWT)
// Embeds the question with Jina, matches chunks via pgvector, answers with the LLM,
// and logs the conversation + messages.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { embedTexts, toVectorLiteral } from "../_shared/jina.ts";
import { callAi } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const body = await req.json();
    const { public_key, message, conversation_id, visitor_id } = body;
    if (!message) return jsonResponse({ error: "message required" }, { status: 400 });

    const admin = createServiceClient();

    // Resolve the agent either by public_key (widget) or by id (authenticated).
    let agent: any = null;
    let source = "widget";
    if (public_key) {
      const { data } = await admin.from("rag_agents").select("*").eq("public_key", public_key).eq("enabled", true).maybeSingle();
      agent = data;
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData } = await userClient.auth.getUser();
      if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const { agent_id, workspace_id } = body;
      if (!agent_id) return jsonResponse({ error: "agent_id required" }, { status: 400 });
      // Membership check
      const { data: mem } = await admin
        .from("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
      if (!mem) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      const { data } = await admin.from("rag_agents").select("*").eq("id", agent_id).maybeSingle();
      agent = data;
      source = "playground";
    }
    if (!agent) return jsonResponse({ error: "Agent not found" }, { status: 404 });

    // Embed the query and retrieve the most relevant chunks.
    const [queryVec] = await embedTexts([String(message)], "retrieval.query");
    const { data: matches } = await admin.rpc("match_rag_chunks", {
      p_agent_id: agent.id,
      p_query_embedding: toVectorLiteral(queryVec ?? []),
      p_match_count: 6,
    });
    const chunks = (matches ?? []) as { id: string; content: string; source_id: string; similarity: number }[];

    const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");

    const systemPrompt = `${agent.persona ? agent.persona + "\n" : ""}You are ${agent.name}, an assistant for this product.
Answer ONLY using the context below. If the answer isn't in the context, say you don't have that information and suggest where the user might look.
Be concise and helpful.${agent.onboarding_enabled ? " When relevant, guide the user step by step through the product UI (pages, buttons)." : ""}
${agent.instructions ? "\nExtra instructions: " + agent.instructions : ""}

Context:
${context || "(no knowledge indexed yet)"}`;

    const ai = await callAi({
      task: agent.model === "deepseek" ? "code_analysis" : "chat_simple",
      systemPrompt,
      userPrompt: String(message),
      maxTokens: 700,
      temperature: Number(agent.temperature ?? 0.3),
    });

    await logLlmUsage({
      workspace_id: agent.workspace_id, project_id: agent.project_id,
      provider: ai.provider, model: ai.model, task: "rag_chat", feature: "rag-agent", usage: ai.usage,
    });

    // Persist conversation + messages.
    let convId = conversation_id as string | undefined;
    if (!convId) {
      const { data: conv } = await admin
        .from("rag_conversations")
        .insert({ workspace_id: agent.workspace_id, project_id: agent.project_id, agent_id: agent.id, visitor_id: visitor_id ?? null, source })
        .select("id")
        .single();
      convId = conv?.id;
    }
    if (convId) {
      await admin.from("rag_messages").insert([
        { conversation_id: convId, agent_id: agent.id, role: "user", content: String(message) },
        {
          conversation_id: convId, agent_id: agent.id, role: "assistant", content: ai.content,
          sources: chunks.map((c) => ({ source_id: c.source_id, similarity: Number(c.similarity?.toFixed?.(3) ?? 0) })),
        },
      ]);
    }

    return jsonResponse({
      ok: true,
      answer: ai.content,
      conversation_id: convId,
      sources: chunks.map((c) => ({ similarity: c.similarity, snippet: c.content.slice(0, 160) })),
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
