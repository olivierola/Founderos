-- 0308 : l'index de recherche des agents (le grep sur la base de connaissances).
--
-- Un agent cherche d'abord par mots-clés, comme un développeur fait un grep
-- dans un dépôt, puis lit ce qu'il a trouvé (build_context). Il lui faut un
-- index unique, rapide et expressif sur tout ce qu'il peut savoir :
--
--   documents    passages de la base de connaissances (rag_chunks)
--   memory       mémoire durable de l'agent (privée à l'agent)
--   team         mémoire partagée de l'équipe
--   facts        graphe de connaissances : entités et faits
--   past_work    livrables des travaux passés (privés à l'agent)
--   artifacts    documents de l'espace (office_documents)
--   conversation messages des conversations de l'agent (privés à l'agent)
--
-- Chaque ligne dit d'où elle vient : son type, un chemin lisible
-- (documents/contrats/contrat-cadre-acme), un titre, des tags, la table et
-- l'identifiant source, et le groupe auquel elle appartient (le document, la
-- conversation, l'entité) pour pouvoir relire le tout. `doc` est une copie en
-- minuscules et sans accents, indexée en trigrammes : les recherches par mots,
-- phrase ou expression régulière passent par cet index.
--
-- Des triggers tiennent l'index à jour ; la migration le remplit une fois.
-- Lecture réservée au rôle de service (RLS sans politique) : le harnais filtre
-- lui-même par espace, projet et agent (search_grep, search_read).

create extension if not exists pg_trgm;

-- Minuscules, sans accents. Une table de correspondance caractère pour
-- caractère : la même que toolkit/grep.ts, pour que motif et texte se plient pareil.
create or replace function public.search_fold(t text) returns text
language sql immutable parallel safe as $$
  select translate(lower(coalesce(t, '')),
    'àáâãäåāçćčèéêëēėęìíîïīįñńòóôõöøōùúûüūýÿžźżœæß',
    'aaaaaaaccceeeeeeeiiiiiinnooooooouuuuuyyzzzoas')
$$;

create or replace function public.search_slug(t text) returns text
language sql immutable parallel safe as $$
  select nullif(left(trim(both '-' from regexp_replace(public.search_fold(t), '[^a-z0-9]+', '-', 'g')), 80), '')
$$;

create table if not exists public.search_index (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid,
  -- Privé à un agent (mémoire, conversation, livrables) ; null : partagé.
  agent_id      uuid,
  type          text not null check (type in ('documents', 'memory', 'team', 'facts', 'past_work', 'artifacts', 'conversation')),
  source_table  text not null,
  source_id     uuid not null,
  -- Le document, la conversation, l'entité… : relire le tout (search_read whole).
  grp           text not null,
  path          text not null,
  title         text,
  content       text not null,
  tags          text[] not null default '{}',
  meta          jsonb not null default '{}',
  doc           text generated always as (public.search_fold(coalesce(title, '') || E'\n' || content)) stored,
  -- La collection d'un passage de document : un agent en mode pools ne lit que
  -- les collections de ses pools (p_collections de search_grep / search_read).
  collection_id uuid generated always as ((meta->>'collection_id')::uuid) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_table, source_id)
);

create index if not exists search_index_doc_trgm on public.search_index using gin (doc gin_trgm_ops);
create index if not exists search_index_scope on public.search_index (workspace_id, type);
create index if not exists search_index_agent on public.search_index (agent_id) where agent_id is not null;
create index if not exists search_index_grp on public.search_index (grp);
create index if not exists search_index_path on public.search_index (path text_pattern_ops);
create index if not exists search_index_collection on public.search_index (collection_id) where collection_id is not null;

alter table public.search_index enable row level security;

-- ── Écriture ─────────────────────────────────────────────────────────────────

create or replace function public.search_index_put(
  p_ws uuid, p_project uuid, p_agent uuid, p_type text, p_table text, p_id uuid,
  p_grp text, p_path text, p_title text, p_content text, p_tags text[], p_meta jsonb, p_at timestamptz
) returns void language plpgsql as $$
begin
  if p_ws is null or coalesce(btrim(p_content), '') = '' then
    delete from public.search_index where source_table = p_table and source_id = p_id;
    return;
  end if;
  insert into public.search_index as s
    (workspace_id, project_id, agent_id, type, source_table, source_id, grp, path, title, content, tags, meta, created_at, updated_at)
  values
    (p_ws, p_project, p_agent, p_type, p_table, p_id, p_grp, p_path, p_title, left(p_content, 200000),
     coalesce(p_tags, '{}'), coalesce(p_meta, '{}'), coalesce(p_at, now()), coalesce(p_at, now()))
  on conflict (source_table, source_id) do update set
    workspace_id = excluded.workspace_id, project_id = excluded.project_id, agent_id = excluded.agent_id,
    type = excluded.type, grp = excluded.grp, path = excluded.path, title = excluded.title,
    content = excluded.content, tags = excluded.tags, meta = excluded.meta, updated_at = excluded.updated_at;
end $$;

create or replace function public.search_index_drop(p_table text, p_id uuid) returns void
language sql as $$
  delete from public.search_index where source_table = p_table and source_id = p_id
$$;

-- Une fonction par source : lit la ligne et la (ré)indexe. Appelée par les
-- triggers et par le remplissage initial.

create or replace function public.search_sync_rag_chunk(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select c.id, c.workspace_id, c.project_id, c.content, c.created_at, c.agent_id, c.source_id, c.collection_id,
         s.title as source_title, s.source_ref, s.type as source_type, col.name as collection_name
    into r
    from public.rag_chunks c
    left join public.rag_sources s on s.id = c.source_id
    left join public.rag_collections col on col.id = c.collection_id
   where c.id = p_id;
  if r.id is null then perform public.search_index_drop('rag_chunks', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, null, 'documents', 'rag_chunks', r.id,
    'doc:' || coalesce(r.source_id::text, r.id::text),
    'documents/' || coalesce(public.search_slug(r.collection_name), 'projet') || '/' || coalesce(public.search_slug(r.source_title), 'sans-titre'),
    coalesce(r.source_title, 'Document'), r.content,
    array_remove(array[r.source_type, public.search_slug(r.collection_name)], null),
    jsonb_strip_nulls(jsonb_build_object('url', r.source_ref, 'collection', r.collection_name, 'collection_id', r.collection_id,
      'rag_source_id', r.source_id, 'rag_agent_id', r.agent_id)),
    r.created_at);
end $$;

create or replace function public.search_sync_memory(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.internal_agent_memories where id = p_id;
  if r.id is null then perform public.search_index_drop('internal_agent_memories', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, r.agent_id, 'memory', 'internal_agent_memories', r.id,
    'memory:' || coalesce(r.agent_id::text, ''), 'memory/' || r.kind, 'Mémoire · ' || r.kind, r.content,
    array[r.kind] || case when r.is_pinned then array['epinglee'] else '{}'::text[] end,
    jsonb_build_object('kind', r.kind, 'importance', r.importance, 'pinned', r.is_pinned, 'source', r.source),
    coalesce(r.updated_at, r.created_at));
end $$;

create or replace function public.search_sync_team_memory(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.internal_agent_team_memories where id = p_id;
  if r.id is null then perform public.search_index_drop('internal_agent_team_memories', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, null, 'team', 'internal_agent_team_memories', r.id,
    'team:' || coalesce(r.project_id::text, r.workspace_id::text), 'team/' || r.kind, 'Équipe · ' || r.kind, r.content,
    array[r.kind],
    jsonb_strip_nulls(jsonb_build_object('kind', r.kind, 'importance', r.importance, 'author_agent', r.author_agent)),
    coalesce(r.updated_at, r.created_at));
end $$;

create or replace function public.search_sync_entity(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.knowledge_entities where id = p_id;
  if r.id is null then perform public.search_index_drop('knowledge_entities', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, null, 'facts', 'knowledge_entities', r.id,
    'entity:' || r.id, 'facts/' || r.kind || '/' || coalesce(public.search_slug(r.name), 'entite'), r.name,
    concat_ws(E'\n', r.name || ' (' || r.kind || ')', r.summary,
      case when cardinality(r.aliases) > 0 then 'Aussi : ' || array_to_string(r.aliases, ', ') end),
    r.aliases || r.tags || array[r.kind],
    jsonb_build_object('kind', r.kind, 'importance', r.importance, 'entity_id', r.id),
    r.updated_at);
end $$;

create or replace function public.search_sync_fact(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select f.id, f.workspace_id, f.entity_id, f.statement, f.kind, f.importance, f.confidence, f.superseded_by, f.source_ref, f.updated_at,
         e.name as entity_name, e.kind as entity_kind, e.project_id, e.aliases, e.tags
    into r
    from public.knowledge_facts f join public.knowledge_entities e on e.id = f.entity_id
   where f.id = p_id;
  -- Un fait remplacé n'est plus cherché.
  if r.id is null or r.superseded_by is not null then perform public.search_index_drop('knowledge_facts', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, null, 'facts', 'knowledge_facts', r.id,
    'entity:' || r.entity_id, 'facts/' || r.entity_kind || '/' || coalesce(public.search_slug(r.entity_name), 'entite'),
    r.entity_name, r.statement,
    r.aliases || r.tags || array[r.kind],
    jsonb_strip_nulls(jsonb_build_object('kind', r.kind, 'importance', r.importance, 'confidence', r.confidence,
      'entity_id', r.entity_id, 'source_ref', r.source_ref)),
    r.updated_at);
end $$;

create or replace function public.search_sync_deliverable(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select d.*, a.workspace_id, a.project_id into r
    from public.internal_agent_deliverables d left join public.internal_agents a on a.id = d.agent_id
   where d.id = p_id;
  if r.id is null then perform public.search_index_drop('internal_agent_deliverables', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, r.agent_id, 'past_work', 'internal_agent_deliverables', r.id,
    'deliverable:' || r.id, 'past_work/' || coalesce(public.search_slug(r.kind), 'livrable') || '/' || coalesce(public.search_slug(r.name), 'sans-titre'),
    r.name, coalesce(nullif(r.content, ''), r.file_url, ''),
    array[r.kind],
    jsonb_strip_nulls(jsonb_build_object('kind', r.kind, 'run_id', r.run_id, 'mission_id', r.mission_id, 'file_url', r.file_url)),
    r.created_at);
end $$;

create or replace function public.search_sync_office_document(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.office_documents where id = p_id;
  if r.id is null or r.is_archived then perform public.search_index_drop('office_documents', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, null, 'artifacts', 'office_documents', r.id,
    'artifact:' || r.id, 'artifacts/' || r.kind || '/' || coalesce(public.search_slug(r.title), 'sans-titre'),
    r.title, coalesce(r.preview_text, ''),
    r.tags || array[r.kind],
    jsonb_build_object('kind', r.kind),
    r.updated_at);
end $$;

create or replace function public.search_sync_message(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select m.id, m.agent_id, m.role, m.content, m.created_at, m.conversation_id, c.workspace_id, c.project_id, c.title
    into r
    from public.internal_agent_messages m join public.internal_agent_conversations c on c.id = m.conversation_id
   where m.id = p_id;
  -- Les messages d'outil sont des données brutes : la timeline les garde, pas l'index.
  if r.id is null or r.role not in ('user', 'assistant') then perform public.search_index_drop('internal_agent_messages', p_id); return; end if;
  perform public.search_index_put(
    r.workspace_id, r.project_id, r.agent_id, 'conversation', 'internal_agent_messages', r.id,
    'conversation:' || r.conversation_id,
    'conversation/' || coalesce(public.search_slug(r.title), 'conversation') || '-' || left(r.conversation_id::text, 8) || '/' || r.role,
    coalesce(r.title, 'Conversation'), r.content,
    array[r.role],
    jsonb_build_object('conversation_id', r.conversation_id, 'role', r.role),
    r.created_at);
end $$;

-- ── Triggers ─────────────────────────────────────────────────────────────────

create or replace function public.search_index_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  if tg_op = 'DELETE' then
    perform public.search_index_drop(tg_table_name, v_id);
    -- Une entité supprimée emporte ses faits (cascade) : leurs lignes aussi.
    if tg_table_name = 'knowledge_entities' then
      delete from public.search_index where grp = 'entity:' || v_id;
    end if;
    return old;
  end if;
  case tg_table_name
    when 'rag_chunks' then perform public.search_sync_rag_chunk(v_id);
    when 'internal_agent_memories' then perform public.search_sync_memory(v_id);
    when 'internal_agent_team_memories' then perform public.search_sync_team_memory(v_id);
    when 'knowledge_entities' then
      perform public.search_sync_entity(v_id);
      -- Le nom ou la nature de l'entité est dans le chemin de ses faits.
      if tg_op = 'UPDATE' and (old.name is distinct from new.name or old.kind is distinct from new.kind) then
        perform public.search_sync_fact(f.id) from public.knowledge_facts f where f.entity_id = v_id;
      end if;
    when 'knowledge_facts' then perform public.search_sync_fact(v_id);
    when 'internal_agent_deliverables' then perform public.search_sync_deliverable(v_id);
    when 'office_documents' then perform public.search_sync_office_document(v_id);
    when 'internal_agent_messages' then perform public.search_sync_message(v_id);
    else null;
  end case;
  return new;
end $$;

drop trigger if exists search_index_sync on public.rag_chunks;
create trigger search_index_sync after insert or update of content, source_id, collection_id or delete
  on public.rag_chunks for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.internal_agent_memories;
create trigger search_index_sync after insert or update of content, kind, importance, is_pinned or delete
  on public.internal_agent_memories for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.internal_agent_team_memories;
create trigger search_index_sync after insert or update of content, kind, importance or delete
  on public.internal_agent_team_memories for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.knowledge_entities;
create trigger search_index_sync after insert or update of name, kind, summary, aliases, tags or delete
  on public.knowledge_entities for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.knowledge_facts;
create trigger search_index_sync after insert or update of statement, kind, importance, superseded_by or delete
  on public.knowledge_facts for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.internal_agent_deliverables;
create trigger search_index_sync after insert or update of name, kind, content, file_url or delete
  on public.internal_agent_deliverables for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.office_documents;
create trigger search_index_sync after insert or update of title, preview_text, tags, is_archived or delete
  on public.office_documents for each row execute function public.search_index_trigger();
drop trigger if exists search_index_sync on public.internal_agent_messages;
create trigger search_index_sync after insert or update of content or delete
  on public.internal_agent_messages for each row execute function public.search_index_trigger();

-- ── Lecture ──────────────────────────────────────────────────────────────────

-- Ce qu'un agent peut lire : son espace ; son projet, ou rien de propre à un
-- projet (le graphe vaut pour tout l'espace) ; ses lignes privées, pas celles
-- des autres agents. Et pour les documents, les collections qu'il a le droit
-- de consulter (p_collections), comme search_knowledge dans l'ancien moteur :
--   null           tout le projet (un agent hors pools, sans collection désignée) ;
--   [c1, c2…]      ces collections seulement (collections désignées, ou celles
--                  de ses pools en mode pools) ;
--   []             aucun document.

-- Le grep : `p_regexes` sont des expressions régulières sur le texte plié
-- (minuscules, sans accents). p_all : toutes doivent correspondre ; sinon une
-- au moins. Le score est le nombre d'expressions trouvées (plus 1 si le titre
-- en contient une) ; à score égal, le plus récent d'abord.
--
create or replace function public.search_grep(
  p_workspace uuid, p_project uuid, p_agent uuid, p_types text[], p_regexes text[],
  p_all boolean default false, p_path text default null, p_limit int default 50, p_offset int default 0,
  p_collections uuid[] default null
) returns table (
  id uuid, type text, path text, title text, content text, tags text[], meta jsonb,
  grp text, source_table text, source_id uuid, score int, updated_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
declare
  r text;
  cond text := '';
  score text := '';
  q text;
begin
  if p_regexes is null or coalesce(array_length(p_regexes, 1), 0) = 0 then return; end if;
  foreach r in array p_regexes loop
    cond := cond || case when cond = '' then '' when p_all then ' and ' else ' or ' end || format('s.doc ~ %L', r);
    score := score || case when score = '' then '' else ' + ' end || format('(s.doc ~ %L)::int', r);
  end loop;
  q := format($q$
    select s.id, s.type, s.path, s.title, s.content, s.tags, s.meta, s.grp, s.source_table, s.source_id,
           (%s + case when %s then 1 else 0 end)::int as score, s.updated_at
      from public.search_index s
     where s.workspace_id = %L
       and (s.project_id is null or s.project_id = %L or s.type = 'facts')
       and (s.agent_id is null or s.agent_id = %L)
       and s.type = any(%L::text[])
       and (%L::text is null or s.path like %L)
       and (s.type <> 'documents' or %L::uuid[] is null or s.collection_id = any(%L::uuid[]))
       and (%s)
     order by score desc, s.updated_at desc
     limit %s offset %s$q$,
    score,
    replace(cond, 's.doc ~', 'public.search_fold(coalesce(s.title, '''')) ~'),
    p_workspace, p_project, p_agent, p_types, p_path, p_path, p_collections, p_collections, cond,
    greatest(1, least(coalesce(p_limit, 50), 500)), greatest(0, coalesce(p_offset, 0)));
  return query execute q;
end $$;

-- Relire des lignes trouvées, ou tout leur groupe (le document entier, la conversation…).
create or replace function public.search_read(
  p_workspace uuid, p_project uuid, p_agent uuid, p_ids uuid[], p_whole boolean default false, p_limit int default 60,
  p_collections uuid[] default null
) returns table (
  id uuid, type text, path text, title text, content text, tags text[], meta jsonb,
  grp text, source_table text, source_id uuid, score int, updated_at timestamptz
) language sql stable security definer set search_path = public as $$
  with visible as (
    select s.* from public.search_index s
     where s.workspace_id = p_workspace
       and (s.project_id is null or s.project_id = p_project or s.type = 'facts')
       and (s.agent_id is null or s.agent_id = p_agent)
       and (s.type <> 'documents' or p_collections is null or s.collection_id = any(p_collections))
  ), picked as (
    select v.grp from visible v where v.id = any(p_ids)
  )
  select v.id, v.type, v.path, v.title, v.content, v.tags, v.meta, v.grp, v.source_table, v.source_id, 0, v.updated_at
    from visible v
   where v.id = any(p_ids) or (p_whole and v.grp in (select grp from picked))
   order by v.grp, v.created_at, v.id
   limit greatest(1, least(coalesce(p_limit, 60), 300))
$$;

revoke all on function public.search_grep(uuid, uuid, uuid, text[], text[], boolean, text, int, int, uuid[]) from public, anon, authenticated;
revoke all on function public.search_read(uuid, uuid, uuid, uuid[], boolean, int, uuid[]) from public, anon, authenticated;

-- ── Remplissage initial ──────────────────────────────────────────────────────

select public.search_sync_rag_chunk(id) from public.rag_chunks;
select public.search_sync_memory(id) from public.internal_agent_memories;
select public.search_sync_team_memory(id) from public.internal_agent_team_memories;
select public.search_sync_entity(id) from public.knowledge_entities;
select public.search_sync_fact(id) from public.knowledge_facts;
select public.search_sync_deliverable(id) from public.internal_agent_deliverables;
select public.search_sync_office_document(id) from public.office_documents;
select public.search_sync_message(id) from public.internal_agent_messages;
