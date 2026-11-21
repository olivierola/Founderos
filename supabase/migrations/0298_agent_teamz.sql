-- 0298 — Teamz : des équipes entières d'agents, conçues d'une phrase.
--
-- Une équipe déployée vit, comme les autres, dans
-- service_dashboards.settings.teams (avec, en plus, son flux A2A `links`, ses
-- règles `playbook` et son estimation de temps). Ce qui manquait :
--
--   · agent_team_blueprints — le PLAN d'une équipe, entre sa conception par
--     l'architecte (une demande en langage naturel → rôles, prompts, liens,
--     routines, score qualité) et son déploiement. La conception coûte un
--     appel de modèle lourd : le plan est gardé pour être relu, retouché et
--     déployé sans être reconçu, et reste ensuite la trace de ce qui a été
--     installé (statut, équipe, agents créés). Écrit par les fonctions en
--     service role ; lu par les membres de l'espace (l'écran Teamz).
--
--   · ai_artifacts.kind 'team_blueprint' — la carte d'équipe que le panneau
--     Assistant affiche sous sa réponse (plan, score, bouton Déployer).
--
--   · internal_agent_a2a_messages.kind 'handoff' — une passation structurée
--     entre coéquipiers (handoff_to_teammate) : tracée dans le fil A2A pour
--     que le Live Space et la constellation de l'équipe la montrent. Le
--     travail lui-même part en mission ; ce message est déjà « answered ».

create table if not exists public.agent_team_blueprints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  service_dashboard_id uuid references public.service_dashboards(id) on delete set null,
  brief text not null default '',
  name text not null default '',
  template_key text,
  blueprint jsonb not null,
  quality jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'deployed', 'discarded')),
  team_id text,
  agent_ids uuid[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deployed_at timestamptz
);

create index if not exists idx_agent_team_blueprints_service
  on public.agent_team_blueprints (service_dashboard_id, created_at desc);

alter table public.agent_team_blueprints enable row level security;
drop policy if exists "workspace members read team blueprints" on public.agent_team_blueprints;
create policy "workspace members read team blueprints" on public.agent_team_blueprints for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = agent_team_blueprints.workspace_id and wm.user_id = auth.uid()));
-- Aucune écriture côté navigateur : la conception et le déploiement passent
-- par internal-agent-a2a (team_design / team_deploy) et les assistants.
revoke insert, update, delete on public.agent_team_blueprints from anon, authenticated;

-- La carte d'équipe des réponses de l'Assistant.
alter table public.ai_artifacts drop constraint if exists ai_artifacts_kind_check;
alter table public.ai_artifacts
  add constraint ai_artifacts_kind_check check (
    kind in ('document', 'json', 'table', 'code', 'csv', 'connectors', 'team_blueprint')
  );

-- La passation entre coéquipiers, dans le fil A2A.
do $$
begin
  alter table public.internal_agent_a2a_messages drop constraint if exists internal_agent_a2a_messages_kind_check;
  alter table public.internal_agent_a2a_messages
    add constraint internal_agent_a2a_messages_kind_check
    check (kind in ('message', 'idea', 'challenge', 'debate', 'review', 'handoff'));
end $$;
