// ops-plan-infra — Step 1 of the multi-tool infra workflow.
//
// Body: {
//   workspace_id, project_id,
//   name,
//   brief,                        // free-text description of the desired infra
//   metadata?,                    // selected target cloud, default domain, etc.
//   existing_id?                  // if provided, replan an existing infra_project
// }
//
// The agent reads the brief + the project's scan context and proposes a
// layered plan: which tools (Terraform/Ansible/Docker/K8s/Helm/scripts) to
// use, what each layer is responsible for, dependencies between them. The
// user reviews/edits the plan in the UI then calls ops-generate-infra to
// emit the actual files.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";

const SYSTEM = `You are a senior DevOps architect. You read a project context and a free-text
brief that describes the infrastructure the user wants, and you output a
STRUCTURED PLAN as JSON.

Your job is NOT to write files yet. You decide:
  - which tools to use (Terraform, Ansible, Docker Compose, Kubernetes, Helm, scripts)
  - how the work splits into layers (one per concern)
  - the order in which layers must run, and what they pass between each other

Always return a SINGLE JSON object — no commentary outside.

Schema:
{
  "summary": "one paragraph describing the overall architecture",
  "layers": [
    {
      "id": "kebab-case-id",                      // unique within the plan
      "label": "Human-readable label",
      "tool": "terraform"|"ansible"|"docker_compose"|"kubernetes"|"helm"|"script",
      "purpose": "one-line responsibility",
      "inputs": ["What this layer consumes from previous layers"],
      "outputs": ["What this layer produces"],
      "depends_on": ["other layer ids"],          // must run before this one
      "risk_level": "low"|"medium"|"high",
      "notes": "anything that matters when generating the files"
    }
  ],
  "execution_order": ["layer_id_1","layer_id_2","..."],
  "assumptions": ["assumptions you are making that the user should confirm"],
  "open_questions": ["questions you cannot answer without more info (max 3)"]
}

Rules:
- Only include layers that the brief actually asks for. Don't add Kubernetes if
  the user wants a single VPS.
- Provisioning (Terraform) comes before configuration (Ansible) which comes
  before app delivery (Docker Compose / Kubernetes). Respect that in
  execution_order.
- A layer can be skipped: if the brief says "I already have a VPS", omit the
  Terraform layer entirely.
- Open questions: only include the questions whose answer would materially
  change the plan — not nice-to-haves.
- Keep it tight: at most 6 layers, at most 3 open questions.`;

interface PlanLayer {
  id: string; label: string; tool: string; purpose: string;
  inputs: string[]; outputs: string[]; depends_on: string[];
  risk_level: string; notes: string;
}
interface Plan {
  summary: string;
  layers: PlanLayer[];
  execution_order: string[];
  assumptions: string[];
  open_questions: string[];
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const body = await req.json();
    const { workspace_id, project_id, name, brief, metadata, existing_id } = body;
    if (!workspace_id || !project_id || !brief) {
      return jsonResponse({ ok: false, message: "workspace_id, project_id and brief are required" }, { status: 400 });
    }

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();

    // Build context from the latest scan so the agent knows the framework /
    // services / dependencies it has to support.
    const { data: scan } = await admin
      .from("scan_results")
      .select("summary, services, dependencies, ai_analysis")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const context = {
      project_summary: scan?.summary ?? null,
      services: scan?.services ?? [],
      dependencies: scan?.dependencies ?? [],
      metadata: metadata ?? {},
    };

    const userPrompt = `## Brief
${brief}

## Project context
${JSON.stringify(context, null, 2)}

Return the JSON plan as described.`;

    const ai = await callAi({
      task: "json_extraction",
      systemPrompt: SYSTEM,
      userPrompt,
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 2500,
    });

    let parsed: Plan;
    try { parsed = JSON.parse(ai.content); }
    catch {
      const m = ai.content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Planner did not return parseable JSON.");
      parsed = JSON.parse(m[0]);
    }
    if (!Array.isArray(parsed.layers) || parsed.layers.length === 0) {
      throw new Error("Planner returned no layers.");
    }
    // Normalise: ensure execution_order is present and references valid ids.
    const layerIds = new Set(parsed.layers.map((l) => l.id));
    parsed.execution_order = (parsed.execution_order ?? parsed.layers.map((l) => l.id))
      .filter((id) => layerIds.has(id));
    parsed.assumptions ??= [];
    parsed.open_questions ??= [];

    let infraId: string;
    if (existing_id) {
      const { error } = await admin
        .from("ops_infra_projects")
        .update({
          name: name?.trim() || undefined,
          brief,
          plan: parsed,
          plan_status: "draft",
          plan_model: ai.model ?? null,
          metadata: metadata ?? {},
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing_id);
      if (error) throw error;
      infraId = existing_id;
    } else {
      const { data, error } = await admin
        .from("ops_infra_projects")
        .insert({
          workspace_id, project_id,
          name: (name?.trim() || "Untitled infra"),
          brief,
          plan: parsed,
          plan_status: "draft",
          plan_model: ai.model ?? null,
          metadata: metadata ?? {},
          created_by: userId,
        })
        .select("id")
        .single();
      if (error) throw error;
      infraId = data.id;
    }

    return jsonResponse({ ok: true, infra_id: infraId, plan: parsed });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
