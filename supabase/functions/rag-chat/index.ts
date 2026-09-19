// rag-chat — answer a question using the agent's vectorized knowledge base.
// Auth modes:
//   - Authenticated (playground): { workspace_id, project_id, agent_id, message, conversation_id? }
//   - Public widget: { public_key, message, conversation_id?, visitor_id? }  (no JWT)
// Embeds the question with Jina, matches chunks via pgvector, answers with the LLM,
// and logs the conversation + messages.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { callerIp, enforceRateLimit } from "../_shared/rate-limit.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { embedTexts, toVectorLiteral } from "../_shared/jina.ts";
import { callAi, callAiWithTools } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import { loadPublicAgentTools } from "../_shared/public-agent-mcp.ts";
import { judgeTurn, visitorContext } from "../_shared/public-agent-telemetry.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  // Set as soon as the body is read: the catch below must know whether it is
  // answering a shopper on someone's storefront or a developer in the
  // playground, and it cannot re-read the consumed request body.
  let isPublicCaller = false;
  // Départ du chrono de première réponse : mesuré depuis l'entrée dans la
  // fonction, ce qui inclut l'embedding et la recherche vectorielle — le
  // visiteur, lui, attend tout ça.
  const startedAt = Date.now();
  // Renseigné dès qu'une conversation existe, pour que le catch puisse la
  // marquer « sans réponse » plutôt que de la laisser dans un état muet.
  let telemetryConvId: string | null = null;
  try {
    const body = await req.json();
    const { public_key, message, conversation_id, visitor_id, rating } = body;
    isPublicCaller = !!public_key;

    const admin = createServiceClient();

    // Rating-only call — the widget's 👍/👎 control. Folded in here rather than
    // given its own function (the project sits at the Supabase function cap).
    // Scoped through the agent so an anon caller can only rate a conversation
    // that belongs to the agent whose public key it holds.
    if (rating != null) {
      if (!public_key || !conversation_id) {
        return jsonResponse({ error: "public_key and conversation_id required" }, { status: 400 });
      }
      const score = Math.round(Number(rating));
      if (!Number.isFinite(score) || score < 1 || score > 5) {
        return jsonResponse({ error: "rating must be 1..5" }, { status: 400 });
      }
      const { data: rated } = await admin
        .from("rag_agents").select("id").eq("public_key", public_key).maybeSingle();
      if (!rated) return jsonResponse({ error: "Agent not found" }, { status: 404 });
      await admin.from("rag_conversations")
        .update({ rating: score, rated_at: new Date().toISOString() })
        .eq("id", conversation_id).eq("agent_id", rated.id);
      return jsonResponse({ ok: true });
    }

    if (!message) return jsonResponse({ error: "message required" }, { status: 400 });

    // FOS-15 — le widget est anonyme et chaque tour appelle un LLM : sans
    // plafond, une boucle sur la clé publique d'un agent facture son
    // propriétaire aussi longtemps qu'elle tourne. Deux dimensions, parce
    // qu'aucune ne suffit seule : la clé publique borne le coût total d'un
    // agent, l'IP empêche un visiteur de consommer à lui seul ce plafond.
    if (public_key) {
      const perAgent = await enforceRateLimit(
        { scope: "ragchat:agent", identity: String(public_key), limit: 120, windowSeconds: 60 },
      );
      if (perAgent) return perAgent;
      const perVisitor = await enforceRateLimit(
        { scope: "ragchat:ip", identity: `${public_key}:${callerIp(req)}`, limit: 20, windowSeconds: 60 },
      );
      if (perVisitor) return perVisitor;
    }

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
      // …et l'agent DOIT appartenir à ce workspace. Sans ce second filtre, le
      // contrôle ci-dessus ne prouve rien : l'appelant passe son propre
      // workspace_id (dont il est bien membre) avec l'agent_id d'un autre
      // client, et repart avec sa persona, ses instructions et — question après
      // question via match_rag_chunks — toute sa base documentaire (FOS-09).
      const { data } = await admin
        .from("rag_agents").select("*")
        .eq("id", agent_id).eq("workspace_id", workspace_id).maybeSingle();
      agent = data;
      source = "playground";
    }
    if (!agent) return jsonResponse({ error: "Agent not found" }, { status: 404 });

    // Embed the query and retrieve the most relevant chunks.
    const [queryVec] = await embedTexts([String(message)], "retrieval.query", {
      workspace_id: agent.workspace_id ?? null,
      project_id: agent.project_id ?? null,
      feature: "rag-chat",
    });
    const { data: matches } = await admin.rpc("match_rag_chunks", {
      p_agent_id: agent.id,
      p_query_embedding: toVectorLiteral(queryVec ?? []),
      p_match_count: 6,
    });
    const chunks = (matches ?? []) as { id: string; content: string; source_id: string; similarity: number }[];

    const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");

    // The conversation is opened BEFORE the model runs: a tool call made during
    // this turn is audited against it, and an audit row that can't say which
    // conversation caused it is of little use.
    let convId = conversation_id as string | undefined;
    // Rang du tour : sert à distinguer « répondu du premier coup » de « le
    // visiteur a dû reformuler quatre fois ». Sur une conversation neuve, 1.
    let turnIndex = 1;
    if (!convId) {
      const { data: conv } = await admin
        .from("rag_conversations")
        .insert({
          workspace_id: agent.workspace_id, project_id: agent.project_id, agent_id: agent.id,
          visitor_id: visitor_id ?? null, source,
          ...visitorContext(req, body),
        })
        .select("id")
        .single();
      convId = conv?.id;
    } else {
      const { data: prev } = await admin
        .from("rag_conversations")
        .select("user_message_count").eq("id", convId).eq("agent_id", agent.id).maybeSingle();
      turnIndex = (prev?.user_message_count ?? 0) + 1;
    }
    telemetryConvId = convId ?? null;

    // MCP tools the merchant has granted this agent (catalogue search, cart,
    // whatever the attached servers expose). Empty for a plain RAG agent, which
    // then takes the single-completion path below.
    const mcp = agent.tool_use_enabled
      ? await loadPublicAgentTools(
          admin,
          {
            id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
            max_tool_calls: agent.max_tool_calls, storefront_url: agent.storefront_url,
          },
          { conversationId: convId ?? null, visitorId: visitor_id ?? null },
        )
      : null;
    const hasTools = !!mcp && mcp.tools.length > 0;

    const systemPrompt = `${agent.persona ? agent.persona + "\n" : ""}You are ${agent.name}, an assistant for this product.
${hasTools
  ? `Answer using the context below AND the live tools you have been given (${mcp!.serverNames.join(", ")}).
Use a tool whenever the answer depends on live data — the catalogue, stock, prices, a cart. Never invent a product, a price or a stock level: if a tool can tell you, call it; if none can, say so.
Any product you return is ALSO shown to the customer as a card below your reply, so introduce your selection in a sentence instead of re-listing every price.
Never perform an action that changes the customer's cart or data unless they clearly asked for it in this conversation.`
  : `Answer ONLY using the context below. If the answer isn't in the context, say you don't have that information and suggest where the user might look.`}
Be concise and helpful.${agent.onboarding_enabled ? " When relevant, guide the user step by step through the product UI (pages, buttons)." : ""}
${agent.instructions ? "\nExtra instructions: " + agent.instructions : ""}

Context:
${context || "(no knowledge indexed yet)"}`;

    let answer: string;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    let provider: string;
    let model: string;

    if (hasTools) {
      // DeepSeek handles native tool-calling reliably; Groq/Llama frequently
      // emits malformed tool calls, and callAiWithTools defaults to Groq —
      // whose llama-3.3-70b-versatile this project no longer has access to.
      // Same preference as ai-agent-chat: DeepSeek when its key exists.
      const toolProvider: "groq" | "deepseek" =
        Deno.env.get("DEEPSEEK_API_KEY") ? "deepseek" : "groq";
      const run = await callAiWithTools({
        provider: toolProvider,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: String(message) },
        ],
        tools: mcp!.tools,
        executor: mcp!.executor,
        // Bounded per agent: a widget turn must stay a chat turn, not a run.
        maxRounds: Math.min(Math.max(Number(agent.max_tool_calls) || 4, 1), 10),
        maxTokens: 900,
        temperature: Number(agent.temperature ?? 0.3),
      });
      answer = run.content;
      usage = run.usage;
      provider = run.provider;
      model = run.model;
    } else {
      const ai = await callAi({
        task: agent.model === "deepseek" ? "code_analysis" : "chat_simple",
        systemPrompt,
        userPrompt: String(message),
        maxTokens: 700,
        temperature: Number(agent.temperature ?? 0.3),
      });
      answer = ai.content;
      usage = ai.usage;
      provider = ai.provider;
      model = ai.model;
    }

    await logLlmUsage({
      workspace_id: agent.workspace_id, project_id: agent.project_id,
      provider, model, task: "rag_chat", feature: "rag-agent", usage,
    });
    if (convId) {
      // Le verdict du tour (migration 0217). Écrit avec les mêmes signaux que
      // ceux rendus au visiteur : les chunks réellement cités, les outils
      // réellement joués. Un échec d'écriture ici ne doit jamais coûter la
      // réponse au visiteur, d'où le catch silencieux.
      const verdict = judgeTurn({
        message: String(message),
        groundedChunks: chunks.length,
        toolCalls: mcp?.stats.calls ?? 0,
        toolErrors: mcp?.stats.errors ?? 0,
        turnIndex,
        firstResponseMs: Date.now() - startedAt,
      });
      await admin.rpc("rag_conversation_record_turn", {
        p_conversation: convId,
        p_grounded: chunks.length > 0,
        p_tool_calls: mcp?.stats.calls ?? 0,
        p_first_response_ms: Date.now() - startedAt,
        p_outcome: verdict.outcome,
        p_outcome_reason: verdict.reason,
      }).then(() => {}, (e: unknown) => console.error("[rag-chat] telemetry", e));

      await admin.from("rag_messages").insert([
        { conversation_id: convId, agent_id: agent.id, role: "user", content: String(message) },
        {
          conversation_id: convId, agent_id: agent.id, role: "assistant", content: answer,
          sources: chunks.map((c) => ({ source_id: c.source_id, similarity: Number(c.similarity?.toFixed?.(3) ?? 0) })),
        },
      ]);
    }

    return jsonResponse({
      ok: true,
      answer,
      conversation_id: convId,
      sources: chunks.map((c) => ({ similarity: c.similarity, snippet: c.content.slice(0, 160) })),
      // Harvested from the MCP tool results and rendered as cards by the widget;
      // the model was told they are already on screen, so it summarises instead
      // of listing them.
      products: mcp?.products ?? [],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Une question posée qui n'a produit aucune réponse : c'est une issue en
    // soi, et la masquer ferait mentir le taux de résolution vers le haut.
    // `is("outcome", null)` : seule une conversation qui n'a JAMAIS abouti est
    // marquée ainsi — un pépin au cinquième tour ne réécrit pas quatre échanges
    // réussis.
    if (telemetryConvId) {
      await createServiceClient()
        .from("rag_conversations")
        .update({ outcome: "abandoned", outcome_reason: "error", last_message_at: new Date().toISOString() })
        .eq("id", telemetryConvId).is("outcome", null)
        .then(() => {}, () => {});
    }
    // The public widget renders whatever comes back in a chat bubble on a
    // customer's own site. Upstream provider errors ("model X does not exist",
    // key names, endpoints) are internal plumbing and must not surface there;
    // the playground, which is authenticated, still gets the real message.
    console.error("[rag-chat]", detail);
    return jsonResponse(
      isPublicCaller
        ? { error: "Le service est momentanément indisponible. Merci de réessayer dans un instant." }
        : { error: detail },
      { status: 500 },
    );
  }
});
