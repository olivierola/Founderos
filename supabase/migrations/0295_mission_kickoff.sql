-- 0295 — Une mission confiée à une ÉQUIPE d'agents, et non plus remplie à la main.
--
-- Jusqu'ici, créer une mission, c'était ouvrir un tableau vide : l'humain
-- écrivait ensuite chaque work item, chaque brief, chaque date, puis les
-- assignait. Désormais l'humain dit CE QU'IL VEUT — un titre, une description,
-- le brief complet, les livrables attendus — et l'équipe fait le reste :
--
--   1. CADRAGE — l'agent qui pilote lit le brief et en tire sa compréhension,
--      ses hypothèses, ses risques et ses questions ; les responsables des
--      autres équipes la challengent, chacun depuis son métier.
--   2. QUESTIONS — ce qui reste flou part vers l'humain. Le plan attend ses
--      réponses (ou son « continuez sans »).
--   3. PLAN — le pilote découpe la mission en work items, fixe des délais
--      réalistes POUR DES AGENTS (des heures, pas des semaines), pose les
--      dépendances et confie chaque item à une équipe.
--   4. RÉPARTITION — chaque équipe affine ses items, les redécoupe au besoin,
--      et les répartit entre ses agents selon leurs outils et capacités.
--   5. EXÉCUTION — la file autonome existante (0242–0250) prend le relais,
--      dans l'ordre des dépendances.
--
-- Tout se joue dans internal-agent-a2a (l'équipe se concerte : c'est de
-- l'agent-à-agent), une étape par appel, relancée par le planificateur si un
-- appel se perd. Chaque prise de parole est un vrai appel au modèle, avec la
-- persona, les instructions et les outils de l'agent qui parle.

-- ── La mission : ce que l'humain demande, et où en est son cadrage ───────────
alter table public.pj_projects
  add column if not exists brief text,
  -- [{ "title": "...", "description": "..." }] — ce qui doit sortir de la mission.
  add column if not exists deliverables jsonb not null default '[]'::jsonb,
  -- Les équipes du service (service_dashboards.settings.teams) mises dessus ;
  -- vide = tout le service.
  add column if not exists planning_teams jsonb not null default '[]'::jsonb,
  add column if not exists planning_status text not null default 'none',
  -- L'étape en cours, et où elle en est : « scoping:lead », « scoping:review:2 »,
  -- « planning:team:1 »… Le planificateur reprend une mission là où elle s'est
  -- arrêtée.
  add column if not exists planning_step text,
  add column if not exists planning_lead_agent_id uuid references public.internal_agents(id) on delete set null,
  -- La compréhension consolidée de l'équipe, en clair : le brief tel qu'elle
  -- l'a reformulé, hypothèses et décisions comprises.
  add column if not exists planning_summary text,
  -- Lancer l'exécution sans attendre de validation une fois le plan prêt.
  add column if not exists planning_autostart boolean not null default false,
  add column if not exists planning_error text,
  add column if not exists planning_updated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pj_projects_planning_status_check') then
    alter table public.pj_projects add constraint pj_projects_planning_status_check
      check (planning_status in ('none', 'scoping', 'questions', 'planning', 'planned', 'executing', 'failed'));
  end if;
end $$;

-- Le planificateur cherche les cadrages en cours, et seulement eux.
create index if not exists idx_pj_projects_planning
  on public.pj_projects (planning_updated_at)
  where planning_status in ('scoping', 'planning');

-- ── Un work item sait à quelle équipe il revient ─────────────────────────────
alter table public.pj_issues
  add column if not exists team_id text,
  -- La durée estimée par l'équipe, en heures de travail d'agent.
  add column if not exists estimate_hours numeric,
  add column if not exists planned_by_agent uuid references public.internal_agents(id) on delete set null;

create index if not exists idx_pj_issues_team on public.pj_issues (pj_project_id, team_id);

-- ── La concertation : le fil de l'équipe sur la mission ──────────────────────
create table if not exists public.pj_mission_discussion (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  -- Un agent parle, ou un humain (author_user) : jamais les deux.
  agent_id       uuid references public.internal_agents(id) on delete set null,
  author_user    uuid references auth.users(id) on delete set null,
  kind           text not null default 'note'
                 check (kind in ('analysis', 'challenge', 'proposal', 'question', 'answer', 'plan', 'assignment', 'decision', 'note')),
  content        text not null,
  -- Ce que la prise de parole a produit de structuré (questions, items…).
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_pj_mission_discussion
  on public.pj_mission_discussion (pj_project_id, created_at);

-- ── Les questions de l'équipe à l'humain ─────────────────────────────────────
create table if not exists public.pj_mission_questions (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  asked_by_agent uuid references public.internal_agents(id) on delete set null,
  question       text not null,
  -- Pourquoi la question compte : ce qui change selon la réponse.
  why            text,
  -- Une réponse proposée par l'équipe, que l'humain peut accepter telle quelle.
  suggestion     text,
  status         text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer         text,
  answered_by    uuid references auth.users(id) on delete set null,
  answered_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists idx_pj_mission_questions
  on public.pj_mission_questions (pj_project_id, status);

-- Même règle que le reste du suivi (0221) : les membres de l'espace lisent et
-- écrivent ; l'équipe d'agents écrit en service role.
alter table public.pj_mission_discussion enable row level security;
alter table public.pj_mission_questions enable row level security;
do $$
declare t text;
begin
  foreach t in array array['pj_mission_discussion', 'pj_mission_questions'] loop
    execute format('drop policy if exists "workspace members access %s" on public.%I', t, t);
    execute format($p$
      create policy "workspace members access %s" on public.%I for all
        using (exists (select 1 from public.workspace_members wm
                        where wm.workspace_id = %I.workspace_id and wm.user_id = auth.uid()))
        with check (exists (select 1 from public.workspace_members wm
                             where wm.workspace_id = %I.workspace_id and wm.user_id = auth.uid()))
    $p$, t, t, t, t);
  end loop;
end $$;

-- ── La vie d'équipe : les échanges qu'un agent lance de lui-même ─────────────
-- 0294 a donné aux échanges leur genre ('idea', 'challenge', 'debate'). Un
-- échange lancé par un agent, sans personne derrière, porte ici sa raison :
-- c'est ce qui permet de compter, par service et par jour, ce que l'équipe
-- s'est autorisé, et de le borner.
alter table public.internal_agent_a2a_messages
  add column if not exists initiated_by_agent boolean not null default false;

do $$
begin
  alter table public.internal_agent_a2a_messages drop constraint if exists internal_agent_a2a_messages_kind_check;
  alter table public.internal_agent_a2a_messages
    add constraint internal_agent_a2a_messages_kind_check
    check (kind in ('message', 'idea', 'challenge', 'debate', 'review'));
end $$;

create index if not exists idx_a2a_initiated_recent
  on public.internal_agent_a2a_messages (created_at desc) where initiated_by_agent;

-- Le rythme de la vie d'équipe, par service : la dernière tentative et le
-- compte du jour. Une table à part plutôt qu'un champ des réglages : le
-- planificateur l'écrit souvent, et une écriture concurrente des réglages
-- (équipes, apparence) ne doit jamais être écrasée par lui.
create table if not exists public.service_team_life (
  dashboard_id    uuid primary key references public.service_dashboards(id) on delete cascade,
  last_attempt_at timestamptz,
  day             date,
  attempts        int not null default 0
);
alter table public.service_team_life enable row level security;
-- Aucune politique : seul le service role y touche.
