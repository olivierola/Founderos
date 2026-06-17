-- RAG Center: centralise knowledge into reusable "collections" that can be
-- activated individually on agents (RAG agents and internal agents).
--
-- The existing RAG infra (0016) keyed sources/chunks to a single rag_agent.
-- This migration introduces rag_collections and makes sources/chunks able to
-- belong to a collection instead — so the same knowledge base can be attached
-- to many agents without re-ingesting. Ingestion, embeddings (Jina 1024d) and
-- the chunk table are reused as-is.

-- ── Collections (the RAG centers) ─────────────────────────────────────────────
create table if not exists public.rag_collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  color text default 'text-violet-400/60',
  enabled boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_rag_collections_project on public.rag_collections(project_id);

-- Sources & chunks may now belong to a collection (agent_id becomes optional).
alter table public.rag_sources  add column if not exists collection_id uuid references public.rag_collections(id) on delete cascade;
alter table public.rag_chunks   add column if not exists collection_id uuid references public.rag_collections(id) on delete cascade;
alter table public.rag_sources  alter column agent_id drop not null;
alter table public.rag_chunks   alter column agent_id drop not null;
create index if not exists idx_rag_sources_collection on public.rag_sources(collection_id);
create index if not exists idx_rag_chunks_collection on public.rag_chunks(collection_id);

-- ── Activation: attach a collection to an agent ───────────────────────────────
-- agent_kind tells which agent table the id points to. We keep it as a loose
-- reference (no FK) so a collection can target either agent family.
create table if not exists public.rag_collection_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  collection_id uuid not null references public.rag_collections(id) on delete cascade,
  agent_kind text not null check (agent_kind in ('rag_agent','internal_agent')),
  agent_id uuid not null,
  created_at timestamptz not null default now(),
  unique (collection_id, agent_kind, agent_id)
);
create index if not exists idx_rag_coll_agents_collection on public.rag_collection_agents(collection_id);
create index if not exists idx_rag_coll_agents_agent on public.rag_collection_agents(agent_kind, agent_id);

-- ── RLS: workspace members only ───────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['rag_collections','rag_collection_agents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
      with check (exists (select 1 from public.workspace_members wm
                          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $f$, t);
  end loop;
end $$;

-- ── Vector search across one or more collections ──────────────────────────────
create or replace function public.match_rag_collection_chunks(
  p_collection_ids uuid[],
  p_query_embedding vector(1024),
  p_match_count int default 5
)
returns table (id uuid, content text, collection_id uuid, similarity float)
language sql stable as $$
  select c.id, c.content, c.collection_id,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from public.rag_chunks c
  where c.collection_id = any(p_collection_ids) and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;
