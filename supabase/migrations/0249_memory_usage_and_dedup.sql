-- 0249_memory_usage_and_dedup.sql
-- Mémoire d'agent : construite dynamiquement, jugée à l'usage.
--
-- Jusqu'ici la mémoire ne savait qu'empiler : chaque save_memory insérait une
-- ligne, les doublons reformulés s'accumulaient, et à 300 entrées l'outil
-- répondait « mémoire pleine, demandez à l'équipe de faire le ménage ». Rien ne
-- disait quelles mémoires servaient réellement.
--
-- Trois ajouts :
--   1. recall_count / last_recalled_at — une mémoire injectée dans un prompt ou
--      rendue par search_memory est « rappelée ». Ce qui sert remonte, ce qui
--      dort devient le premier candidat à l'éviction (plus de plafond bloquant).
--   2. match_agent_memories rend aussi source/dates/usage, pour que le runtime
--      classe (pertinence × importance × fraîcheur × usage) et déduplique à
--      l'écriture sans seconde requête.
--   3. match_project_memories — la même recherche sur tout le projet, pour la
--      sonde « déjà en mémoire » avant une recherche web (un collègue a peut-être
--      déjà payé cette recherche).

alter table public.internal_agent_memories
  add column if not exists recall_count int not null default 0,
  add column if not exists last_recalled_at timestamptz;

-- Le type de retour change : un CREATE OR REPLACE ne suffit pas.
drop function if exists public.match_agent_memories(uuid, vector, int);

create function public.match_agent_memories(
  p_agent_id uuid,
  p_query_embedding vector(1024),
  p_match_count int default 8
)
returns table (
  id uuid, kind text, content text, importance int, is_pinned boolean, similarity float,
  source text, recall_count int, last_recalled_at timestamptz, updated_at timestamptz, created_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select m.id, m.kind, m.content, m.importance, m.is_pinned,
         1 - (m.embedding <=> p_query_embedding) as similarity,
         m.source, m.recall_count, m.last_recalled_at, m.updated_at, m.created_at
  from public.internal_agent_memories m
  where m.agent_id = p_agent_id
    and m.embedding is not null
  order by m.embedding <=> p_query_embedding
  limit p_match_count;
$$;

create or replace function public.match_project_memories(
  p_project_id uuid,
  p_query_embedding vector(1024),
  p_match_count int default 5
)
returns table (id uuid, agent_id uuid, kind text, content text, similarity float, created_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select m.id, m.agent_id, m.kind, m.content,
         1 - (m.embedding <=> p_query_embedding) as similarity,
         m.created_at
  from public.internal_agent_memories m
  where m.project_id = p_project_id
    and m.embedding is not null
    and m.kind in ('context', 'learning', 'fact')
  order by m.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- Marque des mémoires comme rappelées. N'effleure PAS updated_at : « modifiée »
-- et « servie » sont deux informations différentes, et l'écran trie sur la
-- première.
create or replace function public.touch_agent_memories(p_ids uuid[])
returns void
language sql volatile security definer
set search_path = public
as $$
  update public.internal_agent_memories
     set recall_count = recall_count + 1,
         last_recalled_at = now()
   where id = any(p_ids);
$$;

-- Ces trois fonctions contournent la RLS : réservées au runtime (service role).
revoke all on function public.match_agent_memories(uuid, vector, int) from public, anon, authenticated;
revoke all on function public.match_project_memories(uuid, vector, int) from public, anon, authenticated;
revoke all on function public.touch_agent_memories(uuid[]) from public, anon, authenticated;
grant execute on function public.match_agent_memories(uuid, vector, int) to service_role;
grant execute on function public.match_project_memories(uuid, vector, int) to service_role;
grant execute on function public.touch_agent_memories(uuid[]) to service_role;
