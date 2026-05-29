// daily-briefing — generates a short narrative briefing of the day's state.
// Body: { workspace_id, project_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const SYSTEM = `Tu es l'agent admin de FounderOS.
Synthétise l'état du SaaS en un briefing court et factuel pour un fondateur pressé.
Tu ne dois jamais inventer de chiffres absents.

Réponds en JSON strict :
{
  "headline": "string (1 phrase punchy)",
  "highlights": [{"label": "string", "value": "string"}],
  "wins": ["string"],
  "risks": ["string"],
  "next_actions": ["string"]
}`;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id, project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const [snap, scan, activity, alerts] = await Promise.all([
      admin
        .from("metrics_snapshots")
        .select("metrics, snapshot_date")
        .eq("project_id", project_id)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("scan_results")
        .select("summary, services, security_findings, ai_analysis, created_at")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("activity_logs")
        .select("event_type, title, created_at")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(15),
      admin
        .from("alerts")
        .select("severity, title, status")
        .eq("project_id", project_id)
        .eq("status", "open")
        .limit(10),
    ]);

    const ctx = {
      latest_metrics: snap.data?.metrics ?? null,
      latest_scan: scan.data ?? null,
      recent_activity: activity.data ?? [],
      open_alerts: alerts.data ?? [],
      generated_at: new Date().toISOString(),
    };

    const ai = await callAi({
      task: "daily_briefing",
      systemPrompt: SYSTEM,
      userPrompt: JSON.stringify(ctx, null, 2),
      jsonMode: true,
      maxTokens: 900,
      temperature: 0.4,
    });

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: ai.provider,
      model: ai.model,
      task: "daily_briefing",
      feature: "daily-briefing",
      usage: ai.usage,
    });

    const parsed = safeParseJson<{ headline?: string }>(ai.content) ?? {};
    return jsonResponse({
      ok: true,
      briefing: parsed,
      context_summary: {
        has_metrics: !!ctx.latest_metrics,
        has_scan: !!ctx.latest_scan,
        activity_count: ctx.recent_activity.length,
        open_alerts: ctx.open_alerts.length,
      },
      _meta: { provider: ai.provider, model: ai.model },
    });
  } catch (err) {
    return jsonResponse(
      { error: "daily-briefing failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
