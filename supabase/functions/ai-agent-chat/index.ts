// ai-agent-chat — contextual chat with the SaaS Cockpit agent.
// Body: { workspace_id, project_id, conversation_id?, message }
// - Creates conversation if missing, persists user message, builds context,
//   calls Groq, persists assistant message, returns full message + conversation id.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAiWithTools, type ChatMessage } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import {
  type WorkspaceRole, type EmittedArtifact, type ToolContext,
  toolDefsForRole, accessScopeSummary, buildExecutor,
} from "../_shared/assistant-tools.ts";

const BASE_SYSTEM_PROMPT = `Tu es l'assistant interne de FounderOS, une plateforme pour fondateurs et équipes SaaS.
Tu agis comme un collaborateur capable d'exécuter des tâches : analyser des données, rédiger des documents, produire des tableaux, du JSON, du code.

Règles:
- Utilise les OUTILS à ta disposition pour répondre. Ne devine jamais des chiffres : si une donnée est nécessaire, appelle l'outil correspondant.
- Quand l'utilisateur demande un livrable (document, rapport, tableau, JSON, code), utilise l'outil de création correspondant (create_document, create_table, create_json, create_code). Le livrable s'affiche comme un artefact téléchargeable — ne recopie pas son contenu intégral dans la réponse, résume-le brièvement.
- Ne réalise jamais d'action irréversible sans validation explicite de l'utilisateur.
- Réponds en markdown concis et actionnable, dans la langue de l'utilisateur.
- Respecte strictement ton périmètre d'accès décrit ci-dessous.`;

// Lightweight, non-sensitive identity context only. Everything sensitive
// (metrics, scan, finance, alerts) is fetched on demand by role-gated tools.
async function buildContext(projectId: string) {
  const admin = createServiceClient();
  const [{ data: project }, { data: connectors }] = await Promise.all([
    admin.from("projects").select("id, name, slug, detected_stack").eq("id", projectId).maybeSingle(),
    admin.from("connectors").select("provider, status").eq("project_id", projectId),
  ]);

  return {
    project: project ? { name: project.name, slug: project.slug, stack: (project as any).detected_stack ?? null } : null,
    connectors: (connectors ?? []).map((c) => ({ provider: c.provider, status: c.status })),
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = await req.json();
    const { workspace_id, project_id, message } = body as {
      workspace_id?: string;
      project_id?: string;
      conversation_id?: string;
      message?: string;
    };
    let conversation_id = body.conversation_id as string | undefined;

    if (!workspace_id || !project_id || !message) {
      return jsonResponse({ error: "workspace_id, project_id, message required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized" }, { status: 403 });
    const userRole = (membership.role ?? "viewer") as WorkspaceRole;

    // Ensure conversation
    if (!conversation_id) {
      const { data: newConvo, error } = await admin
        .from("ai_conversations")
        .insert({
          workspace_id,
          project_id,
          user_id: userId,
          title: message.slice(0, 80),
        })
        .select("id")
        .single();
      if (error || !newConvo) {
        return jsonResponse({ error: "Could not create conversation", detail: error?.message }, { status: 500 });
      }
      conversation_id = newConvo.id;
    } else {
      await admin.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation_id);
    }

    // Persist user message
    await admin.from("ai_messages").insert({
      conversation_id,
      role: "user",
      content: message,
    });

    // Load conversation history
    const { data: history } = await admin
      .from("ai_messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .limit(30);

    // Build a light project context (only metrics the user is allowed to see is
    // enforced by the tools; this context is non-sensitive identity info).
    const context = await buildContext(project_id);

    // System prompt = base behaviour + access-scope summary tailored to the role.
    const systemPrompt = `${BASE_SYSTEM_PROMPT}

--- PÉRIMÈTRE D'ACCÈS ---
${accessScopeSummary(userRole)}

--- CONTEXTE PROJET (non sensible) ---
${JSON.stringify({ project: context.project, connectors: context.connectors }, null, 2)}`;

    // Assemble the message list from history.
    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(history ?? []).map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content,
      })),
    ];

    // Artifacts collected during the tool loop.
    const artifacts: EmittedArtifact[] = [];
    const toolCtx: ToolContext = {
      admin,
      workspaceId: workspace_id,
      projectId: project_id,
      userId,
      userRole,
      emitArtifact: (a) => artifacts.push(a),
    };

    const aiResult = await callAiWithTools({
      provider: "groq",
      messages: chatMessages,
      tools: toolDefsForRole(userRole),
      executor: buildExecutor(toolCtx),
      temperature: 0.3,
      maxTokens: 1500,
      maxRounds: 6,
    });

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: aiResult.provider,
      model: aiResult.model,
      task: "chat_simple",
      feature: "ai-agent-chat",
      usage: aiResult.usage,
    });

    // The model sometimes returns empty content when it only produced artifacts.
    // ai_messages.content is NOT NULL, so synthesise a short confirmation.
    let finalContent = aiResult.content?.trim() ?? "";
    if (!finalContent) {
      finalContent = artifacts.length
        ? `J'ai préparé ${artifacts.length} livrable${artifacts.length > 1 ? "s" : ""} ci-dessous.`
        : "(réponse vide)";
    }

    const { data: assistantMsg } = await admin
      .from("ai_messages")
      .insert({
        conversation_id,
        role: "assistant",
        content: finalContent,
        metadata: {
          provider: aiResult.provider,
          model: aiResult.model,
          usage: aiResult.usage,
          tool_calls: aiResult.toolCalls.map((t) => t.name),
          artifact_count: artifacts.length,
        },
      })
      .select()
      .single();

    // Persist emitted artifacts attached to this assistant message.
    let savedArtifacts: unknown[] = [];
    if (assistantMsg && artifacts.length > 0) {
      const rows = artifacts.map((a) => ({
        conversation_id,
        message_id: assistantMsg.id,
        workspace_id,
        project_id,
        kind: a.kind,
        title: a.title,
        content: a.content ?? null,
        data: a.data ?? null,
        language: a.language ?? null,
      }));
      const { data: inserted } = await admin.from("ai_artifacts").insert(rows).select();
      savedArtifacts = inserted ?? [];
    }

    return jsonResponse({
      ok: true,
      conversation_id,
      assistant_message: assistantMsg,
      artifacts: savedArtifacts,
    });
  } catch (err) {
    return jsonResponse(
      { error: "ai-agent-chat failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
