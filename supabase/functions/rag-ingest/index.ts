// rag-ingest — ingest a knowledge source into an agent's vector store.
// Body: { workspace_id, project_id, agent_id, type, title, content?, url? }
//   type: "text" | "url" | "saas_structure"
// Chunks the content, embeds with Jina, stores rows in rag_chunks.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { embedTexts, chunkText, toVectorLiteral } from "../_shared/jina.ts";

// Strip HTML to readable text (lightweight).
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Turn the SaaS structure JSON (pages/buttons/interactive elements) into prose
// the agent can use for onboarding guidance.
function structureToText(structure: any): string {
  const lines: string[] = [];
  const pages = structure?.pages ?? structure?.routes ?? [];
  for (const p of pages) {
    const name = p.name ?? p.path ?? p.title ?? "page";
    lines.push(`Page: ${name}${p.path ? ` (route ${p.path})` : ""}.`);
    if (p.description) lines.push(p.description);
    const els = p.elements ?? p.interactive ?? p.buttons ?? [];
    for (const e of els) {
      const label = e.label ?? e.text ?? e.name ?? "element";
      const kind = e.type ?? "button";
      lines.push(`- ${kind} "${label}"${e.action ? ` → ${e.action}` : ""}.`);
    }
  }
  return lines.join("\n");
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

    const { workspace_id, project_id, agent_id, type, title, content, url, structure } = await req.json();
    if (!workspace_id || !project_id || !agent_id || !type || !title) {
      return jsonResponse({ error: "workspace_id, project_id, agent_id, type, title required" }, { status: 400 });
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

    // Create the source row (processing).
    const { data: source, error: srcErr } = await admin
      .from("rag_sources")
      .insert({
        workspace_id, project_id, agent_id, type, title,
        source_ref: url ?? null, status: "processing",
      })
      .select("id")
      .single();
    if (srcErr || !source) return jsonResponse({ error: "Could not create source", detail: srcErr?.message }, { status: 500 });

    try {
      // Resolve raw text by source type.
      let raw = "";
      if (type === "text") {
        raw = String(content ?? "");
      } else if (type === "url") {
        if (!url) throw new Error("url required for type=url");
        const res = await fetch(url, { headers: { "User-Agent": "FounderOS-RAG/1.0" } });
        if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`);
        raw = htmlToText(await res.text());
      } else if (type === "saas_structure") {
        // Prefer the provided structure; otherwise read the latest scan's structure.
        let struct = structure;
        if (!struct) {
          const { data: scan } = await admin
            .from("scan_results")
            .select("app_structure")
            .eq("project_id", project_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          struct = (scan as any)?.app_structure ?? null;
        }
        if (!struct) throw new Error("No SaaS structure available. Run a code scan first or provide structure.");
        raw = structureToText(struct);
      }

      if (!raw.trim()) throw new Error("No content to ingest");

      const chunks = chunkText(raw);
      if (chunks.length === 0) throw new Error("Nothing to chunk");

      // Embed in batches (Jina handles arrays; keep batches modest).
      const batchSize = 32;
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const vectors = await embedTexts(batch, "retrieval.passage");
        batch.forEach((c, j) => {
          rows.push({
            workspace_id, project_id, agent_id, source_id: source.id,
            content: c,
            embedding: toVectorLiteral(vectors[j] ?? []),
            token_estimate: Math.ceil(c.length / 4),
          });
        });
      }

      const { error: insErr } = await admin.from("rag_chunks").insert(rows);
      if (insErr) throw new Error(insErr.message);

      await admin.from("rag_sources").update({ status: "ready", chunk_count: rows.length }).eq("id", source.id);
      return jsonResponse({ ok: true, source_id: source.id, chunks: rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("rag_sources").update({ status: "failed", error_message: msg }).eq("id", source.id);
      return jsonResponse({ error: "Ingestion failed", detail: msg, source_id: source.id }, { status: 500 });
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
