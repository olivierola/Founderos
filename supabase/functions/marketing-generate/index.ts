// marketing-generate — generate social posts grounded in the SaaS understanding
// produced by code scans.
// Body: {
//   workspace_id, project_id,
//   platform, objective, tone, count?, topic?, language?,
//   campaign_id?, save? (default true)
// }
// Returns: { posts: [{ content, hashtags, cta, angle }], saved, scan_used }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280,
  x: 280,
  linkedin: 3000,
  facebook: 2000,
  instagram: 2200,
  threads: 500,
  mastodon: 500,
};

interface GeneratedPost {
  content: string;
  hashtags: string[];
  cta: string | null;
  angle: string;
}

function systemPrompt(platform: string, limit: number, language: string) {
  return `Tu es un expert en marketing de contenu pour produits SaaS / tech.
Tu écris des posts pour ${platform} en ${language === "fr" ? "français" : "anglais"}.
Contrainte: chaque post fait au maximum ${limit} caractères (hors hashtags).
Tu t'appuies STRICTEMENT sur la compréhension fournie du SaaS (type, stack, services, valeur).
Tu ne dois jamais inventer de fonctionnalités absentes. Reste concret et crédible.
Varie les angles entre les posts (problème/solution, bénéfice, coulisses tech, preuve sociale, question d'engagement, annonce).

Réponds UNIQUEMENT avec un objet JSON valide:
{
  "posts": [
    { "content": "string", "hashtags": ["string"], "cta": "string|null", "angle": "string court décrivant l'angle" }
  ]
}`;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id } = body;
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m || !["owner", "admin", "member"].includes(m.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const platform = String(body.platform ?? "twitter").toLowerCase();
    const objective = String(body.objective ?? "awareness");
    const tone = String(body.tone ?? "professional");
    const count = Math.min(Math.max(Number(body.count ?? 3), 1), 6);
    const topic = body.topic ? String(body.topic) : null;
    const language = String(body.language ?? "en");
    const save = body.save !== false;
    const limit = PLATFORM_LIMITS[platform] ?? 1000;

    // Pull the most recent scan's understanding of the SaaS.
    const { data: scan } = await admin
      .from("scan_results")
      .select("id, summary, services, ai_analysis, repositories(full_name)")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const understanding = scan
      ? {
          repository: (scan as any).repositories?.full_name ?? null,
          project_type: (scan as any).ai_analysis?.project_type ?? (scan as any).summary?.project_type ?? "unknown",
          stack_summary: (scan as any).ai_analysis?.stack_summary ?? null,
          frontend: (scan as any).summary?.detected_frontend?.framework ?? null,
          backend: (scan as any).summary?.backend_framework ?? null,
          services: ((scan as any).services ?? []).map((s: any) => s.service),
        }
      : { note: "No code scan available yet — generate from generic SaaS positioning." };

    const userPrompt = `Compréhension du SaaS (issue du scan de code):
${JSON.stringify(understanding, null, 2)}

Paramètres de génération:
- Plateforme: ${platform}
- Objectif: ${objective}
- Ton: ${tone}
- Nombre de posts: ${count}
${topic ? `- Thème / sujet imposé: ${topic}` : ""}

Génère ${count} posts distincts et prêts à publier.`;

    const aiResult = await callAi({
      task: "content_generation",
      systemPrompt: systemPrompt(platform, limit, language),
      userPrompt,
      jsonMode: true,
      maxTokens: 1800,
      temperature: 0.8,
    });

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: aiResult.provider,
      model: aiResult.model,
      task: "content_generation",
      feature: "marketing-generate",
      usage: aiResult.usage,
    });

    const parsed = safeParseJson<{ posts: GeneratedPost[] }>(aiResult.content);
    if (!parsed?.posts?.length) {
      return jsonResponse({ error: "AI returned no usable posts", raw: aiResult.content.slice(0, 400) }, { status: 502 });
    }

    const posts = parsed.posts.slice(0, count).map((p) => ({
      content: String(p.content ?? "").slice(0, limit + 200),
      hashtags: Array.isArray(p.hashtags) ? p.hashtags.slice(0, 8).map((h) => String(h).replace(/^#/, "")) : [],
      cta: p.cta ? String(p.cta) : null,
      angle: String(p.angle ?? objective),
    }));

    let saved = 0;
    if (save) {
      const rows = posts.map((p) => ({
        workspace_id,
        project_id,
        campaign_id: body.campaign_id ?? null,
        platform,
        status: "draft",
        objective,
        tone,
        angle: p.angle,
        content: p.content,
        hashtags: p.hashtags,
        cta: p.cta,
        source: "ai",
        source_scan_id: scan?.id ?? null,
        ai_meta: { provider: aiResult.provider, model: aiResult.model, usage: aiResult.usage },
        created_by: userData.user.id,
      }));
      const { error, count: c } = await admin.from("marketing_posts").insert(rows, { count: "exact" });
      if (error) return jsonResponse({ error: "Could not save posts", detail: error.message, posts }, { status: 500 });
      saved = c ?? rows.length;
    }

    return jsonResponse({ posts, saved, scan_used: scan?.id ?? null });
  } catch (err) {
    return jsonResponse(
      { error: "marketing-generate failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
