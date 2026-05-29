// ai-agent-chat — contextual chat with the SaaS Cockpit agent.
// Body: { workspace_id, project_id, conversation_id?, message }
// - Creates conversation if missing, persists user message, builds context,
//   calls Groq, persists assistant message, returns full message + conversation id.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const SYSTEM_PROMPT = `Tu es l'agent admin technique d'un SaaS code-aware ("FounderOS").
Tu aides un fondateur ou développeur à comprendre son produit : métriques, coûts, risques, actions possibles.
Tu peux analyser les données fournies dans CONTEXT, mais tu ne dois jamais inventer de métriques absentes.
Tu ne dois jamais exécuter d'action sans validation explicite de l'utilisateur.
Tu dois signaler les risques de sécurité, coûts anormaux, dépendances critiques et opportunités de croissance.
Si l'utilisateur demande une action admin (refund, ban user, etc.), réponds par un PLAN d'action et précise qu'il devra le valider dans l'onglet Actions.
Réponds en markdown court, concis, technique et actionnable. Pas de paragraphes longs.`;

async function buildContext(projectId: string) {
  const admin = createServiceClient();
  const [{ data: project }, { data: snap }, { data: latestScan }, { data: connectors }, { data: alerts }] =
    await Promise.all([
      admin.from("projects").select("id, name, slug, detected_stack").eq("id", projectId).maybeSingle(),
      admin
        .from("metrics_snapshots")
        .select("metrics, snapshot_date")
        .eq("project_id", projectId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("scan_results")
        .select("summary, services, dependencies, security_findings, ai_analysis, created_at, repositories(full_name)")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.from("connectors").select("provider, status, permissions").eq("project_id", projectId),
      admin
        .from("alerts")
        .select("severity, title, status, created_at")
        .eq("project_id", projectId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

  return {
    project: project ? { name: project.name, slug: project.slug } : null,
    latest_metrics: snap?.metrics ?? null,
    metrics_date: snap?.snapshot_date ?? null,
    latest_scan: latestScan
      ? {
          repo: (latestScan as any).repositories?.full_name ?? null,
          summary: (latestScan as any).summary,
          services: (latestScan as any).services,
          dependencies_count: ((latestScan as any).dependencies ?? []).length,
          security_findings: (latestScan as any).security_findings,
          ai_analysis: (latestScan as any).ai_analysis,
        }
      : null,
    connectors: (connectors ?? []).map((c) => ({ provider: c.provider, status: c.status })),
    open_alerts: alerts ?? [],
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

    const context = await buildContext(project_id);
    const userPrompt = `CONTEXT (JSON):\n${JSON.stringify(context, null, 2)}\n\nConversation so far:\n${(history ?? [])
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n")}\n\nAssistant, respond to the latest user message.`;

    const aiResult = await callAi({
      task: "chat_simple",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      jsonMode: false,
      maxTokens: 1200,
      temperature: 0.3,
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

    const { data: assistantMsg } = await admin
      .from("ai_messages")
      .insert({
        conversation_id,
        role: "assistant",
        content: aiResult.content,
        metadata: { provider: aiResult.provider, model: aiResult.model, usage: aiResult.usage },
      })
      .select()
      .single();

    return jsonResponse({
      ok: true,
      conversation_id,
      assistant_message: assistantMsg,
    });
  } catch (err) {
    return jsonResponse(
      { error: "ai-agent-chat failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
