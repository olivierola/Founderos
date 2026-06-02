// ops-generate-infra — Step 3 of the multi-tool infra workflow.
//
// Body: {
//   infra_id,                            // an ops_infra_projects row (plan approved)
//   regenerate_layer_id?,                // if set, only regenerate this single layer
//   plan_overrides?: Plan                // optional edited plan (the user may have tweaked)
// }
//
// For each layer in plan.execution_order (or just the targeted one), the
// function does a focused LLM call with a tool-specific system prompt, parses
// the returned files, writes a fresh ops_generated_files bundle, and links it
// to an ops_infra_layers row.
//
// Failures of one layer don't abort the whole thing — the umbrella project
// goes to plan_status='partially_failed' if anything failed.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";

interface PlanLayer {
  id: string; label: string; tool: string; purpose: string;
  inputs: string[]; outputs: string[]; depends_on: string[];
  risk_level?: string; notes?: string;
}
interface Plan {
  summary: string;
  layers: PlanLayer[];
  execution_order: string[];
  assumptions?: string[];
  open_questions?: string[];
}

// Tool-specific guidance kept terse so the model has room for actual files.
function toolPrompt(tool: string): string {
  switch (tool) {
    case "terraform":
      return `Write Terraform (HCL) only. Split: providers.tf, variables.tf, main.tf, outputs.tf, terraform.tfvars.example.
Use the providers required by the brief. Always declare required_providers + required_version. Never put secrets in tfvars — leave placeholders.`;
    case "ansible":
      return `Write Ansible only. Structure: inventory.ini, playbook.yml, roles/<role>/tasks/main.yml (one file per role).
Use the FQDN form of modules (ansible.builtin.apt, community.docker.docker_container). Make tasks idempotent. Use handlers for service restarts.`;
    case "docker_compose":
      return `Write a Dockerfile (if the app needs one), a compose.yaml, an .env.example, an nginx.conf if a reverse proxy is in scope, and a deploy.sh.
Use named volumes for persistent data, healthchecks on every container, restart: unless-stopped.`;
    case "kubernetes":
      return `Write plain Kubernetes manifests (no Helm). Files: namespace.yaml, deployment.yaml, service.yaml, ingress.yaml, configmap.yaml, secret.example.yaml, hpa.yaml.
Always set resources.requests + resources.limits, livenessProbe + readinessProbe, and use the namespace declared in namespace.yaml everywhere.`;
    case "helm":
      return `Write a small Helm chart. Files: Chart.yaml, values.yaml, templates/deployment.yaml, templates/service.yaml, templates/ingress.yaml, templates/_helpers.tpl.
Make every magic value (image tag, replicas, host, resources) configurable in values.yaml.`;
    case "script":
      return `Write a shell script (bash, set -euo pipefail). Keep it short, idempotent, with clear echo lines between steps.`;
    default:
      return `Write the most useful files for the layer's purpose. Use plain text formats — no binaries.`;
  }
}

function layerSystemPrompt(layer: PlanLayer, plan: Plan): string {
  const deps = plan.layers.filter((l) => layer.depends_on?.includes(l.id));
  return `You are an expert DevOps engineer generating ONE layer of a larger infrastructure plan.

This layer:
  id: ${layer.id}
  tool: ${layer.tool}
  purpose: ${layer.purpose}

Inputs (from previous layers): ${(layer.inputs ?? []).join(", ") || "(none)"}
Outputs (for next layers): ${(layer.outputs ?? []).join(", ") || "(none)"}
Notes: ${layer.notes ?? ""}

Previous layers this one depends on:
${deps.map((d) => `  - ${d.id} (${d.tool}): ${d.purpose}`).join("\n") || "  (none)"}

Tool-specific rules:
${toolPrompt(layer.tool)}

Output a SINGLE JSON object — no commentary — with a "files" array:
{ "files": [ { "path": "string", "type": "<file_type>", "content": "string" } ] }

Valid file_type values: dockerfile, docker_compose, nginx_conf, ansible_playbook,
ansible_inventory, terraform, kubernetes_manifest, helm_chart, env_example,
script, readme, other.

Paths must be relative and grouped under a directory specific to this layer
(e.g. "terraform/main.tf", "ansible/playbook.yml", "compose/compose.yaml"). The
content field is the COMPLETE file text.`;
}

interface FileOut { path: string; type: string; content: string; }

const VALID_TYPES = new Set([
  "dockerfile","docker_compose","nginx_conf","ansible_playbook","ansible_inventory",
  "terraform","kubernetes_manifest","helm_chart","env_example","script","readme","other",
]);

async function generateOneLayer(
  layer: PlanLayer,
  plan: Plan,
  ctx: { workspace_id: string; project_id: string; infra_id: string; brief: string },
): Promise<{ ok: true; bundle_id: string; file_count: number } | { ok: false; error: string }> {
  const admin = createServiceClient();
  const sys = layerSystemPrompt(layer, plan);
  const user = `Overall plan summary: ${plan.summary}\n\nUser brief: ${ctx.brief}\n\nGenerate the files for layer "${layer.id}".`;

  let aiContent: string;
  try {
    const ai = await callAi({
      task: "content_generation",
      systemPrompt: sys,
      userPrompt: user,
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 5000,
    });
    aiContent = ai.content;
  } catch (e: any) {
    return { ok: false, error: `LLM call failed: ${e?.message ?? "unknown"}` };
  }

  let parsed: { files: FileOut[] };
  try { parsed = JSON.parse(aiContent); }
  catch {
    const m = aiContent.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: "AI did not return parseable JSON." };
    try { parsed = JSON.parse(m[0]); }
    catch { return { ok: false, error: "AI returned malformed JSON." }; }
  }
  if (!parsed?.files?.length) return { ok: false, error: "AI returned no files." };

  const bundleId = crypto.randomUUID();
  const rows = parsed.files.map((f) => ({
    workspace_id: ctx.workspace_id,
    project_id: ctx.project_id,
    bundle_id: bundleId,
    bundle_label: `${layer.label} (${layer.tool})`,
    file_path: f.path,
    file_type: VALID_TYPES.has(f.type) ? f.type : "other",
    content: f.content,
    status: "draft",
  }));
  const { error: insErr } = await admin.from("ops_generated_files").insert(rows);
  if (insErr) return { ok: false, error: `DB insert failed: ${insErr.message}` };

  return { ok: true, bundle_id: bundleId, file_count: rows.length };
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const body = await req.json();
    const { infra_id, regenerate_layer_id, plan_overrides } = body;
    if (!infra_id) return jsonResponse({ ok: false, message: "infra_id required" }, { status: 400 });

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();
    const { data: infra } = await admin
      .from("ops_infra_projects")
      .select("*")
      .eq("id", infra_id)
      .maybeSingle();
    if (!infra) return jsonResponse({ ok: false, message: "infra_project not found" }, { status: 404 });

    // Persist edited plan if the user tweaked it before clicking generate.
    const plan: Plan = (plan_overrides ?? infra.plan) as Plan;
    if (plan_overrides) {
      await admin.from("ops_infra_projects").update({ plan: plan_overrides }).eq("id", infra_id);
    }
    if (!plan?.layers?.length) {
      return jsonResponse({ ok: false, message: "Plan has no layers" }, { status: 400 });
    }

    // Mark project as generating.
    await admin.from("ops_infra_projects").update({
      plan_status: "generating",
      approved_by: userId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", infra_id);

    const targetLayers = regenerate_layer_id
      ? plan.layers.filter((l) => l.id === regenerate_layer_id)
      : plan.layers;
    if (targetLayers.length === 0) {
      return jsonResponse({ ok: false, message: "Layer id not found in plan" }, { status: 400 });
    }

    let anyFailure = false;
    const results: Array<{ layer_id: string; status: string; bundle_id?: string; error?: string }> = [];

    for (let i = 0; i < targetLayers.length; i++) {
      const layer = targetLayers[i];

      // Mark the layer row as generating (upsert so the row exists in regen too).
      await admin.from("ops_infra_layers").upsert({
        infra_project_id: infra_id,
        workspace_id: infra.workspace_id,
        project_id: infra.project_id,
        layer_key: layer.id,
        label: layer.label,
        tool: layer.tool,
        purpose: layer.purpose,
        status: "generating",
        position: regenerate_layer_id ? undefined : i,
        updated_at: new Date().toISOString(),
      }, { onConflict: "infra_project_id,layer_key" });

      // If we are regenerating a single layer, mark previously-applied files
      // for it as superseded so the UI surfaces the change.
      if (regenerate_layer_id) {
        const { data: oldLayer } = await admin
          .from("ops_infra_layers")
          .select("bundle_id")
          .eq("infra_project_id", infra_id)
          .eq("layer_key", layer.id)
          .maybeSingle();
        if (oldLayer?.bundle_id) {
          await admin.from("ops_generated_files")
            .update({ status: "superseded" })
            .eq("bundle_id", oldLayer.bundle_id);
        }
      }

      const out = await generateOneLayer(layer, plan, {
        workspace_id: infra.workspace_id,
        project_id: infra.project_id,
        infra_id,
        brief: infra.brief ?? "",
      });

      if (out.ok) {
        await admin.from("ops_infra_layers").update({
          status: "ready",
          bundle_id: out.bundle_id,
          error_message: null,
          updated_at: new Date().toISOString(),
        }).eq("infra_project_id", infra_id).eq("layer_key", layer.id);
        results.push({ layer_id: layer.id, status: "ready", bundle_id: out.bundle_id });
      } else {
        anyFailure = true;
        await admin.from("ops_infra_layers").update({
          status: "failed",
          error_message: out.error,
          updated_at: new Date().toISOString(),
        }).eq("infra_project_id", infra_id).eq("layer_key", layer.id);
        results.push({ layer_id: layer.id, status: "failed", error: out.error });
      }
    }

    // Re-read the layer states to decide the umbrella status — if other layers
    // were already in 'failed' status from a previous run we want to reflect that.
    const { data: allLayers } = await admin
      .from("ops_infra_layers")
      .select("status")
      .eq("infra_project_id", infra_id);
    const anyExisting = (allLayers ?? []).some((l) => l.status === "failed");
    const finalStatus = (anyFailure || anyExisting) ? "partially_failed" : "generated";
    await admin.from("ops_infra_projects").update({
      plan_status: finalStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", infra_id);

    return jsonResponse({ ok: true, infra_id, status: finalStatus, results });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
