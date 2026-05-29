// ai-fast-summary — Groq-powered short summary / classification / extraction.
// Body: { task: "summary" | "classification" | "json_extraction" | "alert_explanation" | "daily_briefing",
//         system_prompt?: string, input: string | object, json?: boolean }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { callAi, safeParseJson, type AiTask } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const DEFAULT_SYSTEM = `Tu es l'agent admin technique d'un SaaS code-aware.
Tu aides un fondateur ou développeur à comprendre son produit, ses métriques, ses coûts, ses risques et ses actions possibles.
Tu peux analyser les données fournies, mais tu ne dois jamais inventer de métriques absentes.
Tu ne dois jamais exécuter d'action sans validation explicite.
Tu dois signaler les risques de sécurité, coûts anormaux, dépendances critiques et opportunités de croissance.
Réponds de manière concise, technique et actionnable.`;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const task = (body.task ?? "summary") as AiTask;
    const inputStr = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
    const result = await callAi({
      task,
      systemPrompt: body.system_prompt ?? DEFAULT_SYSTEM,
      userPrompt: inputStr,
      jsonMode: body.json === true,
      maxTokens: 1200,
      temperature: 0.2,
    });

    await logLlmUsage({
      workspace_id: body.workspace_id ?? null,
      project_id: body.project_id ?? null,
      provider: result.provider,
      model: result.model,
      task,
      feature: body.feature ?? "ai-fast-summary",
      usage: result.usage,
    });

    const parsed = body.json ? safeParseJson(result.content) : null;
    return jsonResponse({
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      content: result.content,
      json: parsed,
    });
  } catch (err) {
    return jsonResponse(
      { error: "AI summary failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
