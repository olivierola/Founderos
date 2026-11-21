// rag-ingest — ingest a knowledge source into an agent's or a collection's vector store.
// Body: { workspace_id, project_id, agent_id | collection_id, type, title, content?, url? }
//   type: "text" | "url" | "saas_structure"
// Chunks the content, embeds it (Jina, or the pinned gateway's embedding model),
// stores rows in rag_chunks.
// Body { action: "search", … } : essai de recherche sur des collections (voir searchCollections).
// Body { action: "reembed", workspace_id, cursor? } : revectorise l'espace après
// un changement de modèle d'embeddings (voir reembedWorkspace).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { embedTexts, chunkText, toVectorLiteral, fetchWithTimeout } from "../_shared/jina.ts";
import { assertCredits, assertQuota, isQuotaError, quotaErrorResponse } from "../_shared/metering.ts";
import { timingSafeEqual } from "../_shared/authz.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Anduran-RAG/1.0",
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

/**
 * Recherche vectorielle sur des collections du projet : la question est
 * vectorisée comme une requête, puis comparée aux passages (match_rag_collection_chunks).
 * Body : { action: "search", workspace_id, project_id, collection_ids, query, limit? }.
 */
async function searchCollections(userId: string, body: Record<string, unknown>): Promise<Response> {
  const workspace_id = String(body.workspace_id ?? "");
  const project_id = String(body.project_id ?? "");
  const query = String(body.query ?? "").trim().slice(0, 2000);
  const ids = Array.isArray(body.collection_ids) ? body.collection_ids.map(String).slice(0, 20) : [];
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 20);
  if (!workspace_id || !project_id || !query || ids.length === 0) {
    return jsonResponse({ error: "workspace_id, project_id, collection_ids et query requis" }, { status: 400 });
  }
  const admin = createServiceClient();
  const { data: m } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
  if (!m) return jsonResponse({ error: "Not authorized" }, { status: 403 });
  // Le client de service passe outre les RLS : seules les collections de CE projet sont cherchées.
  const { data: owned } = await admin.from("rag_collections").select("id, name")
    .eq("project_id", project_id).eq("workspace_id", workspace_id).in("id", ids);
  const allowed = (owned ?? []) as Array<{ id: string; name: string }>;
  if (allowed.length === 0) return jsonResponse({ hits: [] });

  try {
    await assertCredits(workspace_id, { minimum: 1 });
  } catch (e) {
    if (isQuotaError(e)) return quotaErrorResponse(e);
    throw e;
  }
  const [vector] = await embedTexts([query], "retrieval.query", { workspace_id, project_id, feature: "rag-search" });
  const { data: matches, error } = await admin.rpc("match_rag_collection_chunks", {
    p_collection_ids: allowed.map((c) => c.id), p_query_embedding: toVectorLiteral(vector ?? []), p_match_count: limit,
  });
  if (error) return jsonResponse({ error: error.message }, { status: 500 });
  const rows = (matches ?? []) as Array<{ id: string; content: string; collection_id: string; similarity: number }>;
  // Le titre de la source de chaque passage, pour qu'on sache d'où il vient.
  const { data: chunkSources } = rows.length
    ? await admin.from("rag_chunks").select("id, source_id").in("id", rows.map((r) => r.id))
    : { data: [] };
  const sourceOf = new Map(((chunkSources ?? []) as Array<{ id: string; source_id: string }>).map((c) => [c.id, c.source_id]));
  const sourceIds = [...new Set([...sourceOf.values()].filter(Boolean))];
  const { data: sources } = sourceIds.length
    ? await admin.from("rag_sources").select("id, title").in("id", sourceIds)
    : { data: [] };
  const titleOf = new Map(((sources ?? []) as Array<{ id: string; title: string }>).map((s) => [s.id, s.title]));
  const nameOf = new Map(allowed.map((c) => [c.id, c.name]));
  return jsonResponse({
    hits: rows.map((r) => ({
      id: r.id, similarity: Math.round(r.similarity * 1000) / 1000, content: r.content,
      collection: nameOf.get(r.collection_id) ?? null, source: titleOf.get(sourceOf.get(r.id) ?? "") ?? null,
    })),
  });
}

/**
 * Revectorise ce que l'espace a déjà vectorisé : passages RAG, mémoires des
 * agents, entités du graphe de connaissances. À lancer après un changement de
 * modèle d'embeddings (Jina → text-embedding-3 d'Azure, par exemple) : deux
 * modèles ne partagent pas le même espace, et une question vectorisée par le
 * nouveau ne retrouve plus rien de ce que l'ancien avait rangé. Les lignes sans
 * vecteur (une vectorisation qui avait échoué) en reçoivent un au passage.
 *
 * Body : { action: "reembed", workspace_id, cursor? }. Un lot par appel :
 * rappeler avec `next` tant que `done` est faux. Réservé aux owner et admin.
 */
const REEMBED_BATCH = 32;
const REEMBED_TABLES: Array<{ table: string; select: string; text: (r: Record<string, unknown>) => string }> = [
  { table: "rag_chunks", select: "id, content", text: (r) => String(r.content ?? "") },
  // Mêmes textes que ceux vectorisés à l'écriture (embedMemoryVector, knowledge-graph).
  { table: "internal_agent_memories", select: "id, content", text: (r) => String(r.content ?? "").slice(0, 2000) },
  { table: "knowledge_entities", select: "id, name, summary, kind", text: (r) => `${r.name ?? ""} — ${r.summary ?? r.kind ?? ""}` },
];

/** `userId` null : appel de l'exploitant (service role), sans contrôle d'appartenance. */
async function reembedWorkspace(userId: string | null, body: Record<string, unknown>): Promise<Response> {
  const workspace_id = String(body.workspace_id ?? "");
  if (!workspace_id) return jsonResponse({ error: "workspace_id requis" }, { status: 400 });
  const admin = createServiceClient();
  if (userId) {
    const { data: m } = await admin.from("workspace_members").select("role")
      .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!m || !["owner", "admin"].includes((m as { role: string }).role)) {
      return jsonResponse({ error: "Réservé aux owner et admin de l'espace" }, { status: 403 });
    }
  }
  try {
    await assertCredits(workspace_id, { minimum: 1 });
  } catch (e) {
    if (isQuotaError(e)) return quotaErrorResponse(e);
    throw e;
  }

  const cursor = (body.cursor ?? {}) as { t?: number; after?: string };
  let t = Math.max(0, Math.min(Number(cursor.t) || 0, REEMBED_TABLES.length));
  let after = typeof cursor.after === "string" ? cursor.after : "";
  while (t < REEMBED_TABLES.length) {
    const spec = REEMBED_TABLES[t];
    let q = admin.from(spec.table).select(spec.select).eq("workspace_id", workspace_id).order("id").limit(REEMBED_BATCH);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) return jsonResponse({ error: `${spec.table} : ${error.message}` }, { status: 500 });
    const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).filter((r) => spec.text(r).trim());
    if (!data || data.length === 0) { t++; after = ""; continue; }
    const vectors = rows.length
      ? await embedTexts(rows.map((r) => spec.text(r)), "retrieval.passage", { workspace_id, feature: "reembed" })
      : [];
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!vectors[i]) continue;
      const { error: upErr } = await admin.from(spec.table)
        .update({ embedding: toVectorLiteral(vectors[i]) }).eq("id", String(rows[i].id));
      if (!upErr) updated++;
    }
    const last = String((data[data.length - 1] as unknown as Record<string, unknown>).id);
    const more = data.length === REEMBED_BATCH;
    const next = more ? { t, after: last } : { t: t + 1, after: "" };
    return jsonResponse({ done: !more && t + 1 >= REEMBED_TABLES.length, table: spec.table, processed: updated, next });
  }
  return jsonResponse({ done: true, processed: 0, next: null });
}

/** Le jeton est-il une clé service role valide ? Seul le service role peut
 *  lister les comptes : si l'API d'administration d'Auth l'accepte, oui. */
async function isServiceRoleToken(token: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url || !token || token.split(".").length !== 3) return false;
  try {
    const probe = createClient(url, token, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    return !error;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    // L'exploitant (service role) revectorise sans session : après une bascule
    // de modèle d'embeddings, c'est lui qui la lance, espace par espace. Il ne
    // peut rien faire d'autre ici.
    if (timingSafeEqual(authHeader.replace(/^Bearer\s+/i, ""), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")) {
      const body = await req.json().catch(() => ({}));
      if (body?.action === "reembed") return await reembedWorkspace(null, body);
      return jsonResponse({ error: "Avec le service role, seule l'action reembed est permise." }, { status: 403 });
    }
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) {
      // Une autre clé service role que celle injectée ici (le projet en expose
      // plusieurs : clé historique, clés tournées) : c'est le serveur Auth qui
      // tranche, par un appel réservé au service role. Pour reembed seulement.
      const body = await req.json().catch(() => ({}));
      if (body?.action === "reembed" && await isServiceRoleToken(authHeader.replace(/^Bearer\s+/i, ""))) {
        return await reembedWorkspace(null, body);
      }
      return jsonResponse({ error: "Invalid session" }, { status: 401 });
    }

    const body = await req.json();
    // Essai de recherche sur des collections (Ressources › Sources › RAG) : le même
    // chemin que l'outil rag_search des agents, pour vérifier ce qu'ils trouveront.
    if (body?.action === "search") return await searchCollections(userData.user.id, body);
    // Après un changement de modèle d'embeddings : tout revectoriser, par lots.
    if (body?.action === "reembed") return await reembedWorkspace(userData.user.id, body);

    const { workspace_id, project_id, agent_id, collection_id, type, title, content, url, structure } = body;
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

    // Quotas avant d'écrire quoi que ce soit : le texte ingéré compte dans le
    // volume stocké, et sa vectorisation appelle Jina.
    try {
      await assertQuota(workspace_id, "storage_mb", 0, { fresh: true });
      await assertCredits(workspace_id, { minimum: 1 });
    } catch (e) {
      if (isQuotaError(e)) return quotaErrorResponse(e);
      throw e;
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
        const vectors = await embedTexts(batch, "retrieval.passage", {
          workspace_id, project_id, feature: "rag-ingest",
        });
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
