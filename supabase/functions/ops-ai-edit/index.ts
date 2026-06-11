// ops-ai-edit — modify a generated infra bundle from a natural-language
// instruction. Backs the AI chat in the Architecture view (infra layers and
// blueprint bundles).
//
// Body: { bundle_id, instruction }
//
// Loads the bundle's current files, asks the LLM for a minimal change set
// (update / create / delete per file), applies it in place (deleted files are
// marked superseded so nothing is lost), and returns a human-readable summary
// of what changed. Callers checkpoint first when they need versioning (the
// infra page auto-snapshots before calling).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";

interface FileRow {
  id: string;
  file_path: string;
  file_type: string;
  content: string;
  status: string;
}

interface Change {
  op: "update" | "create" | "delete";
  path: string;
  type?: string;
  content?: string;
}

const VALID_TYPES = new Set([
  "dockerfile", "docker_compose", "nginx_conf", "ansible_playbook", "ansible_inventory",
  "terraform", "kubernetes_manifest", "helm_chart", "env_example", "script", "readme", "other",
]);

const MAX_PROMPT_CHARS = 60_000;

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { bundle_id, instruction } = await req.json();
    if (!bundle_id || typeof instruction !== "string" || !instruction.trim()) {
      return jsonResponse({ ok: false, message: "bundle_id and instruction required" }, { status: 400 });
    }

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }

    const admin = createServiceClient();
    const { data: files } = await admin
      .from("ops_generated_files")
      .select("id, file_path, file_type, content, status, workspace_id, project_id, bundle_label")
      .eq("bundle_id", bundle_id)
      .neq("status", "superseded")
      .order("file_path", { ascending: true });
    if (!files || files.length === 0) {
      return jsonResponse({ ok: false, message: "Bundle not found or empty" }, { status: 404 });
    }
    const meta = files[0] as unknown as { workspace_id: string; project_id: string; bundle_label: string | null };

    // The caller must be a member of the workspace owning the bundle.
    const { data: membership } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", meta.workspace_id)
      .eq("user_id", userInfo.user.id)
      .maybeSingle();
    if (!membership) {
      return jsonResponse({ ok: false, message: "Not authorized for this workspace" }, { status: 403 });
    }

    // Assemble the current state, biggest files truncated to fit the prompt.
    let budget = MAX_PROMPT_CHARS;
    const fileBlocks: string[] = [];
    for (const f of files as unknown as FileRow[]) {
      const body = f.content.length > 12_000 ? f.content.slice(0, 12_000) + "\n# …(truncated)" : f.content;
      const block = `### ${f.file_path} (type: ${f.file_type})\n\`\`\`\n${body}\n\`\`\``;
      if (block.length > budget) break;
      budget -= block.length;
      fileBlocks.push(block);
    }

    const systemPrompt = `You are an expert DevOps engineer editing an existing infrastructure bundle ("${meta.bundle_label ?? "bundle"}").
Apply the user's instruction with the SMALLEST coherent change set. Keep everything else byte-identical.

Rules:
- "update" must contain the COMPLETE new file content (not a diff).
- Only touch files the instruction requires. Never invent secrets — use placeholders.
- Keep tools consistent with each file's existing format (Terraform stays Terraform, compose stays compose…).

Return ONE JSON object, no commentary:
{
  "summary": "1-3 sentences describing what changed and why",
  "changes": [
    { "op": "update" | "create" | "delete", "path": "string", "type": "file_type (create only)", "content": "string (update/create)" }
  ]
}
Valid file_type values: dockerfile, docker_compose, nginx_conf, ansible_playbook, ansible_inventory, terraform, kubernetes_manifest, helm_chart, env_example, script, readme, other.
If the instruction needs no file change (a question, or already satisfied), return { "summary": "<answer>", "changes": [] }.`;

    const ai = await callAi({
      task: "content_generation",
      systemPrompt,
      userPrompt: `Current bundle files:\n\n${fileBlocks.join("\n\n")}\n\nInstruction: ${instruction.trim()}`,
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 6000,
    });

    const parsed = safeParseJson<{ summary?: string; changes?: Change[] }>(ai.content);
    if (!parsed || typeof parsed.summary !== "string") {
      return jsonResponse({ ok: false, message: "AI returned an unparseable change set" }, { status: 502 });
    }
    const changes = Array.isArray(parsed.changes) ? parsed.changes : [];

    const byPath = new Map((files as unknown as FileRow[]).map((f) => [f.file_path, f]));
    const applied: Array<{ op: string; path: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const ch of changes.slice(0, 30)) {
      const path = typeof ch.path === "string" ? ch.path.trim() : "";
      if (!path || path.includes("..")) { skipped.push({ path, reason: "invalid path" }); continue; }
      const existing = byPath.get(path);

      if (ch.op === "delete") {
        if (!existing) { skipped.push({ path, reason: "not found" }); continue; }
        await admin.from("ops_generated_files").update({ status: "superseded" }).eq("id", existing.id);
        applied.push({ op: "delete", path });
      } else if (ch.op === "update") {
        if (!existing) { skipped.push({ path, reason: "not found (use create)" }); continue; }
        if (typeof ch.content !== "string" || !ch.content) { skipped.push({ path, reason: "missing content" }); continue; }
        await admin.from("ops_generated_files")
          .update({ content: ch.content, status: "draft", reviewed_by: null, reviewed_at: null })
          .eq("id", existing.id);
        applied.push({ op: "update", path });
      } else if (ch.op === "create") {
        if (existing) { skipped.push({ path, reason: "already exists (use update)" }); continue; }
        if (typeof ch.content !== "string" || !ch.content) { skipped.push({ path, reason: "missing content" }); continue; }
        await admin.from("ops_generated_files").insert({
          workspace_id: meta.workspace_id,
          project_id: meta.project_id,
          bundle_id,
          bundle_label: meta.bundle_label,
          file_path: path,
          file_type: VALID_TYPES.has(ch.type ?? "") ? ch.type : "other",
          content: ch.content,
          status: "draft",
        });
        applied.push({ op: "create", path });
      } else {
        skipped.push({ path, reason: `unknown op "${ch.op}"` });
      }
    }

    const lines = [parsed.summary.trim()];
    if (applied.length) lines.push("", ...applied.map((a) => `- ${a.op}: ${a.path}`));
    if (skipped.length) lines.push("", ...skipped.map((s) => `- skipped ${s.path || "(no path)"}: ${s.reason}`));

    return jsonResponse({
      ok: true,
      summary: lines.join("\n"),
      applied,
      skipped,
      changed: applied.length,
    });
  } catch (e) {
    return jsonResponse({ ok: false, message: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
