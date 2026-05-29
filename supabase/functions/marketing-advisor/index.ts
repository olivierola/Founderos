// marketing-advisor — AI marketing advice grounded in post performance + SaaS understanding.
// Body: { workspace_id, project_id }
// Returns: { advice: { summary, best_practices[], recommendations[], next_post_ideas[] }, stats }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const SYSTEM_PROMPT = `Tu es un consultant en growth marketing pour SaaS.
À partir de la compréhension du produit (issue d'un scan de code) et des performances des posts publiés,
tu donnes des conseils ACTIONNABLES et concrets. Pas de généralités creuses.
Tu t'appuies sur les données fournies; si peu de données, dis-le et propose une stratégie de départ.

Réponds UNIQUEMENT en JSON valide:
{
  "summary": "string (2-3 phrases sur la situation)",
  "best_practices": ["string"],
  "recommendations": [{ "title": "string", "why": "string", "priority": "high|medium|low" }],
  "next_post_ideas": [{ "platform": "string", "objective": "string", "hook": "string" }]
}`;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // SaaS understanding from latest scan.
    const { data: scan } = await admin
      .from("scan_results")
      .select("summary, services, ai_analysis")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Posts + their metrics.
    const { data: posts } = await admin
      .from("marketing_posts")
      .select("id, platform, objective, tone, angle, status, content")
      .eq("project_id", project_id)
      .limit(100);
    const { data: metrics } = await admin
      .from("marketing_post_metrics")
      .select("post_id, impressions, likes, comments, shares, clicks, engagement_rate")
      .eq("project_id", project_id)
      .limit(200);

    const metricById = new Map((metrics ?? []).map((m: any) => [m.post_id, m]));
    const published = (posts ?? []).filter((p: any) => p.status === "published");
    const withMetrics = published.map((p: any) => ({
      platform: p.platform,
      objective: p.objective,
      tone: p.tone,
      angle: p.angle,
      ...(metricById.get(p.id) ?? {}),
    }));

    const totalEng = withMetrics.reduce((s: number, p: any) => s + (p.engagement_rate ?? 0), 0);
    const stats = {
      total_posts: (posts ?? []).length,
      published: published.length,
      avg_engagement_rate: published.length ? Number((totalEng / published.length).toFixed(4)) : 0,
      best: [...withMetrics].sort((a: any, b: any) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0))[0] ?? null,
    };

    const understanding = scan
      ? {
          project_type: (scan as any).ai_analysis?.project_type ?? (scan as any).summary?.project_type ?? "unknown",
          stack_summary: (scan as any).ai_analysis?.stack_summary ?? null,
          services: ((scan as any).services ?? []).map((s: any) => s.service),
        }
      : { note: "No scan available." };

    const aiResult = await callAi({
      task: "marketing_advice",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Compréhension du SaaS:\n${JSON.stringify(understanding, null, 2)}\n\nPerformance des posts:\n${JSON.stringify(
        { stats, sample: withMetrics.slice(0, 20) },
        null,
        2,
      )}\n\nDonne tes conseils en JSON strict.`,
      jsonMode: true,
      maxTokens: 1600,
      temperature: 0.5,
    });

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: aiResult.provider,
      model: aiResult.model,
      task: "marketing_advice",
      feature: "marketing-advisor",
      usage: aiResult.usage,
    });

    const advice = safeParseJson<Record<string, unknown>>(aiResult.content);
    if (!advice) {
      return jsonResponse({ error: "AI returned unparseable JSON", raw: aiResult.content.slice(0, 400) }, { status: 502 });
    }

    return jsonResponse({ advice, stats, scan_used: !!scan });
  } catch (err) {
    return jsonResponse(
      { error: "marketing-advisor failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
