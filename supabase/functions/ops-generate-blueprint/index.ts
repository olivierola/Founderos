// ops-generate-blueprint — use the LLM to generate an infrastructure bundle
// from the project's scan results.
//
// Body: {
//   workspace_id, project_id,
//   target: "docker_compose" | "ansible" | "terraform" | "kubernetes",
//   label?, domain?, env_hints?: string[]
// }
//
// Outputs a set of files (Dockerfile, docker-compose.yml, nginx.conf, etc.)
// persisted as ops_generated_files rows sharing the same bundle_id.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";

const SYSTEM_PROMPT = `You are an expert DevOps engineer who produces production-ready infrastructure files.
You output a SINGLE JSON object with a "files" array.
Each file is { "path": "...", "type": "...", "content": "..." }.
Valid types: dockerfile, docker_compose, nginx_conf, ansible_playbook, ansible_inventory,
  terraform, kubernetes_manifest, helm_chart, env_example, script, readme, other.
The content field is the COMPLETE text of the file.
No additional commentary outside the JSON object.

Constraints:
- Files must be idempotent, well-commented, and follow current best practices.
- Use the EXACT framework/runtime/database the scan reports — never invent.
- For Docker bundles: include healthcheck, restart policies, volumes for data.
- For Nginx: enable gzip, security headers, rate limit on /api/auth.
- For Ansible: organise with roles, mark dangerous tasks with tags.
- For Terraform: split into providers.tf / variables.tf / main.tf / outputs.tf.
- For Kubernetes: include resource limits, probes, namespace.`;

interface FileOut { path: string; type: string; content: string; }

function targetGuidance(target: string): string {
  switch (target) {
    case "docker_compose":
      return `Generate: Dockerfile, docker-compose.yml, nginx.conf, .env.example, deploy.sh, README.md.
Strategy: app container behind Nginx reverse proxy with certbot SSL, restart-on-failure.`;
    case "ansible":
      return `Generate: ansible/inventory.ini, ansible/playbook.yml, ansible/roles/base/tasks/main.yml,
ansible/roles/security/tasks/main.yml, ansible/roles/docker/tasks/main.yml, ansible/roles/nginx/tasks/main.yml,
ansible/roles/certbot/tasks/main.yml.
Strategy: harden SSH, install UFW + fail2ban, install Docker, deploy compose stack.`;
    case "terraform":
      return `Generate: terraform/providers.tf, terraform/variables.tf, terraform/main.tf, terraform/outputs.tf,
terraform/terraform.tfvars.example.
Strategy: create one VPS + firewall + DNS records + ssh key. Use Hetzner by default unless scan suggests otherwise.`;
    case "kubernetes":
      return `Generate: k8s/namespace.yaml, k8s/deployment.yaml, k8s/service.yaml, k8s/ingress.yaml,
k8s/configmap.yaml, k8s/secret.example.yaml, k8s/hpa.yaml.
Strategy: 2 replicas min, HPA on CPU > 70%, liveness + readiness probes, ingress with cert-manager TLS.`;
    default:
      return "Generate the most useful set of files for this target.";
  }
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const body = await req.json();
    const { workspace_id, project_id, target, label, domain, env_hints } = body;
    if (!workspace_id || !project_id || !target) {
      return jsonResponse({ ok: false, message: "Missing required fields" }, { status: 400 });
    }

    const admin = createServiceClient();

    // Load the latest scan for context.
    const { data: scan } = await admin
      .from("scan_results")
      .select("summary, services, dependencies, ai_analysis, app_structure")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const context = {
      summary: scan?.summary ?? null,
      services: scan?.services ?? [],
      dependencies: scan?.dependencies ?? [],
      domain: domain ?? null,
      env_hints: env_hints ?? [],
    };

    const userPrompt = `Generate infra files for target=${target}.

${targetGuidance(target)}

Project context:
${JSON.stringify(context, null, 2)}

Output a JSON object: { "files": [ { "path": "...", "type": "...", "content": "..." } ] }`;

    const ai = await callAi({
      task: "content_generation",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 6000,
    });

    let parsed: { files: FileOut[] };
    try { parsed = JSON.parse(ai.content); }
    catch {
      // Salvage attempt: look for the first { ... } block.
      const m = ai.content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI did not return parseable JSON.");
      parsed = JSON.parse(m[0]);
    }

    if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error("AI returned no files.");
    }

    // Persist files as a bundle.
    const bundleId = crypto.randomUUID();
    const bundleLabel = label ?? `${target} bundle`;
    const validTypes = new Set([
      "dockerfile","docker_compose","nginx_conf","ansible_playbook","ansible_inventory",
      "terraform","kubernetes_manifest","helm_chart","env_example","script","readme","other",
    ]);

    const rows = parsed.files.map((f) => ({
      workspace_id, project_id,
      bundle_id: bundleId,
      bundle_label: bundleLabel,
      file_path: f.path,
      file_type: validTypes.has(f.type) ? f.type : "other",
      content: f.content,
      status: "draft",
    }));

    const { error: insertErr } = await admin.from("ops_generated_files").insert(rows);
    if (insertErr) throw insertErr;

    // Second LLM pass: derive a structured topology from the files we just
    // produced. Done separately so a topology failure doesn't lose the bundle.
    let topologyId: string | null = null;
    try {
      const topology = await generateTopology(rows, { domain, target });
      const { data: topoRow, error: topoErr } = await admin
        .from("ops_topologies")
        .insert({
          workspace_id,
          project_id,
          bundle_id: bundleId,
          summary: topology.summary ?? null,
          topology: { nodes: topology.nodes, edges: topology.edges, groups: topology.groups ?? [], notes: topology.notes ?? [] },
          source: "ai",
        })
        .select("id")
        .single();
      if (!topoErr) topologyId = topoRow.id;
    } catch (e) {
      // Non-fatal: the user can hit "Regenerate architecture" from the UI.
      console.error("Topology generation failed:", (e as Error).message);
    }

    return jsonResponse({
      ok: true,
      bundle_id: bundleId,
      topology_id: topologyId,
      file_count: rows.length,
      message: `Generated ${rows.length} files${topologyId ? " + topology" : ""}.`,
    });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});

// ============================================================================
// Topology extraction — a second LLM pass focused on producing structured JSON.
// ============================================================================

const TOPOLOGY_SYSTEM = `You extract structured infrastructure topologies from a set of generated
infra files. You output ONLY a JSON object — no commentary.

Schema:
{
  "summary": "one-paragraph plain English description",
  "nodes": [
    { "id": "string", "kind": "<kind>", "label": "string",
      "group": "optional group id",
      "ports": ["80","443"],
      "env": ["KEY1","KEY2"],
      "image": "optional",
      "command": "optional",
      "healthcheck": "optional",
      "volumes": ["./data:/var/lib/postgres/data"],
      "meta": { "free-form": "extra hints" } }
  ],
  "edges": [
    { "id": "string", "source": "node_id", "target": "node_id",
      "kind": "http|https|tcp|ssh|env|webhook|volume_mount|depends_on|network_link",
      "label": "optional",
      "port": "optional",
      "protocol": "optional",
      "encrypted": true,
      "meta": {} }
  ],
  "groups": [
    { "id": "vps", "label": "VPS prod-01", "kind": "server|cluster|cloud|local",
      "contains": ["node_id_1", "node_id_2"] }
  ],
  "notes": [
    { "node_id": "optional", "edge_id": "optional", "text": "explanation", "severity": "info|warn|critical" }
  ]
}

Valid node kinds:
  server, container, service, database, cache, queue,
  reverse_proxy, load_balancer, cdn, object_storage,
  external, dns, secret_store, scheduler, network

Be exhaustive but accurate: every container in docker-compose becomes a node,
nginx upstream blocks become edges, env vars referenced from one service to
another become "env" edges, external services (Stripe, Supabase, GitHub) are
"external" nodes outside any group. Group containers under the host server.`;

interface Topology {
  summary?: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  notes?: Array<Record<string, unknown>>;
}

async function generateTopology(
  files: Array<{ file_path: string; file_type: string; content: string }>,
  ctx: { domain: string | null; target: string },
): Promise<Topology> {
  // Trim files to keep the prompt bounded. Keep the most informative types.
  const priorityTypes = new Set([
    "docker_compose", "nginx_conf", "ansible_playbook", "ansible_inventory",
    "terraform", "kubernetes_manifest", "helm_chart", "env_example", "dockerfile",
  ]);
  const ordered = [...files].sort((a, b) => {
    const ai = priorityTypes.has(a.file_type) ? 0 : 1;
    const bi = priorityTypes.has(b.file_type) ? 0 : 1;
    return ai - bi;
  });
  const trimmed = ordered.slice(0, 12).map((f) => ({
    path: f.file_path,
    type: f.file_type,
    content: f.content.length > 3500 ? f.content.slice(0, 3500) + "\n...[truncated]" : f.content,
  }));

  const userPrompt = `Extract the topology for a "${ctx.target}" deployment${ctx.domain ? ` (public domain: ${ctx.domain})` : ""}.

Files:
${JSON.stringify(trimmed, null, 2)}

Return the JSON object as described.`;

  const ai = await callAi({
    task: "json_extraction",
    systemPrompt: TOPOLOGY_SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 3500,
  });

  let parsed: Topology;
  try { parsed = JSON.parse(ai.content); }
  catch {
    const m = ai.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Topology AI did not return parseable JSON.");
    parsed = JSON.parse(m[0]);
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("Topology missing nodes/edges arrays.");
  }
  return parsed;
}
