-- 0289_knowledge_graph.sql
-- Le graphe de connaissances de l'espace : une source de vérité PARTAGÉE par
-- tous les agents du workspace, rangée pour être retrouvée.
--
-- Jusqu'ici l'onglet Graph dessinait des souvenirs (internal_agent_memories) :
-- des phrases libres, chacune au nom d'UN agent, sans nom ni lien. Deux agents
-- qui apprenaient la même chose sur « Acme » en faisaient deux lignes que rien
-- ne rapprochait, et aucun des deux ne pouvait demander « que sait-on déjà
-- d'Acme ? » autrement qu'en relisant tout.
--
-- Le graphe range donc la connaissance comme on la cherche :
--
--   knowledge_entities  — une CHOSE nommée : une personne, un client, un
--                         produit, un système, une décision… Une seule ligne
--                         par chose et par workspace : son `key` (nom normalisé
--                         — minuscules, sans accents ni ponctuation) est unique,
--                         ses alias rattachent les autres façons de l'écrire.
--   knowledge_facts     — ce qu'on sait d'elle, une affirmation autoportante
--                         par ligne, avec sa source (quel agent, quel run). Un
--                         fait remplacé n'est pas effacé : il pointe vers celui
--                         qui le remplace (superseded_by), l'historique reste.
--   knowledge_relations — les liens nommés entre deux entités
--                         (« travaille_pour », « dépend_de », « remplace »…),
--                         en snake_case, un triplet unique.
--
-- Qui écrit : les agents, à tout moment (outil knowledge_save, et la capture
-- automatique en fin de run) — mais toujours à travers un MODÈLE DE DÉCISION
-- (_shared/knowledge-graph.ts) qui juge la pertinence, rattache aux entités
-- existantes et écarte le trivial, le transitoire, le doublon et le secret.
-- Les humains corrigent depuis l'onglet Graph.
--
-- Comment on lit : knowledge_search() — plein texte + trigrammes sur les noms
-- et alias + faits, et similarité vectorielle quand un embedding est fourni.
-- Une requête, quelques millisecondes : l'agent cherche AVANT de redemander.

create extension if not exists pg_trgm;

-- Le nom normalisé, côté SQL : le même pliage que entityKey() côté TypeScript
-- (minuscules, accents retirés, tout le reste réduit à des espaces).
create or replace function public.knowledge_key(p text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(
    translate(lower(coalesce(p, '')),
      'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ',
      'aaaaaaceeeeiiiinooooouuuuyyoa'),
    '[^a-z0-9]+', ' ', 'g'));
$$;

create table if not exists public.knowledge_entities (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  project_id       uuid,
  key              text not null,
  name             text not null check (char_length(name) between 1 and 160),
  kind             text not null default 'concept' check (kind in (
                     'person', 'organization', 'customer', 'product', 'project', 'system',
                     'document', 'process', 'decision', 'place', 'event', 'concept')),
  summary          text,
  aliases          text[] not null default '{}',
  tags             text[] not null default '{}',
  importance       smallint not null default 3 check (importance between 1 and 5),
  mentions         integer not null default 1,
  embedding        vector(1024),
  search           tsvector,
  created_by_agent uuid references public.internal_agents(id) on delete set null,
  created_by_user  uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, key)
);

create table if not exists public.knowledge_facts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  entity_id       uuid not null references public.knowledge_entities(id) on delete cascade,
  key             text not null,
  statement       text not null check (char_length(statement) between 1 and 800),
  kind            text not null default 'fact' check (kind in (
                    'fact', 'decision', 'procedure', 'metric', 'preference', 'event', 'risk', 'contact')),
  importance      smallint not null default 3 check (importance between 1 and 5),
  confidence      numeric(3,2),
  source_kind     text not null default 'agent' check (source_kind in ('agent', 'curator', 'user', 'backfill')),
  source_agent_id uuid references public.internal_agents(id) on delete set null,
  source_run_id   uuid,
  source_ref      text,
  superseded_by   uuid references public.knowledge_facts(id) on delete set null,
  search          tsvector,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (entity_id, key)
);

create table if not exists public.knowledge_relations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  from_entity     uuid not null references public.knowledge_entities(id) on delete cascade,
  to_entity       uuid not null references public.knowledge_entities(id) on delete cascade,
  relation        text not null check (relation ~ '^[a-z0-9_]{2,60}$'),
  note            text,
  source_agent_id uuid references public.internal_agents(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (from_entity, relation, to_entity),
  check (from_entity <> to_entity)
);

create index if not exists idx_kg_entities_ws on public.knowledge_entities(workspace_id, updated_at desc);
create index if not exists idx_kg_entities_search on public.knowledge_entities using gin(search);
create index if not exists idx_kg_entities_key_trgm on public.knowledge_entities using gin(key gin_trgm_ops);
create index if not exists idx_kg_facts_entity on public.knowledge_facts(entity_id) where superseded_by is null;
create index if not exists idx_kg_facts_search on public.knowledge_facts using gin(search);
create index if not exists idx_kg_rel_from on public.knowledge_relations(from_entity);
create index if not exists idx_kg_rel_to on public.knowledge_relations(to_entity);

-- La clé et l'index plein texte se tiennent à jour d'eux-mêmes : qu'une ligne
-- vienne d'un agent, d'un humain dans l'UI ou d'un import, elle est trouvable.
create or replace function public.knowledge_entities_touch()
returns trigger language plpgsql as $$
begin
  new.key := public.knowledge_key(new.name);
  new.aliases := coalesce(array(select distinct a from unnest(new.aliases) a where trim(a) <> ''), '{}');
  new.search :=
    setweight(to_tsvector('simple', public.knowledge_key(new.name)), 'A') ||
    setweight(to_tsvector('simple', public.knowledge_key(array_to_string(new.aliases, ' '))), 'A') ||
    setweight(to_tsvector('simple', public.knowledge_key(array_to_string(new.tags, ' '))), 'B') ||
    setweight(to_tsvector('simple', public.knowledge_key(coalesce(new.summary, ''))), 'C');
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_knowledge_entities_touch on public.knowledge_entities;
create trigger trg_knowledge_entities_touch before insert or update on public.knowledge_entities
  for each row execute function public.knowledge_entities_touch();

create or replace function public.knowledge_facts_touch()
returns trigger language plpgsql as $$
begin
  new.key := left(public.knowledge_key(new.statement), 300);
  new.search := to_tsvector('simple', public.knowledge_key(new.statement));
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_knowledge_facts_touch on public.knowledge_facts;
create trigger trg_knowledge_facts_touch before insert or update on public.knowledge_facts
  for each row execute function public.knowledge_facts_touch();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Partagé dans TOUT l'espace : chaque membre lit, chaque membre (hors
-- lecteur) corrige ; seuls owner/admin suppriment une entité entière.
alter table public.knowledge_entities enable row level security;
alter table public.knowledge_facts enable row level security;
alter table public.knowledge_relations enable row level security;

do $$
declare t text;
begin
  foreach t in array array['knowledge_entities', 'knowledge_facts', 'knowledge_relations'] loop
    execute format('drop policy if exists "members read %1$s" on public.%1$s', t);
    execute format($p$
      create policy "members read %1$s" on public.%1$s for select
        using (exists (select 1 from public.workspace_members wm
                        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $p$, t);
    execute format('drop policy if exists "members write %1$s" on public.%1$s', t);
    execute format($p$
      create policy "members write %1$s" on public.%1$s for insert
        with check (exists (select 1 from public.workspace_members wm
                             where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
                               and wm.role <> 'viewer'))
    $p$, t);
    execute format('drop policy if exists "members update %1$s" on public.%1$s', t);
    execute format($p$
      create policy "members update %1$s" on public.%1$s for update
        using (exists (select 1 from public.workspace_members wm
                        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
                          and wm.role <> 'viewer'))
    $p$, t);
  end loop;
end $$;

drop policy if exists "members delete knowledge_facts" on public.knowledge_facts;
create policy "members delete knowledge_facts" on public.knowledge_facts for delete
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = knowledge_facts.workspace_id and wm.user_id = auth.uid() and wm.role <> 'viewer'));
drop policy if exists "members delete knowledge_relations" on public.knowledge_relations;
create policy "members delete knowledge_relations" on public.knowledge_relations for delete
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = knowledge_relations.workspace_id and wm.user_id = auth.uid() and wm.role <> 'viewer'));
drop policy if exists "admins delete knowledge_entities" on public.knowledge_entities;
create policy "admins delete knowledge_entities" on public.knowledge_entities for delete
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = knowledge_entities.workspace_id and wm.user_id = auth.uid() and wm.role in ('owner', 'admin')));

-- ── La recherche ────────────────────────────────────────────────────────────
-- Une entité remonte si son nom, un alias, un tag, son résumé ou l'un de ses
-- faits en cours répond à la requête — et, avec un embedding, si elle en est
-- proche par le sens. Le score mélange les trois signaux ; un nom exact gagne
-- toujours.
--
-- SECURITY INVOKER : appelée depuis l'UI, elle ne voit que ce que la RLS
-- montre ; appelée par le moteur (service role), tout le workspace demandé.
create or replace function public.knowledge_search(
  p_workspace uuid,
  p_query text,
  p_kind text default null,
  p_limit int default 8,
  p_embedding vector(1024) default null
)
returns table (
  id uuid, name text, kind text, summary text, aliases text[], tags text[],
  importance smallint, mentions int, updated_at timestamptz, score real
)
language sql
stable
as $$
  with q as (
    select public.knowledge_key(p_query) as k,
           plainto_tsquery('simple', public.knowledge_key(p_query)) as ts,
           -- Chaque mot compte : « facturation acme » doit trouver une entité qui
           -- ne contient que l'un des deux.
           nullif(regexp_replace(trim(public.knowledge_key(p_query)), '\s+', ' | ', 'g'), '') as words
  ), qor as (
    select q.*, case when q.words is null then null else to_tsquery('simple', q.words) end as tsor from q
  ), fact_hits as (
    select f.entity_id, max(ts_rank(f.search, qor.tsor)) as r
      from public.knowledge_facts f, qor
     where f.workspace_id = p_workspace and f.superseded_by is null
       and qor.tsor is not null and f.search @@ qor.tsor
     group by f.entity_id
  )
  select e.id, e.name, e.kind, e.summary, e.aliases, e.tags, e.importance, e.mentions, e.updated_at,
         (
           case when e.key = qor.k or qor.k = any(array(select public.knowledge_key(a) from unnest(e.aliases) a)) then 3 else 0 end
           + coalesce(similarity(e.key, qor.k), 0) * 1.5
           + coalesce(ts_rank(e.search, qor.tsor), 0) * 2
           + coalesce(fh.r, 0)
           + case when p_embedding is not null and e.embedding is not null
                  then greatest(0, 1 - (e.embedding <=> p_embedding)) * 1.5 else 0 end
           + e.importance * 0.02
         )::real as score
    from public.knowledge_entities e
    cross join qor
    left join fact_hits fh on fh.entity_id = e.id
   where e.workspace_id = p_workspace
     and (p_kind is null or e.kind = p_kind)
     and (
       qor.k = ''
       or e.key % qor.k
       or e.key like '%' || qor.k || '%'
       or (qor.tsor is not null and e.search @@ qor.tsor)
       or fh.entity_id is not null
       or (p_embedding is not null and e.embedding is not null and (e.embedding <=> p_embedding) < 0.5)
     )
   order by score desc, e.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 8), 50));
$$;

grant execute on function public.knowledge_search(uuid, text, text, int, vector) to authenticated;

-- La mémoire d'avant reste où elle est ; le graphe la reprend une fois, par
-- lots (internal-agent-run, mode knowledge_backfill). Ceci marque ce qui est
-- déjà passé, pour ne jamais la retraiter.
alter table public.internal_agent_memories add column if not exists knowledge_curated_at timestamptz;
alter table public.internal_agent_team_memories add column if not exists knowledge_curated_at timestamptz;
