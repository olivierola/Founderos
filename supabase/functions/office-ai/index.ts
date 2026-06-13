// office-ai — AI assistance for the Office (Bureautique) module.
//
// Body:
//   { workspace_id, project_id, kind: "document"|"spreadsheet"|"presentation",
//     instruction, mode?: "create"|"assist", title?, context?, use_knowledge? }
//
// Returns: { result: { action, ...payload } }
//   action ∈ insert_markdown | replace_document | set_spreadsheet | set_slides | answer
//   plus a `title` when mode = "create".
//
// Grounding: latest code-scan understanding + (optional) knowledge-base search
// over rag_chunks for the project.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import { loadGrounding } from "../_shared/office-rag.ts";

type Kind = "document" | "spreadsheet" | "presentation";

function schemaHint(kind: Kind, mode: "create" | "assist"): string {
  if (kind === "spreadsheet") {
    return `Réponds UNIQUEMENT en JSON:
{ ${mode === "create" ? '"title": "string", ' : ""}"action": "set_spreadsheet",
  "spreadsheet": { "columns": ["string"], "rows": [["valeur", 0, null]] } }
Les lignes sont des tableaux alignés sur les colonnes. Utilise des nombres pour les valeurs numériques.`;
  }
  if (kind === "presentation") {
    return `Réponds UNIQUEMENT en JSON:
{ ${mode === "create" ? '"title": "string", ' : ""}"action": "set_slides",
  "slides": [ { "title": "string", "body": "puces en markdown (- ...)", "layout": "title|title-content|section|blank", "notes": "string|null" } ] }
La première slide a en général le layout "title".`;
  }
  // document
  if (mode === "create") {
    return `Réponds UNIQUEMENT en JSON:
{ "title": "string", "action": "replace_document", "markdown": "le document complet en markdown" }`;
  }
  return `Choisis l'action adaptée et réponds UNIQUEMENT en JSON:
- Pour ajouter du contenu: { "action": "insert_markdown", "markdown": "..." }
- Pour réécrire tout le document: { "action": "replace_document", "markdown": "..." }
- Pour seulement répondre à une question sans modifier le document: { "action": "answer", "answer": "..." }`;
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
    const kind = body.kind as Kind;
    const mode = (body.mode ?? "assist") as "create" | "assist";
    const instruction = String(body.instruction ?? "").trim();
    if (!workspace_id || !project_id || !kind || !instruction) {
      return jsonResponse({ error: "workspace_id, project_id, kind, instruction required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { understanding, knowledge } = await loadGrounding(admin, project_id, instruction, body.use_knowledge !== false);

    const systemPrompt = `Tu es un assistant bureautique qui aide à rédiger des documents, tableurs et présentations pour un SaaS.
Tu produis un contenu professionnel, clair et prêt à l'emploi, dans la langue de l'utilisateur.
Tu t'appuies sur la compréhension du produit et la base de connaissances fournies si pertinent; n'invente pas de faits.
${schemaHint(kind, mode)}`;

    const userPrompt = `Type de fichier: ${kind}
${mode === "assist" && body.title ? `Titre actuel: ${body.title}` : ""}
${mode === "assist" && body.context ? `Contenu actuel (extrait):\n"""\n${String(body.context).slice(0, 6000)}\n"""` : ""}
${understanding ? `Compréhension du SaaS:\n${JSON.stringify(understanding)}` : ""}
${knowledge.length ? `Extraits de la base de connaissances:\n- ${knowledge.join("\n- ")}` : ""}

Demande de l'utilisateur:
"${instruction}"`;

    const aiResult = await callAi({
      task: "content_generation",
      systemPrompt,
      userPrompt,
      jsonMode: true,
      maxTokens: kind === "document" ? 3200 : 2400,
      temperature: 0.6,
    });

    await logLlmUsage({
      workspace_id, project_id,
      provider: aiResult.provider, model: aiResult.model,
      task: "content_generation", feature: "office-ai",
      usage: aiResult.usage,
    });

    const parsed = safeParseJson<Record<string, unknown>>(aiResult.content);
    if (!parsed || !parsed.action) {
      return jsonResponse({ error: "AI returned no usable result", raw: aiResult.content.slice(0, 400) }, { status: 502 });
    }

    return jsonResponse({ result: parsed });
  } catch (err) {
    return jsonResponse(
      { error: "office-ai failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
