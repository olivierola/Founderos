// rag-ingest — ingest a knowledge source into an agent's vector store.
// Body: { workspace_id, project_id, agent_id, type, title, content?, url? }
//   type: "text" | "url" | "saas_structure"
// Chunks the content, embeds with Jina, stores rows in rag_chunks.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { embedTexts, chunkText, toVectorLiteral, fetchWithTimeout } from "../_shared/jina.ts";

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

// Fetch a URL as readable text. Uses a browser-like UA (many sites 403 generic
// agents), a hard timeout, and validates the response is HTML/text with usable
// content so we fail loudly instead of ingesting an empty/blocked page.
async function scrapeUrl(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 FounderOS-RAG/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "Accept-Language": "en,fr;q=0.8",
        },
      },
      20_000,
    );
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`Fetching ${url} timed out after 20s`);
    throw new Error(`Could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(
      res.status === 403 || res.status === 401
        ? `${url} blocked the request (HTTP ${res.status}). The site may require auth or block bots.`
        : `Fetching ${url} → HTTP ${res.status}`,
    );
  }
  const ctype = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (/json/i.test(ctype) && !/html/i.test(ctype)) {
    // A JSON endpoint — keep it raw (already structured text).
    return body.slice(0, 200_000);
  }
  const text = htmlToText(body);
  if (text.length < 50) {
    throw new Error(
      "The page returned almost no readable text — it may be a JavaScript app that renders client-side, or content is behind a login.",
    );
  }
  return text;
}

// Turn the SaaS structure JSON (pages/buttons/interactive elements) into prose
// the agent can use for onboarding guidance. Defensive against varied shapes
// produced by the scanner (arrays vs objects, alternate field names).
function structureToText(structure: any): string {
  const lines: string[] = [];
  const rawPages = structure?.pages ?? structure?.routes ?? structure?.screens ?? [];
  const pages = Array.isArray(rawPages) ? rawPages : Object.values(rawPages ?? {});

  if (structure?.app_name || structure?.name) lines.push(`Application: ${structure.app_name ?? structure.name}.`);
  if (structure?.description) lines.push(String(structure.description));

  for (const p of pages) {
    if (!p || typeof p !== "object") continue;
    const name = p.name ?? p.path ?? p.title ?? p.route ?? "page";
    const path = p.path ?? p.route ?? "";
    lines.push(`\nPage: ${name}${path ? ` (route ${path})` : ""}.`);
    if (p.description) lines.push(String(p.description));
    if (p.purpose) lines.push(`Purpose: ${p.purpose}`);
    const rawEls = p.elements ?? p.interactive ?? p.buttons ?? p.actions ?? [];
    const els = Array.isArray(rawEls) ? rawEls : Object.values(rawEls ?? {});
    for (const e of els) {
      if (!e) continue;
      if (typeof e === "string") { lines.push(`- ${e}`); continue; }
      const label = e.label ?? e.text ?? e.name ?? e.title ?? "element";
      const kind = e.type ?? e.kind ?? "action";
      const action = e.action ?? e.target ?? e.href ?? "";
      lines.push(`- ${kind} "${label}"${action ? ` → ${action}` : ""}.`);
    }
  }
  return lines.join("\n").trim();
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

    const { workspace_id, project_id, agent_id, collection_id, type, title, content, url, structure } = await req.json();
    if (!workspace_id || !project_id || (!agent_id && !collection_id) || !type || !title) {
      return jsonResponse({ error: "workspace_id, project_id, type, title and one of agent_id|collection_id required" }, { status: 400 });
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
        workspace_id, project_id, agent_id: agent_id ?? null, collection_id: collection_id ?? null, type, title,
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
        let target = url.trim();
        if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
        raw = await scrapeUrl(target);
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

      let chunks = chunkText(raw);
      if (chunks.length === 0) throw new Error("Nothing to chunk");
      // Cap chunks so a huge page can't exceed the function's CPU/time budget
      // (which would otherwise kill it and leave the source stuck "processing").
      const MAX_CHUNKS = 400;
      if (chunks.length > MAX_CHUNKS) chunks = chunks.slice(0, MAX_CHUNKS);

      // Embed in batches (Jina handles arrays; keep batches modest).
      const batchSize = 32;
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const vectors = await embedTexts(batch, "retrieval.passage");
        batch.forEach((c, j) => {
          rows.push({
            workspace_id, project_id, agent_id: agent_id ?? null, collection_id: collection_id ?? null, source_id: source.id,
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
