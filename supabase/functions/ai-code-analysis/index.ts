// ai-code-analysis — DeepSeek-powered deep analysis of a scan_result.
// Body: { scan_result_id }
// Reads scan_results, asks DeepSeek for code/architecture/security insights, writes to ai_analysis.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const SYSTEM_PROMPT = `Tu es un auditeur technique senior pour SaaS.
À partir d'un scan de repository (dépendances, env vars, services détectés), produis une analyse technique JSON STRICTE.
Tu ne dois jamais inventer de métriques absentes. Si tu n'es pas sûr, dis "unknown".
Tu dois signaler les risques de sécurité, dépendances critiques, et donner des recommandations actionnables courtes.

Réponds uniquement avec un objet JSON valide suivant ce schéma :
{
  "project_type": "b2b_saas" | "b2c_saas" | "internal_tool" | "marketplace" | "unknown",
  "stack_summary": "string (1-2 phrases techniques)",
  "key_risks": [{ "severity": "low" | "medium" | "high" | "critical", "category": "security" | "cost" | "performance" | "maintainability" | "compliance", "message": "string" }],
  "recommendations": [{ "title": "string", "category": "security" | "cost" | "growth" | "tech_debt", "explanation": "string", "estimated_savings": number | null }],
  "code_health_score": number (0-100)
}`;

interface ScanResult {
  id: string;
  summary: Record<string, unknown>;
  dependencies: Array<{ name: string; version: string; category: string }>;
  env_vars: Array<{ key: string; detected_service: string | null; sensitivity: string }>;
  services: Array<{ service: string; category: string }>;
  security_findings: Array<{ severity: string; message: string }>;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const scanResultId = body.scan_result_id as string | undefined;
    if (!scanResultId) return jsonResponse({ error: "scan_result_id required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: scan, error } = await admin
      .from("scan_results")
      .select("id, workspace_id, project_id, summary, dependencies, env_vars, services, security_findings")
      .eq("id", scanResultId)
      .maybeSingle();
    if (error || !scan) {
      return jsonResponse({ error: "scan_result not found", detail: error?.message }, { status: 404 });
    }

    const s = scan as ScanResult;
    // Compact payload so we stay within context.
    const compactInput = {
      summary: s.summary,
      services: s.services,
      dependencies_count: s.dependencies.length,
      top_dependencies: s.dependencies.slice(0, 40).map((d) => `${d.name}@${d.version}`),
      env_vars: s.env_vars.map((e) => ({ key: e.key, sensitivity: e.sensitivity })),
      existing_findings: s.security_findings,
    };

    const aiResult = await callAi({
      task: "code_analysis",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Analyse ce scan et renvoie ton verdict en JSON strict.\n\n${JSON.stringify(compactInput, null, 2)}`,
      jsonMode: true,
      maxTokens: 2000,
      temperature: 0.2,
    });

    await logLlmUsage({
      workspace_id: (scan as { workspace_id?: string }).workspace_id ?? null,
      project_id: (scan as { project_id?: string }).project_id ?? null,
      provider: aiResult.provider,
      model: aiResult.model,
      task: "code_analysis",
      feature: "scan-enrichment",
      usage: aiResult.usage,
    });

    const parsed = safeParseJson<Record<string, unknown>>(aiResult.content);
    if (!parsed) {
      return jsonResponse({
        error: "AI returned unparseable JSON",
        raw: aiResult.content.slice(0, 500),
      }, { status: 502 });
    }

    const aiAnalysis = {
      ...parsed,
      _meta: {
        provider: aiResult.provider,
        model: aiResult.model,
        usage: aiResult.usage,
        generated_at: new Date().toISOString(),
      },
    };

    const { error: updateErr } = await admin
      .from("scan_results")
      .update({ ai_analysis: aiAnalysis })
      .eq("id", scanResultId);
    if (updateErr) {
      return jsonResponse({ error: "Could not save ai_analysis", detail: updateErr.message }, { status: 500 });
    }

    return jsonResponse({ ok: true, scan_result_id: scanResultId, ai_analysis: aiAnalysis });
  } catch (err) {
    return jsonResponse(
      { error: "ai-code-analysis failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
