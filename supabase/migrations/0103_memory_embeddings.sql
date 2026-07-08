-- 0103_memory_embeddings.sql
-- Semantic agent memory: memories get a Jina v3 embedding (1024 dims, same
-- pipeline as the RAG Center) so recall can be driven by similarity with the
-- CURRENT task instead of a static importance/recency top-N, and search_memory
-- becomes semantic instead of keyword-ilike.

alter table public.internal_agent_memories
  add column if not exists embedding vector(1024);

-- HNSW keeps inserts cheap and queries fast at this scale (≤300 rows/agent).
create index if not exists idx_agent_memories_embedding
  on public.internal_agent_memories using hnsw (embedding vector_cosine_ops);

create or replace function public.match_agent_memories(
  p_agent_id uuid,
  p_query_embedding vector(1024),
  p_match_count int default 8
)
returns table (id uuid, kind text, content text, importance int, is_pinned boolean, similarity float)
language sql stable security definer
set search_path = public
as $$
  select m.id, m.kind, m.content, m.importance, m.is_pinned,
         1 - (m.embedding <=> p_query_embedding) as similarity
  from public.internal_agent_memories m
  where m.agent_id = p_agent_id
    and m.embedding is not null
  order by m.embedding <=> p_query_embedding
  limit p_match_count;
$$;
