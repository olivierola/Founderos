// generate-runbook — uses Groq to draft a runbook from a title.
// Body: { workspace_id, project_id, title, category? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const SYSTEM = `Tu génères un runbook technique court pour un fondateur SaaS.
Réponds en JSON strict :
{
  "steps": [
    { "title": "string", "description": "string (1-2 phrases)", "command": "string optionnelle" }
  ]
}
3 à 7 steps max, ordre logique, actionnable.`;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id, title, category } = await req.json();
    if (!workspace_id || !project_id || !title) {
      return jsonResponse({ error: "workspace_id, project_id, title required" }, { status: 400 });
    }

    const ai = await callAi({
      task: "summary",
      systemPrompt: SYSTEM,
      userPrompt: `Runbook title: ${title}\nCategory: ${category ?? "general"}`,
      jsonMode: true,
      maxTokens: 900,
      temperature: 0.3,
    });

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: ai.provider,
      model: ai.model,
      task: "summary",
      feature: "generate-runbook",
      usage: ai.usage,
    });

    const parsed = safeParseJson<{ steps: unknown[] }>(ai.content) ?? { steps: [] };
    const admin = createServiceClient();
    const { data: row, error } = await admin
      .from("runbooks")
      .insert({
        workspace_id,
        project_id,
        title,
        category: category ?? null,
        steps: parsed.steps ?? [],
        generated_by_ai: true,
        created_by: userData.user.id,
      })
      .select()
      .single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });

    return jsonResponse({ ok: true, runbook: row });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
