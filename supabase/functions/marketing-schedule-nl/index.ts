// marketing-schedule-nl — plan & schedule one or several marketing posts from a
// single natural-language instruction.
//
// Body:
//   { workspace_id, project_id, instruction, timezone_offset_minutes?,
//     mode?: "plan" | "schedule", plan?: PlannedPost[], campaign_id? }
//
//  - mode "plan" (default): the LLM turns the instruction into a concrete plan
//    of posts (platform + content + hashtags + absolute scheduled_at). Nothing
//    is written. The UI previews/edits the plan.
//  - mode "schedule": persists the (edited) plan as draft marketing_posts and
//    returns each new post id paired with its intended schedule time. The client
//    then calls the existing marketing-publish edge per post — reusing the single,
//    tested Buffer/webhook publishing path instead of duplicating it here.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280, x: 280, linkedin: 3000, facebook: 2000,
  instagram: 2200, threads: 500, mastodon: 500,
};

interface PlannedPost {
  platform: string;
  content: string;
  hashtags: string[];
  cta: string | null;
  objective: string;
  tone: string;
  scheduled_at: string; // ISO 8601
}

function planSystemPrompt(nowIso: string, tzOffset: number, platforms: string[], language: string) {
  const tzLabel = `${tzOffset <= 0 ? "+" : "-"}${String(Math.abs(Math.round(tzOffset / 60))).padStart(2, "0")}:00`;
  return `Tu es un assistant marketing qui planifie des publications sur les réseaux sociaux pour un SaaS.

L'utilisateur te donne une instruction en langage naturel. Tu dois la transformer en un PLAN concret de posts à programmer.

Date/heure actuelle de référence: ${nowIso} (fuseau utilisateur UTC${tzLabel}).
Plateformes connectées disponibles: ${platforms.length ? platforms.join(", ") : "twitter, linkedin"}.

Règles:
- Déduis combien de posts créer et à quelles dates/heures, en interprétant les expressions ("demain 9h", "chaque lundi pendant 3 semaines", "vendredi et samedi à 18h", "dans 2 jours", "la semaine prochaine").
- Chaque "scheduled_at" doit être une date/heure ABSOLUE au format ISO 8601 AVEC le décalage de fuseau de l'utilisateur, et TOUJOURS dans le futur par rapport à la date de référence.
- Choisis une plateforme parmi celles connectées pour chaque post. Si l'utilisateur en précise une, respecte-la.
- Rédige un "content" prêt à publier, en ${language === "fr" ? "français" : "anglais"}, en t'appuyant sur la compréhension du SaaS fournie. N'invente pas de fonctionnalités.
- Respecte la limite de caractères de la plateforme (Twitter/X: 280, LinkedIn: 3000, etc.), hors hashtags.
- Varie les angles si plusieurs posts.
- Si l'instruction est ambiguë sur l'horaire, choisis des heures raisonnables (9h ou 18h) et explique tes choix dans "notes".
- Limite-toi à 20 posts maximum.

Réponds UNIQUEMENT avec un objet JSON valide:
{
  "notes": "résumé court de ton interprétation (langue de l'utilisateur)",
  "posts": [
    {
      "platform": "twitter|linkedin|facebook|instagram|threads|mastodon",
      "content": "string",
      "hashtags": ["string"],
      "cta": "string|null",
      "objective": "awareness|launch|feature|educational|engagement|conversion",
      "tone": "professional|casual|bold|technical|playful",
      "scheduled_at": "ISO 8601 avec offset"
    }
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
    const userId = userData.user.id;

    const body = await req.json();
    const { workspace_id, project_id } = body;
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!member || !["owner", "admin", "member"].includes(member.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const mode = (body.mode ?? "plan") as "plan" | "schedule";

    // ------------------------------------------------------------------ PLAN
    if (mode === "plan") {
      const instruction = String(body.instruction ?? "").trim();
      if (!instruction) return jsonResponse({ error: "instruction required" }, { status: 400 });
      const tzOffset = Number(body.timezone_offset_minutes ?? 0) || 0;
      const language = String(body.language ?? "fr");
      const nowIso = new Date().toISOString();

      // Connected channels → allowed platforms.
      const { data: channels } = await admin
        .from("marketing_channels")
        .select("platform, status")
        .eq("project_id", project_id)
        .eq("status", "connected");
      const platforms = Array.from(new Set((channels ?? []).map((c) => c.platform))).filter(Boolean);

      // SaaS understanding from the latest scan (same grounding as generate).
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
            services: ((scan as any).services ?? []).map((s: any) => s.service),
          }
        : { note: "No code scan available — use generic SaaS positioning." };

      const userPrompt = `Compréhension du SaaS:
${JSON.stringify(understanding, null, 2)}

Instruction de l'utilisateur:
"${instruction}"

Produis le plan de posts.`;

      const aiResult = await callAi({
        task: "content_generation",
        systemPrompt: planSystemPrompt(nowIso, tzOffset, platforms, language),
        userPrompt,
        jsonMode: true,
        maxTokens: 2600,
        temperature: 0.7,
      });

      await logLlmUsage({
        workspace_id, project_id,
        provider: aiResult.provider, model: aiResult.model,
        task: "content_generation", feature: "marketing-schedule-nl",
        usage: aiResult.usage,
      });

      const parsed = safeParseJson<{ notes?: string; posts: PlannedPost[] }>(aiResult.content);
      if (!parsed?.posts?.length) {
        return jsonResponse(
          { error: "Could not derive a schedule from that instruction.", raw: aiResult.content.slice(0, 400) },
          { status: 502 },
        );
      }

      const now = Date.now();
      const posts = parsed.posts.slice(0, 20).map((p) => {
        const platform = String(p.platform ?? platforms[0] ?? "twitter").toLowerCase();
        const limit = PLATFORM_LIMITS[platform] ?? 1000;
        const when = new Date(p.scheduled_at);
        const valid = !isNaN(when.getTime()) && when.getTime() > now;
        return {
          platform,
          content: String(p.content ?? "").slice(0, limit + 200),
          hashtags: Array.isArray(p.hashtags) ? p.hashtags.slice(0, 8).map((h) => String(h).replace(/^#/, "")) : [],
          cta: p.cta ? String(p.cta) : null,
          objective: String(p.objective ?? "awareness"),
          tone: String(p.tone ?? "professional"),
          scheduled_at: valid ? when.toISOString() : "",
          scheduled_invalid: !valid,
        };
      });

      return jsonResponse({
        ok: true,
        notes: parsed.notes ?? null,
        platforms_available: platforms,
        plan: posts,
      });
    }

    // -------------------------------------------------------------- SCHEDULE
    // Persist the (edited) plan as draft posts. The client then schedules each
    // through the existing, tested marketing-publish flow (Buffer/webhook), so
    // we never duplicate publishing logic here. We return the intended
    // scheduled_at per inserted row for the client to act on.
    const plan = Array.isArray(body.plan) ? (body.plan as PlannedPost[]) : [];
    if (plan.length === 0) return jsonResponse({ error: "plan is empty" }, { status: 400 });
    const campaignId = body.campaign_id ?? null;

    // Keep the intended schedule aligned with each row via insertion order.
    const intended: string[] = [];
    const rows = plan.slice(0, 20).map((p) => {
      const platform = String(p.platform ?? "twitter").toLowerCase();
      const when = new Date(p.scheduled_at);
      intended.push(!isNaN(when.getTime()) ? when.toISOString() : "");
      return {
        workspace_id,
        project_id,
        campaign_id: campaignId,
        platform,
        status: "draft",
        objective: p.objective ?? "awareness",
        tone: p.tone ?? "professional",
        angle: "nl-schedule",
        content: String(p.content ?? ""),
        hashtags: Array.isArray(p.hashtags) ? p.hashtags.map((h) => String(h).replace(/^#/, "")) : [],
        cta: p.cta ?? null,
        source: "ai",
        ai_meta: { feature: "marketing-schedule-nl" },
        created_by: userId,
      };
    });

    const { data: inserted, error } = await admin
      .from("marketing_posts")
      .insert(rows)
      .select("id");
    if (error) {
      return jsonResponse({ error: "Could not create posts", detail: error.message }, { status: 500 });
    }

    // Pair each new post id with its intended schedule time.
    const scheduleTargets = (inserted ?? []).map((row, i) => ({
      post_id: row.id,
      schedule_at: intended[i] || null,
    }));

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userId,
      event_type: "marketing.nl_scheduled",
      title: `${scheduleTargets.length} post(s) créé(s) pour programmation (langage naturel)`,
      payload: { count: scheduleTargets.length, campaign_id: campaignId },
    });

    return jsonResponse({ ok: true, created: scheduleTargets.length, targets: scheduleTargets });
  } catch (err) {
    return jsonResponse(
      { error: "marketing-schedule-nl failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
