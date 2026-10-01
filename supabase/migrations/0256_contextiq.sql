-- 0256_contextiq.sql
-- ContextIQ — le filtre de contexte RAG, bâti sur le jugement rapide (Jev).
--
-- Réglé par l'usage `rag_rerank` de typesafe_settings (off / shadow / on) :
-- aucun nouveau réglage. Cette table est le JOURNAL de chaque évaluation d'un
-- contexte récupéré — agents publics (rag-chat) et agents internes
-- (search_knowledge) : combien de passages remontés, combien gardés, la
-- couverture de la question (0 aucune · 1 partielle · 2 suffisante ·
-- 3 complète), la probabilité de contradiction, et si la recherche a été élargie.
--
-- Sa première utilité n'est pas le tri : c'est la liste des questions que la
-- base documentaire ne couvre pas. Elle se remplit dès le mode shadow.

create table if not exists public.contextiq_assessments (
  id              bigserial primary key,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  project_id      uuid references public.projects(id) on delete cascade,

  surface         text not null check (surface in ('public_agent', 'internal_agent')),
  -- rag_agents.id (public) ou internal_agents.id (interne) : pas de clé
  -- étrangère, les deux tables vivent côte à côte.
  agent_id        uuid,
  run_id          uuid,
  conversation_id uuid,

  question        text not null,
  mode            text not null check (mode in ('shadow', 'on')),
  applied         boolean not null default false,

  retrieved       int not null default 0,
  kept            int not null default 0,
  coverage        smallint check (coverage between 0 and 3),
  contradiction   real,
  widened         boolean not null default false,
  collection_ids  uuid[] not null default '{}',
  -- Les passages GARDÉS : id, note 0-3, similarité, origine, extrait court.
  passages        jsonb not null default '[]'::jsonb,

  latency_ms      int,
  -- Un trou relu et traité (document ajouté, question hors périmètre) sort de
  -- la liste sans que la ligne disparaisse du journal.
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users(id) on delete set null,

  created_at      timestamptz not null default now()
);

create index if not exists contextiq_ws_created_idx
  on public.contextiq_assessments (workspace_id, created_at desc);
create index if not exists contextiq_gaps_idx
  on public.contextiq_assessments (workspace_id, coverage)
  where coverage <= 1 and resolved_at is null;

alter table public.contextiq_assessments enable row level security;

drop policy if exists "members read contextiq" on public.contextiq_assessments;
create policy "members read contextiq" on public.contextiq_assessments for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = contextiq_assessments.workspace_id and wm.user_id = auth.uid()));

-- Les membres peuvent seulement marquer un trou comme traité ; l'écriture des
-- évaluations reste au service_role (fonctions edge).
drop policy if exists "members resolve contextiq" on public.contextiq_assessments;
create policy "members resolve contextiq" on public.contextiq_assessments for update
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = contextiq_assessments.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = contextiq_assessments.workspace_id and wm.user_id = auth.uid()));

comment on table public.contextiq_assessments is
  'ContextIQ : évaluation Jev de chaque contexte RAG (passages gardés, couverture 0-3, contradiction). Les lignes à couverture ≤ 1 sont les trous de la base documentaire.';
