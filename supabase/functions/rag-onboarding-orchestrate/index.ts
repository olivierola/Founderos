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
    /** The end user's own stated objective ("help me connect my data"). */
    user_goal?: string;
    /** The user opted into voice from the widget this session. */
    voice?: boolean;
    /** The user asked the agent to act on their behalf ("do it for me"). */
    copilot?: boolean;
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
      .select("id, workspace_id, project_id, persona, instructions, welcome_message, onboarding_enabled, onboarding_voice_enabled, onboarding_voice_model, onboarding_copilot_enabled")
      .eq("public_key", agent_public_key)
      .maybeSingle();
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });
    if (!agent.onboarding_enabled) {
      return jsonResponse({ error: "Onboarding disabled for this agent" }, { status: 403 });
    }

    /* 1b) Load the founder's active activation goals — the live agent drives the
       user toward these (blended with the user's own stated objective). */
    const { data: goalRows } = await admin
      .from("onboarding_goals")
      .select("objective, activation_event, constraints")
      .eq("agent_id", agent.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(3);
    const goals = (goalRows ?? []) as { objective: string; activation_event: string | null; constraints: Record<string, unknown> }[];
    // Merge constraints across goals (tone/no_block/max_nudges) — most restrictive wins.
    const mergedConstraints = goals.reduce<Record<string, unknown>>((acc, g) => {
      const c = g.constraints ?? {};
      if (c.tone && !acc.tone) acc.tone = c.tone;
      if (c.no_block) acc.no_block = true;
      if (typeof c.max_nudges_per_session === "number") {
        acc.max_nudges_per_session = Math.min((acc.max_nudges_per_session as number) ?? Infinity, c.max_nudges_per_session);
      }
      return acc;
    }, {});
    const voiceOn = !!agent.onboarding_voice_enabled && !!body.context?.voice;
    // Co-pilot: the agent may perform UI actions for the user (founder-enabled + user opt-in).
    const copilotOn = !!agent.onboarding_copilot_enabled && !!body.context?.copilot;

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
${goals.length ? `\nYour MISSION — proactively drive the user toward these founder-defined activation goals:\n${goals.map((g, i) => `  ${i + 1}. ${g.objective}${g.activation_event ? ` [activation event: ${g.activation_event}]` : ""}`).join("\n")}\nAt every turn, pick the single next action that most advances the nearest goal.` : ""}

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
    | { "type": "wait_event", "event": string }${copilotOn ? `
    | { "type": "click",      "selector": string }
    | { "type": "fill",       "selector": string, "value": string }
    | { "type": "select",     "selector": string, "value": string }
    | { "type": "submit",     "selector": string }` : ""}
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
- Cap actions to 4.
- To point at a button/control the user must click, use "highlight" (or
  "tooltip") on its selector — this is your primary guidance tool.${mergedConstraints.tone ? `\n- Tone: ${mergedConstraints.tone}.` : ""}${mergedConstraints.no_block ? `\n- Do NOT block the screen: prefer "highlight"/"tooltip" over modal "popup".` : ""}${voiceOn ? `\n- Voice is ON: keep "text" to one short spoken sentence, natural and conversational (it will be read aloud). Put visual detail in actions, not in text.` : ""}${copilotOn ? `\n- CO-PILOT is ON: you MAY use click/fill/select/submit to complete a step FOR the user, then briefly say what you did. NEVER auto-perform destructive or irreversible actions (delete, pay, send, publish, invite-with-charge) — for those, "highlight" the control and let the user confirm.` : ""}`;

    const userPrompt = `App structure (semantic map of the SaaS UI):
${appStructure ? JSON.stringify(appStructure).slice(0, 6000) : "[not available — enrich it from a code scan]"}

Knowledge snippets:
${chunks.length === 0 ? "[none]" : chunks.map((c, i) => `(${i + 1}) ${c.content.slice(0, 400)}`).join("\n---\n")}

User context:
- Current route: ${context.route ?? "(unknown)"}
- Last event: ${context.recent_event ? `${context.recent_event.type}` : "(none)"}
- Completed intents this session: ${(context.completed_intents ?? []).join(", ") || "(none)"}
- User question: ${context.question ?? "(none — proactively suggest the most useful next step)"}
- User's own stated goal: ${context.user_goal ?? "(none — follow the founder's activation goals)"}

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
      // Co-pilot actions are only accepted when the mode is on.
      ...(copilotOn ? ["click", "fill", "select", "submit"] : []),
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
      // The widget speaks `text` via onboarding-voice (action "speak") when on.
      voice: voiceOn ? { enabled: true, model: agent.onboarding_voice_model, speak: safeText } : { enabled: false },
      // Co-pilot on → the widget executes click/fill/select/submit actions.
      copilot: { enabled: copilotOn },
      debug: { model: ai.model, provider: ai.provider, retrieved_chunks: chunks.length, goals: goals.length },
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
