// hr-screen-candidate — AI screening of a candidate against a job opening.
// Body: { workspace_id, project_id, candidate_id }
// Scores fit (0-100), extracts strengths/gaps and a short summary, then persists
// the result on the candidate row.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id, candidate_id } = await req.json();
    if (!workspace_id || !project_id || !candidate_id) {
      return jsonResponse({ error: "workspace_id, project_id, candidate_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members").select("role")
      .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { data: cand } = await admin
      .from("hr_candidates")
      .select("id, full_name, resume_text, resume_url, notes, opening_id")
      .eq("id", candidate_id)
      .maybeSingle();
    if (!cand) return jsonResponse({ error: "Candidate not found" }, { status: 404 });

    const { data: opening } = cand.opening_id
      ? await admin.from("hr_job_openings").select("title, description, requirements, department, location").eq("id", cand.opening_id).maybeSingle()
      : { data: null };

    const resume = (cand.resume_text || cand.notes || "").slice(0, 8000);
    if (!resume.trim()) {
      return jsonResponse({ error: "No resume text to screen. Add the candidate's resume text first." }, { status: 400 });
    }

    const systemPrompt = `Tu es un recruteur expert. Évalue l'adéquation d'un candidat à une offre.
Réponds UNIQUEMENT en JSON:
{
  "score": 0-100,           // adéquation globale
  "summary": "2-3 phrases",
  "strengths": "points forts (puces markdown)",
  "gaps": "manques / points de vigilance (puces markdown)",
  "recommended_next": "une action recommandée (ex: 'Entretien technique')"
}
Sois objectif, factuel, fondé uniquement sur les éléments fournis. N'invente rien.`;

    const userPrompt = `# Offre
Titre: ${opening?.title ?? "(non spécifié)"}
Département: ${opening?.department ?? "—"} · Lieu: ${opening?.location ?? "—"}
Description: ${opening?.description ?? "—"}
Exigences: ${opening?.requirements ?? "—"}

# Candidat: ${cand.full_name}
CV / informations:
${resume}`;

    const result = await callAi({
      task: "content_generation",
      systemPrompt, userPrompt,
      jsonMode: true, maxTokens: 900, temperature: 0.2,
    });

    await logLlmUsage({
      workspace_id, project_id, provider: result.provider, model: result.model,
      task: "content_generation", feature: "hr-screen-candidate", usage: result.usage,
    });

    const parsed = safeParseJson<{ score?: number; summary?: string; strengths?: string; gaps?: string; recommended_next?: string }>(result.content);
    if (!parsed) return jsonResponse({ error: "AI returned an unparseable result", raw: result.content.slice(0, 300) }, { status: 502 });

    const score = Math.min(100, Math.max(0, Math.round(Number(parsed.score ?? 0))));
    const summary = [parsed.summary, parsed.recommended_next ? `\n\n**Next:** ${parsed.recommended_next}` : ""].filter(Boolean).join("");

    await admin.from("hr_candidates").update({
      ai_score: score,
      ai_summary: summary || null,
      ai_strengths: parsed.strengths ?? null,
      ai_gaps: parsed.gaps ?? null,
      ai_screened_at: new Date().toISOString(),
    }).eq("id", candidate_id);

    return jsonResponse({ ok: true, score, summary, strengths: parsed.strengths, gaps: parsed.gaps });
  } catch (err) {
    return jsonResponse({ error: "hr-screen-candidate failed", detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
