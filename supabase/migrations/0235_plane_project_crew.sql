-- 0235_plane_project_crew.sql
-- L'équipage d'un projet, et le travail confié à ses agents.
--
-- Deux manques que ce fichier comble, et qui n'en font qu'un.
--
-- 1. UN PROJET N'AVAIT PAS DE MEMBRES. Les personnes proposées à l'assignation
--    étaient celles de l'espace de travail entier : sur un service à quarante
--    personnes, choisir un assigné revenait à parcourir un annuaire. Les agents,
--    eux, avaient déjà leur périmètre (`pj_project_agents`, 0232) — les humains
--    n'avaient rien d'équivalent.
--
-- 2. UNE MISSION N'AVAIT AUCUN LIEN AVEC LE TRAVAIL. Un agent pouvait recevoir
--    un brief et produire des livrables, mais rien ne rattachait ce qu'il avait
--    produit au work item qui l'avait motivé. Le résultat existait ; la preuve
--    qu'il répondait à quelque chose, non.
--
-- Les deux se rejoignent : on met quelqu'un — humain ou machine — sur un projet,
-- on lui confie un work item, et ce qu'il en sort revient s'accrocher à ce work
-- item. C'est la même chaîne, qu'elle passe par une personne ou par un agent.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Les membres humains d'un projet
-- ────────────────────────────────────────────────────────────────────────────
-- Table JUMELLE de `pj_project_agents`, et non une table unique à colonne
-- polymorphe : un membre référence `auth.users`, un agent `internal_agents`, et
-- une clé étrangère qui pointerait tantôt sur l'un tantôt sur l'autre n'en
-- serait plus une. Les deux tables portent le même vocabulaire de rôles, ce qui
-- suffit à les traiter ensemble côté interface.
create table if not exists public.pj_project_members (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  -- 'lead' porte le projet, 'contributor' y travaille, 'observer' le lit.
  -- Trois rangs et pas davantage : au-delà, personne ne sait plus lequel donne
  -- quel droit, et tout le monde choisit le plus élevé.
  role           text not null default 'contributor'
                   check (role in ('lead', 'contributor', 'observer')),
  added_by       uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (pj_project_id, user_id)
);

create index if not exists idx_pj_project_members_project on public.pj_project_members(pj_project_id);
create index if not exists idx_pj_project_members_user on public.pj_project_members(user_id);

comment on table public.pj_project_members is
  'Les personnes d''un projet. Jumelle de pj_project_agents : ensemble, elles forment l''équipage — humains et agents traités du même vocabulaire.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Une mission attachée à du travail réel
-- ────────────────────────────────────────────────────────────────────────────
-- La mission existait déjà (0025) avec son brief, ses critères d'acceptation et
-- ses livrables attendus. Il lui manquait de savoir SUR QUOI elle porte.
alter table public.internal_agent_missions
  add column if not exists pj_project_id uuid references public.pj_projects(id) on delete set null;

alter table public.internal_agent_missions
  add column if not exists pj_issue_id uuid references public.pj_issues(id) on delete set null;

create index if not exists idx_missions_pj_issue
  on public.internal_agent_missions (pj_issue_id) where pj_issue_id is not null;
create index if not exists idx_missions_pj_project
  on public.internal_agent_missions (pj_project_id) where pj_project_id is not null;

comment on column public.internal_agent_missions.pj_issue_id is
  'Le work item que cette mission sert. C''est lui qui transforme un livrable en PREUVE : sans ce lien, on a un résultat sans question à laquelle il répond.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  execute 'alter table public.pj_project_members enable row level security';
  execute 'drop policy if exists "workspace members access pj_project_members" on public.pj_project_members';
  execute $p$
    create policy "workspace members access pj_project_members" on public.pj_project_members
      for all using (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = pj_project_members.workspace_id and wm.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = pj_project_members.workspace_id and wm.user_id = auth.uid()
        )
      )
  $p$;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Les preuves d'un projet
-- ────────────────────────────────────────────────────────────────────────────
-- Ce que les agents ont RÉELLEMENT produit sur ce projet, avec de quoi le
-- vérifier : quel work item, quel agent, quel run, combien de temps, combien
-- ça a coûté, et si le run a abouti.
--
-- Un livrable sans ces colonnes n'est qu'un fichier de plus. Avec elles, il
-- devient vérifiable : on remonte du résultat à la demande qui l'a produit, et
-- on voit si la machine a réellement fini ou si elle s'est arrêtée en chemin.
create or replace function public.pj_project_deliverables(p_project uuid)
returns table (
  id            uuid,
  kind          text,
  name          text,
  content       text,
  file_url      text,
  created_at    timestamptz,
  agent_id      uuid,
  agent_name    text,
  mission_id    uuid,
  mission_title text,
  issue_id      uuid,
  issue_name    text,
  issue_ref     text,
  run_id        uuid,
  run_status    text,
  run_cost_usd  numeric,
  run_seconds   int
) language sql stable as $$
  select d.id, d.kind, d.name, d.content, d.file_url, d.created_at,
         d.agent_id, a.name,
         d.mission_id, m.title,
         m.pj_issue_id, i.name,
         case when i.id is null then null else p.identifier || '-' || i.sequence_id end,
         r.id, r.status, r.cost_usd,
         -- La durée en secondes plutôt que deux horodatages : c'est ce qu'on
         -- lit (« 4 min »), et le calcul côté client se referait à chaque rendu.
         case
           when r.started_at is null or r.finished_at is null then null
           else extract(epoch from (r.finished_at - r.started_at))::int
         end
  from public.internal_agent_deliverables d
  join public.internal_agent_missions m on m.id = d.mission_id
  left join public.internal_agents a on a.id = d.agent_id
  left join public.internal_agent_runs r on r.id = d.run_id
  left join public.pj_issues i on i.id = m.pj_issue_id
  left join public.pj_projects p on p.id = coalesce(m.pj_project_id, i.pj_project_id)
  where coalesce(m.pj_project_id, i.pj_project_id) = p_project
  order by d.created_at desc;
$$;

comment on function public.pj_project_deliverables is
  'Les livrables produits par les agents sur un projet, avec leur preuve : work item d''origine, agent, run, statut, coût et durée.';

-- La file d'un agent, restreinte à un projet. Sert à l'onglet Équipage : voir
-- ce que porte chaque agent sans charger tout son travail.
create or replace function public.pj_project_agent_load(p_project uuid)
returns table (agent_id uuid, open_count int, done_count int) language sql stable as $$
  select ia.agent_id,
         count(*) filter (where i.completed_at is null)::int,
         count(*) filter (where i.completed_at is not null)::int
  from public.pj_issue_agents ia
  join public.pj_issues i on i.id = ia.issue_id
  where i.pj_project_id = p_project and i.archived_at is null
  group by ia.agent_id;
$$;
