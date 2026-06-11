// ops-generate-topology — derive (or re-derive) the topology JSON for an
// existing bundle of generated files. Used when the bundle was created before
// topology generation existed, or when the user explicitly clicks "Regenerate
// architecture" after editing files.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";

const TOPOLOGY_SYSTEM = `You extract structured infrastructure topologies from a set of generated
infra files. You output ONLY a JSON object — no commentary.

Schema:
{
  "summary": "one-paragraph plain English description",
  "nodes": [
    { "id": "string", "kind": "<kind>", "label": "string",
      "group": "optional group id",
      "ports": ["80","443"], "env": ["KEY1","KEY2"],
      "image": "optional", "command": "optional",
      "healthcheck": "optional", "volumes": ["./data:/var/lib/postgres/data"],
      "meta": {} }
  ],
  "edges": [
    { "id": "string", "source": "node_id", "target": "node_id",
      "kind": "http|https|tcp|ssh|env|webhook|volume_mount|depends_on|network_link",
      "label": "optional", "port": "optional", "protocol": "optional",
      "encrypted": true, "meta": {} }
  ],
  "groups": [],
  "notes": [{ "node_id": "optional", "edge_id": "optional", "text": "...", "severity": "info|warn|critical" }]
}

Valid node kinds: server, container, service, database, cache, queue,
  reverse_proxy, load_balancer, cdn, object_storage, external, dns,
  secret_store, scheduler, network.

Do NOT emit any groups by default — keep the "groups" array empty. Users
create zones manually from the canvas toolkit.`;

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { bundle_id } = await req.json();
    if (!bundle_id) return jsonResponse({ ok: false, message: "bundle_id required" }, { status: 400 });

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }

    const admin = createServiceClient();
    const { data: files } = await admin
      .from("ops_generated_files")
      .select("workspace_id, project_id, file_path, file_type, content")
      .eq("bundle_id", bundle_id)
      .order("created_at", { ascending: true });
    if (!files || files.length === 0) {
      return jsonResponse({ ok: false, message: "No files for this bundle" }, { status: 404 });
    }

    // Caller must belong to the workspace that owns the bundle.
    const { data: membership } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", files[0].workspace_id)
      .eq("user_id", userInfo.user.id)
      .maybeSingle();
    if (!membership) {
      return jsonResponse({ ok: false, message: "Not authorized for this workspace" }, { status: 403 });
    }

    const trimmed = files.slice(0, 12).map((f) => ({
      path: f.file_path,
      type: f.file_type,
      content: f.content.length > 3500 ? f.content.slice(0, 3500) + "\n...[truncated]" : f.content,
    }));

    const ai = await callAi({
      task: "json_extraction",
      systemPrompt: TOPOLOGY_SYSTEM,
      userPrompt: `Extract the topology from these files:\n\n${JSON.stringify(trimmed, null, 2)}\n\nReturn the JSON object.`,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 3500,
    });

    let parsed: any;
    try { parsed = JSON.parse(ai.content); }
    catch {
      const m = ai.content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI did not return parseable JSON.");
      parsed = JSON.parse(m[0]);
    }
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) {
      throw new Error("Topology missing nodes/edges.");
    }

    const { data: row, error } = await admin
      .from("ops_topologies")
      .insert({
        workspace_id: files[0].workspace_id,
        project_id: files[0].project_id,
        bundle_id,
        summary: parsed.summary ?? null,
        topology: {
          nodes: parsed.nodes,
          edges: parsed.edges,
          groups: parsed.groups ?? [],
          notes: parsed.notes ?? [],
        },
        source: "ai",
      })
      .select("id")
      .single();
    if (error) throw error;

    return jsonResponse({ ok: true, topology_id: row.id, node_count: parsed.nodes.length, edge_count: parsed.edges.length });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
