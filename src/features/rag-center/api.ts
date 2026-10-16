// Le RAG d'un projet : collections, sources vectorisées, activation sur les
// agents, essai de recherche. Partagé par la page historique (RagCenter) et la
// partie RAG de Ressources › Sources.
//
// Le pipeline est côté serveur : rag-ingest (texte, URL) et rag-extract-file
// (fichiers déposés dans le bucket rag-docs) découpent, vectorisent et rangent
// les passages dans rag_chunks ; les agents les retrouvent par l'outil rag_search.

import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

export interface RagCollection {
  id: string; name: string; description: string | null; color: string;
  enabled: boolean; created_at: string;
}
export interface RagSource {
  id: string; type: string; title: string; status: string; source_ref: string | null;
  chunk_count: number; error_message: string | null; created_at: string;
  /** Une procédure rédigée dans l'éditeur porte authored et son texte. */
  metadata?: { body?: string; authored?: boolean } | null;
}
export interface RagCollectionStats { sources: number; chunks: number; agents: number; failed: number; processing: number }
export interface RagHit { id: string; similarity: number; content: string; collection: string | null; source: string | null }

/** Taille maximale d'un fichier déposé (rag-extract-file). */
export const RAG_MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function listCollections(projectId: string): Promise<RagCollection[]> {
  const { data, error } = await supabase.from("rag_collections").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as RagCollection[];
}

export async function createCollection(p: { workspaceId: string; projectId: string; userId: string | null; name: string; description?: string }): Promise<RagCollection> {
  const { data, error } = await supabase.from("rag_collections").insert({
    workspace_id: p.workspaceId, project_id: p.projectId, name: p.name.trim(),
    description: p.description?.trim() || null, created_by: p.userId,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return data as RagCollection;
}

export async function updateCollection(id: string, patch: Partial<Pick<RagCollection, "name" | "description" | "enabled">>): Promise<void> {
  const { error } = await supabase.from("rag_collections").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteCollection(id: string): Promise<void> {
  const { error } = await supabase.from("rag_collections").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function collectionStats(collectionId: string): Promise<RagCollectionStats> {
  const [{ data: sources }, { count: agents }] = await Promise.all([
    supabase.from("rag_sources").select("chunk_count, status").eq("collection_id", collectionId),
    supabase.from("rag_collection_agents").select("id", { count: "exact", head: true }).eq("collection_id", collectionId),
  ]);
  const list = (sources ?? []) as { chunk_count: number; status: string }[];
  return {
    sources: list.length,
    chunks: list.reduce((s, x) => s + (x.chunk_count ?? 0), 0),
    agents: agents ?? 0,
    failed: list.filter((x) => x.status === "failed").length,
    processing: list.filter((x) => x.status === "processing" || x.status === "pending").length,
  };
}

export async function listSources(collectionId: string): Promise<RagSource[]> {
  const { data, error } = await supabase.from("rag_sources").select("*").eq("collection_id", collectionId).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as RagSource[];
}

export async function deleteSource(id: string): Promise<void> {
  const { error } = await supabase.from("rag_sources").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

interface Scope { workspaceId: string; projectId: string; collectionId: string }

export async function ingestText(s: Scope, title: string, content: string): Promise<void> {
  await callEdge("rag-ingest", { workspace_id: s.workspaceId, project_id: s.projectId, collection_id: s.collectionId, type: "text", title: title || "Texte", content });
}

export async function ingestUrl(s: Scope, url: string, title?: string): Promise<void> {
  await callEdge("rag-ingest", { workspace_id: s.workspaceId, project_id: s.projectId, collection_id: s.collectionId, type: "url", title: title || url, url });
}

/** Dépose le fichier dans rag-docs, puis lance son extraction et sa vectorisation. */
export async function ingestFile(s: Scope, file: File): Promise<void> {
  if (file.size > RAG_MAX_FILE_BYTES) {
    throw new Error(`« ${file.name} » fait ${(file.size / 1048576).toFixed(1)} Mo : 15 Mo au plus.`);
  }
  const path = `${s.projectId}/collection-${s.collectionId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
  const { error } = await supabase.storage.from("rag-docs").upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
  if (error) throw new Error(error.message);
  await callEdge("rag-extract-file", {
    workspace_id: s.workspaceId, project_id: s.projectId, collection_id: s.collectionId,
    title: file.name, storage_path: path, mime: file.type,
  });
}

/**
 * Réessaie une source en échec : une source texte n'a pas gardé son contenu,
 * donc seules les URL se relancent d'elles-mêmes ; les autres se redéposent.
 */
export async function retrySource(s: Scope, source: RagSource): Promise<boolean> {
  if (source.type !== "url" || !source.source_ref) return false;
  await deleteSource(source.id);
  await ingestUrl(s, source.source_ref, source.title);
  return true;
}

export async function listActivations(collectionId: string): Promise<Set<string>> {
  const { data } = await supabase.from("rag_collection_agents").select("agent_kind, agent_id").eq("collection_id", collectionId);
  return new Set(((data ?? []) as Array<{ agent_kind: string; agent_id: string }>).filter((a) => a.agent_kind === "internal_agent").map((a) => a.agent_id));
}

/**
 * Active (ou retire) une collection sur un agent : la ligne de liaison, puis
 * l'outil rag_search de l'agent recalculé pour chercher exactement les
 * collections actives.
 */
export async function setActivation(p: { workspaceId: string; projectId: string; collectionId: string; agentId: string; on: boolean }): Promise<void> {
  if (p.on) {
    const { error } = await supabase.from("rag_collection_agents").insert({
      workspace_id: p.workspaceId, project_id: p.projectId, collection_id: p.collectionId,
      agent_kind: "internal_agent", agent_id: p.agentId,
    });
    if (error && !/duplicate/i.test(error.message)) throw new Error(error.message);
  } else {
    await supabase.from("rag_collection_agents").delete()
      .eq("collection_id", p.collectionId).eq("agent_kind", "internal_agent").eq("agent_id", p.agentId);
  }
  await syncAgentRagTool(p.agentId);
}

export async function syncAgentRagTool(agentId: string): Promise<void> {
  const { data: links } = await supabase.from("rag_collection_agents")
    .select("collection_id").eq("agent_kind", "internal_agent").eq("agent_id", agentId);
  const ids = (links ?? []).map((l) => (l as { collection_id: string }).collection_id);
  const { data: tool } = await supabase.from("internal_agent_tools")
    .select("id, config").eq("agent_id", agentId).eq("kind", "rag_search").maybeSingle();
  const row = tool as { id: string; config?: Record<string, unknown> } | null;
  if (ids.length === 0) {
    // Plus aucune collection : l'outil reste (accès à la base du projet), sans périmètre.
    if (row) await supabase.from("internal_agent_tools").update({ config: {} }).eq("id", row.id);
    return;
  }
  if (row) {
    await supabase.from("internal_agent_tools").update({ config: { ...(row.config ?? {}), collection_ids: ids } }).eq("id", row.id);
  } else {
    await supabase.from("internal_agent_tools").insert({
      agent_id: agentId, kind: "rag_search", name: "Base de connaissances (RAG)",
      description: "Recherche dans les collections activées.", config: { collection_ids: ids }, requires_approval: false,
    });
  }
}

/** La même recherche que l'outil rag_search des agents. */
export async function searchCollections(p: { workspaceId: string; projectId: string; collectionIds: string[]; query: string; limit?: number }): Promise<RagHit[]> {
  const res = await callEdge<{ hits?: RagHit[] }>("rag-ingest", {
    action: "search", workspace_id: p.workspaceId, project_id: p.projectId,
    collection_ids: p.collectionIds, query: p.query, limit: p.limit ?? 5,
  });
  return res?.hits ?? [];
}
