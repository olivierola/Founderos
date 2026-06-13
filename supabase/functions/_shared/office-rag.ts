// Shared grounding for the Office AI: latest code-scan understanding of the
// product + semantic search over the project's RAG knowledge base.
// Used by both office-ai (one-shot JSON) and office-ai-stream (streaming).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export interface Grounding {
  understanding: Record<string, unknown> | null;
  knowledge: string[];
}

export async function loadGrounding(
  admin: SupabaseClient,
  projectId: string,
  query: string,
  useKnowledge: boolean,
): Promise<Grounding> {
  const { data: scan } = await admin
    .from("scan_results")
    .select("summary, services, ai_analysis, repositories(full_name)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const understanding = scan
    ? {
        repository: (scan as any).repositories?.full_name ?? null,
        project_type: (scan as any).ai_analysis?.project_type ?? (scan as any).summary?.project_type ?? "unknown",
        stack_summary: (scan as any).ai_analysis?.stack_summary ?? null,
        services: ((scan as any).services ?? []).map((s: any) => s.service),
      }
    : null;

  const knowledge = useKnowledge && query.trim()
    ? await searchKnowledge(admin, projectId, query)
    : [];

  return { understanding, knowledge };
}

// Semantic search across the project's RAG chunks. The match RPC is agent-scoped,
// so we query each of the project's agents and merge the top hits. Falls back to
// a keyword search when embeddings are unavailable.
export async function searchKnowledge(
  admin: SupabaseClient,
  projectId: string,
  query: string,
  limit = 6,
): Promise<string[]> {
  try {
    const { embedTexts, toVectorLiteral } = await import("./jina.ts");
    const [vec] = await embedTexts([query], "retrieval.query");
    if (vec) {
      const { data: agents } = await admin.from("rag_agents").select("id").eq("project_id", projectId).limit(8);
      const hits: { sim: number; text: string }[] = [];
      for (const a of agents ?? []) {
        const { data } = await admin.rpc("match_rag_chunks", {
          p_agent_id: (a as any).id,
          p_query_embedding: toVectorLiteral(vec),
          p_match_count: Math.max(4, Math.ceil(limit / 2)),
        });
        for (const d of (data as any[]) ?? []) {
          hits.push({ sim: d.similarity ?? 0, text: (d.content ?? "").slice(0, 500) });
        }
      }
      if (hits.length) {
        hits.sort((x, y) => y.sim - x.sim);
        return hits.slice(0, limit).map((h) => h.text);
      }
    }
  } catch { /* embeddings unavailable — fall through */ }

  // Keyword fallback over rag_chunks by project.
  const { data } = await admin
    .from("rag_chunks")
    .select("content")
    .eq("project_id", projectId)
    .ilike("content", `%${query.slice(0, 60)}%`)
    .limit(limit);
  return (data ?? []).map((d: any) => (d.content ?? "").slice(0, 500));
}

export function groundingPromptBlock(g: Grounding): string {
  const parts: string[] = [];
  if (g.understanding) parts.push(`Compréhension du produit (scan de code):\n${JSON.stringify(g.understanding)}`);
  if (g.knowledge.length) parts.push(`Extraits de la base de connaissances du projet:\n- ${g.knowledge.join("\n- ")}`);
  return parts.join("\n\n");
}
