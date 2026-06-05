// rag-extract-file — extract text from an uploaded document and ingest it.
// Body: { workspace_id, project_id, agent_id, title, storage_path, mime }
// The file must already be uploaded to the "rag-docs" bucket by the client.
// Supports: txt, md, csv, json, html, pdf, docx. Chunks + embeds with Jina.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { embedTexts, chunkText, toVectorLiteral } from "../_shared/jina.ts";

// NOTE: the PDF (unpdf) and DOCX (zip.js) parsers are imported *dynamically*,
// inside the handlers below — never at the top level. A failing CDN import at
// module load would otherwise crash the whole function at boot (HTTP 503 on
// every request, surfaced in the browser as "Failed to fetch"). Loading them
// lazily means text/markdown/csv/json/html uploads never touch them, and a
// parser that fails to load only breaks that one file type, with a clear error.

function decode(buf: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(new Uint8Array(buf));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdf(buf: ArrayBuffer): Promise<string> {
  // Dynamic import — see note at top of file.
  const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.12.1");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : String(text);
}

// DOCX is a zip; the document text lives in word/document.xml. We read the zip
// with the standard-library-friendly zip reader from jsr/deno.land, loaded lazily.
async function extractDocx(buf: ArrayBuffer): Promise<string> {
  const { ZipReader, Uint8ArrayReader, TextWriter } = await import(
    "https://deno.land/x/zipjs@v2.7.45/index.js"
  );
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buf)));
  try {
    const entries = await reader.getEntries();
    const docEntry = entries.find((e: { filename: string }) => e.filename === "word/document.xml");
    if (!docEntry || !docEntry.getData) return "";
    const xml: string = await docEntry.getData(new TextWriter());
    return xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  } finally {
    await reader.close();
  }
}

// Normalize non-breaking spaces (char 160) and collapse whitespace runs.
function normalize(s: string): string {
  return s.split(String.fromCharCode(160)).join(" ").replace(/[ \t]{2,}/g, " ").trim();
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

    const { workspace_id, project_id, agent_id, title, storage_path, mime } = await req.json();
    if (!workspace_id || !project_id || !agent_id || !storage_path) {
      return jsonResponse({ error: "workspace_id, project_id, agent_id, storage_path required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
    if (!m || !["owner", "admin", "member"].includes(m.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const { data: source } = await admin
      .from("rag_sources")
      .insert({ workspace_id, project_id, agent_id, type: "document", title: title || storage_path.split("/").pop(), source_ref: storage_path, status: "processing" })
      .select("id")
      .single();
    if (!source) return jsonResponse({ error: "Could not create source" }, { status: 500 });

    try {
      const { data: file, error: dlErr } = await admin.storage.from("rag-docs").download(storage_path);
      if (dlErr || !file) throw new Error(`Download failed: ${dlErr?.message ?? "no file"}`);
      const buf = await file.arrayBuffer();
      // Guard against very large files that would blow the function's memory/CPU.
      const MAX_BYTES = 15 * 1024 * 1024;
      if (buf.byteLength > MAX_BYTES) {
        throw new Error(`File is too large (${(buf.byteLength / 1048576).toFixed(1)} MB). Max is 15 MB.`);
      }
      const name = String(title ?? storage_path).toLowerCase();
      const type = String(mime ?? "");

      let raw = "";
      try {
        if (name.endsWith(".pdf") || type.includes("pdf")) raw = await extractPdf(buf);
        else if (name.endsWith(".docx") || type.includes("word") || type.includes("officedocument")) raw = await extractDocx(buf);
        else if (name.endsWith(".html") || type.includes("html")) raw = htmlToText(decode(buf));
        else raw = decode(buf); // txt / md / csv / json / plain
      } catch (parseErr) {
        const ext = name.split(".").pop() ?? "file";
        throw new Error(`Could not parse this ${ext.toUpperCase()} file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }

      raw = normalize(raw);
      if (!raw) {
        throw new Error(
          name.endsWith(".pdf")
            ? "No text could be extracted — this PDF may be a scanned image (OCR is not supported)."
            : "No extractable text found in the document.",
        );
      }

      let chunks = chunkText(raw);
      if (chunks.length === 0) throw new Error("Nothing to chunk");
      const MAX_CHUNKS = 400;
      if (chunks.length > MAX_CHUNKS) chunks = chunks.slice(0, MAX_CHUNKS);

      const rows: Record<string, unknown>[] = [];
      const batchSize = 32;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const vectors = await embedTexts(batch, "retrieval.passage");
        batch.forEach((c, j) => rows.push({
          workspace_id, project_id, agent_id, source_id: source.id,
          content: c, embedding: toVectorLiteral(vectors[j] ?? []), token_estimate: Math.ceil(c.length / 4),
        }));
      }

      const { error: insErr } = await admin.from("rag_chunks").insert(rows);
      if (insErr) throw new Error(insErr.message);

      await admin.from("rag_sources").update({ status: "ready", chunk_count: rows.length, byte_size: buf.byteLength }).eq("id", source.id);
      return jsonResponse({ ok: true, source_id: source.id, chunks: rows.length, bytes: buf.byteLength });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("rag_sources").update({ status: "failed", error_message: msg }).eq("id", source.id);
      return jsonResponse({ error: "Extraction failed", detail: msg, source_id: source.id }, { status: 500 });
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
