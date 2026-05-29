// ai-cost-optimization — aggregate cost + LLM usage for a project, ask Groq for actionable savings ideas.
// Body: { workspace_id, project_id }
// Returns: { insights: [{ title, severity, category, explanation, recommendations, estimated_savings }] }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const SYSTEM_PROMPT = `Tu es un FinOps technique pour SaaS indie / B2B.
À partir des dépenses récentes (cost_records) et de l'usage LLM (llm_usage), produis 3 à 5 insights JSON STRICTS.
Tu dois signaler les coûts anormaux, surconsommation LLM, alternatives moins chères et opportunités de cache.
Tu ne dois jamais inventer de chiffres.

Réponds uniquement avec un objet JSON valide :
{
  "insights": [
    {
      "title": "string court",
      "severity": "info" | "warning" | "critical",
      "category": "costs" | "llm" | "optimization",
      "explanation": "1-2 phrases",
      "recommendations": ["action 1", "action 2"],
      "estimated_savings_eur": number | null
    }
  ]
}`;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

    const [{ data: costs }, { data: llm }] = await Promise.all([
      admin
        .from("cost_records")
        .select("provider, category, amount_cents, currency, period_start, note, source")
        .eq("project_id", project_id)
        .gte("created_at", thirtyAgo),
      admin
        .from("llm_usage")
        .select("provider, model, task, feature, prompt_tokens, completion_tokens, estimated_cost_cents")
        .eq("project_id", project_id)
        .gte("created_at", thirtyAgo)
        .limit(500),
    ]);

    const totalCostCents = (costs ?? []).reduce((s, c) => s + (c.amount_cents ?? 0), 0);
    const byProvider = new Map<string, number>();
    (costs ?? []).forEach((c) => byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + (c.amount_cents ?? 0)));

    const llmByModel = new Map<string, { tokens: number; cents: number }>();
    (llm ?? []).forEach((l) => {
      const k = `${l.provider}/${l.model ?? "?"}`;
      const cur = llmByModel.get(k) ?? { tokens: 0, cents: 0 };
      cur.tokens += (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0);
      cur.cents += l.estimated_cost_cents ?? 0;
      llmByModel.set(k, cur);
    });

    const payload = {
      period_days: 30,
      total_cost_eur: +(totalCostCents / 100).toFixed(2),
      costs_by_provider: [...byProvider.entries()].map(([provider, cents]) => ({
        provider,
        eur: +(cents / 100).toFixed(2),
      })),
      llm_by_model: [...llmByModel.entries()].map(([k, v]) => ({
        model: k,
        tokens: v.tokens,
        eur: +(v.cents / 100).toFixed(2),
      })),
      llm_calls: llm?.length ?? 0,
    };

    const aiResult = await callAi({
      task: "summary",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify(payload, null, 2),
      jsonMode: true,
      maxTokens: 1500,
      temperature: 0.3,
    });

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: aiResult.provider,
      model: aiResult.model,
      task: "cost_optimization",
      feature: "ai-cost-optimization",
      usage: aiResult.usage,
    });

    const parsed = safeParseJson<{ insights: unknown[] }>(aiResult.content);
    if (!parsed) {
      return jsonResponse({ error: "AI returned unparseable JSON", raw: aiResult.content.slice(0, 300) }, { status: 502 });
    }

    return jsonResponse({
      ok: true,
      summary: payload,
      insights: parsed.insights ?? [],
      _meta: { provider: aiResult.provider, model: aiResult.model },
    });
  } catch (err) {
    return jsonResponse(
      { error: "ai-cost-optimization failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
