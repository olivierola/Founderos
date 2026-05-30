// rag-onboarding-orchestrate — the heart of dynamic onboarding.
//
// The end user's widget posts the current context (page, recent action,
// optional natural-language question). We retrieve the agent's app_structure
// (enriched) + persona + relevant RAG chunks and ask the LLM to produce both
// a friendly message and a list of UI commands the widget will execute.
//
// Body: {
//   agent_public_key,
//   visitor_id?: string,
//   external_user_id?: string,
//   context: {
//     route: string,                      // current page route
//     recent_event?: { type, data? },     // last app event the host emitted
//     question?: string,                   // optional user message
//     completed_intents?: string[],        // what the user already did this session
//   }
// }
//
// Response: {
//   text: string,                          // friendly explanation shown in the widget
//   actions: Array<                        // commands the widget executes in order
//     | { type: "highlight",  selector: string, message?: string, duration_ms?: number }
//     | { type: "popup",       title?: string, body: string, anchor_selector?: string }
//     | { type: "scroll_to",   selector: string }
//     | { type: "navigate",    route: string }
//     | { type: "tooltip",     selector: string, text: string }
//     | { type: "celebrate",   message?: string }
//     | { type: "wait_event",  event: string }
//   >,
//   next_intent?: string,
//   debug?: { tokens, model, retrieved_chunks }
// }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";
import { embedTexts, toVectorLiteral } from "../_shared/jina.ts";

interface OrchestrateBody {
  agent_public_key?: string;
  visitor_id?: string;
  external_user_id?: string;
  context?: {
    route?: string;
    recent_event?: { type: string; data?: unknown };
    question?: string;
    completed_intents?: string[];
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = (await req.json()) as OrchestrateBody;
    const { agent_public_key, visitor_id, external_user_id, context } = body;

    if (!agent_public_key) return jsonResponse({ error: "agent_public_key required" }, { status: 400 });
    if (!visitor_id && !external_user_id) {
      return jsonResponse({ error: "visitor_id or external_user_id required" }, { status: 400 });
    }
    if (!context) return jsonResponse({ error: "context required" }, { status: 400 });

    const admin = createServiceClient();

    /* 1) Resolve agent + project. */
    const { data: agent } = await admin
      .from("rag_agents")
      .select("id, workspace_id, project_id, persona, instructions, welcome_message, onboarding_enabled")
      .eq("public_key", agent_public_key)
      .maybeSingle();
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });
    if (!agent.onboarding_enabled) {
      return jsonResponse({ error: "Onboarding disabled for this agent" }, { status: 403 });
    }

    /* 2) Load the enriched app structure (latest scan). */
    const { data: scan } = await admin
      .from("scan_results")
      .select("app_structure")
      .eq("project_id", agent.project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const appStructure =
      (scan?.app_structure as { enriched?: Record<string, unknown> } | null)?.enriched ?? null;

    /* 3) Pull a small set of relevant RAG chunks for the question/route. */
    let chunks: Array<{ content: string; similarity: number }> = [];
    const queryText = context.question ?? `Guide the user on the page ${context.route}`;
    try {
      const [queryVec] = await embedTexts([queryText], "retrieval.query");
      const { data: matches } = await admin.rpc("match_rag_chunks", {
        p_agent_id: agent.id,
        p_query_embedding: toVectorLiteral(queryVec ?? []),
        p_match_count: 4,
      });
      chunks = (matches ?? []) as typeof chunks;
    } catch {
      /* non-fatal: agent can still answer from app_structure */
    }

    /* 4) Build the prompt — explicit JSON schema for the response. */
    const systemPrompt = `You are an in-product onboarding agent for a SaaS application.
${agent.persona ? `Persona: ${agent.persona}` : ""}
${agent.instructions ? `Extra instructions: ${agent.instructions}` : ""}

You drive the SaaS UI through a small set of commands. Your reply MUST be valid
JSON with this exact shape (no prose, no fences):

{
  "text": string,                       // 1-3 sentence message shown in the chat widget
  "actions": [                          // ordered commands executed by the widget
    { "type": "navigate",   "route": string }
    | { "type": "highlight",  "selector": string, "message"?: string, "duration_ms"?: number }
    | { "type": "popup",      "title"?: string, "body": string, "anchor_selector"?: string }
    | { "type": "scroll_to",  "selector": string }
    | { "type": "tooltip",    "selector": string, "text": string }
    | { "type": "celebrate",  "message"?: string }
    | { "type": "wait_event", "event": string }
  ],
  "next_intent": string                  // what you expect the user to do next (free text)
}

Rules:
- Prefer concrete actions tied to the page's known primary_actions.
- "selector" must be a CSS selector. If only a label is known, use an attribute
  selector like [data-onb="invite-team"] or text-based hint as a comment.
- If you don't yet know enough, just respond with a short text and one
  "wait_event" action.
- Keep "text" short. Never repeat what a popup will already show.
- Cap actions to 4.`;

    const userPrompt = `App structure (semantic map of the SaaS UI):
${appStructure ? JSON.stringify(appStructure).slice(0, 6000) : "[not available — enrich it from a code scan]"}

Knowledge snippets:
${chunks.length === 0 ? "[none]" : chunks.map((c, i) => `(${i + 1}) ${c.content.slice(0, 400)}`).join("\n---\n")}

User context:
- Current route: ${context.route ?? "(unknown)"}
- Last event: ${context.recent_event ? `${context.recent_event.type}` : "(none)"}
- Completed intents this session: ${(context.completed_intents ?? []).join(", ") || "(none)"}
- User question: ${context.question ?? "(none — proactively suggest the most useful next step)"}

Respond with the JSON object only.`;

    const ai = await callAi({
      task: "chat_simple",
      systemPrompt,
      userPrompt,
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 1200,
    });

    type Action = Record<string, unknown> & { type: string };
    let parsed: { text?: string; actions?: Action[]; next_intent?: string };
    try {
      parsed = JSON.parse(ai.content);
    } catch {
      // Fallback: wrap plain text so the widget always renders something.
      parsed = { text: ai.content.slice(0, 400), actions: [] };
    }

    const safeText = (parsed.text ?? "").toString().slice(0, 600);
    const allowed = new Set([
      "navigate",
      "highlight",
      "popup",
      "scroll_to",
      "tooltip",
      "celebrate",
      "wait_event",
    ]);
    const actions = (parsed.actions ?? [])
      .filter((a) => a && typeof a.type === "string" && allowed.has(a.type))
      .slice(0, 4);

    /* 5) Best-effort: log this turn so analytics can reflect what the agent
          surfaced (without depending on a flow being defined). */
    if (visitor_id || external_user_id) {
      await admin.from("activity_logs").insert({
        workspace_id: agent.workspace_id,
        project_id: agent.project_id,
        event_type: "rag.onboarding_turn",
        title: `Onboarding turn at ${context.route ?? "unknown"}`,
        payload: {
          agent_id: agent.id,
          visitor_id: visitor_id ?? null,
          external_user_id: external_user_id ?? null,
          route: context.route,
          actions_count: actions.length,
        },
      });
    }

    return jsonResponse({
      text: safeText,
      actions,
      next_intent: parsed.next_intent,
      debug: { model: ai.model, provider: ai.provider, retrieved_chunks: chunks.length },
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
