-- 0259_policyguard.sql
-- PolicyGuard — ce qu'un agent a le droit de faire seul, par équipe et par
-- environnement, et la trace de chaque décision.
--
-- Réglé par l'usage `policy_guard` de typesafe_settings (off / shadow / on).
-- Le runtime (_shared/policyguard.ts) donne à chaque action d'écriture un
-- niveau de risque (0 lecture · 1 écriture interne réversible · 2 effet visible
-- par un tiers · 3 irréversible ou engageant), le confronte à la grille de
-- l'équipe de l'agent, et journalise la décision. Il ne retire JAMAIS une
-- approbation que l'ancienne règle demandait.

-- ── La grille, par équipe ────────────────────────────────────────────────────
-- Une ligne par équipe (dashboard de service), plus une ligne projet
-- (service_dashboard_id NULL) qui sert de défaut. Sans aucune ligne, le runtime
-- applique sa grille par défaut : approbation dès le niveau 2, et même un agent
-- en autopilote demande au niveau 3.
create table if not exists public.policyguard_policies (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  project_id            uuid not null references public.projects(id) on delete cascade,
  service_dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  -- { interactive: {approve_at, block_at}, autonomous: {approve_at, block_at},
  --   autopilot_ceiling } — niveaux 0-3, null = jamais, plafond 4 = aucun.
  policy                jsonb not null default '{}'::jsonb,
  updated_by            uuid references auth.users(id) on delete set null,
  updated_at            timestamptz not null default now()
);

-- Une seule ligne par équipe, et une seule ligne projet.
create unique index if not exists policyguard_team_uidx
  on public.policyguard_policies (project_id, service_dashboard_id)
  where service_dashboard_id is not null;
create unique index if not exists policyguard_project_uidx
  on public.policyguard_policies (project_id)
  where service_dashboard_id is null;

alter table public.policyguard_policies enable row level security;

drop policy if exists "members read policyguard" on public.policyguard_policies;
create policy "members read policyguard" on public.policyguard_policies for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = policyguard_policies.workspace_id and wm.user_id = auth.uid()));

-- Durcir ou assouplir ce qu'un agent peut faire seul est une décision de
-- gouvernance : réservée aux administrateurs, comme typesafe_settings.
drop policy if exists "admins write policyguard" on public.policyguard_policies;
create policy "admins write policyguard" on public.policyguard_policies for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = policyguard_policies.workspace_id
                    and wm.user_id = auth.uid() and wm.role in ('owner', 'admin')))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = policyguard_policies.workspace_id
                    and wm.user_id = auth.uid() and wm.role in ('owner', 'admin')));

-- ── Le journal ───────────────────────────────────────────────────────────────
create table if not exists public.policy_decisions (
  id                    bigserial primary key,
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  project_id            uuid references public.projects(id) on delete cascade,
  agent_id              uuid,
  service_dashboard_id  uuid,
  run_id                uuid,
  conversation_id       uuid,

  -- interactive = quelqu'un est dans la conversation ; autonomous = mission,
  -- planification, room.
  environment           text not null check (environment in ('interactive', 'autonomous')),
  autopilot             boolean not null default false,

  tool                  text not null,
  action                text not null,
  risk_level            smallint not null check (risk_level between 0 and 3),
  risk_confidence       real,

  -- Ce que PolicyGuard décide / ce qui s'est appliqué / ce que l'ancienne
  -- règle décidait. En shadow, decision ≠ applied_decision : c'est la colonne
  -- qu'on lit avant de basculer.
  decision              text not null check (decision in ('allow', 'approve', 'block')),
  applied_decision      text not null check (applied_decision in ('allow', 'approve', 'block')),
  legacy_decision       text not null check (legacy_decision in ('allow', 'approve', 'block')),
  policy_source         text not null default 'default' check (policy_source in ('team', 'project', 'default')),
  reason                text,
  mode                  text not null check (mode in ('shadow', 'on')),

  -- La validation humaine qui a suivi (statut, auteur, date : lus dans
  -- internal_agent_approvals).
  approval_id           uuid references public.internal_agent_approvals(id) on delete set null,

  created_at            timestamptz not null default now()
);

create index if not exists policy_decisions_ws_idx
  on public.policy_decisions (workspace_id, created_at desc);
create index if not exists policy_decisions_project_idx
  on public.policy_decisions (project_id, created_at desc);

alter table public.policy_decisions enable row level security;

drop policy if exists "members read policy decisions" on public.policy_decisions;
create policy "members read policy decisions" on public.policy_decisions for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = policy_decisions.workspace_id and wm.user_id = auth.uid()));

comment on table public.policy_decisions is
  'PolicyGuard : chaque action d''écriture évaluée — niveau de risque, grille appliquée, décision (et décision d''avant), approbation humaine liée. Écriture service_role uniquement.';

-- ── Des garde-fous par équipe et par surface ─────────────────────────────────
-- Vide = pour tous. Une règle « pas de conseil médical » peut ne concerner que
-- les agents publics ; « pas d'engagement de prix » que l'équipe Commerciale.
alter table public.aiops_guardrails
  add column if not exists team_ids uuid[] not null default '{}',
  add column if not exists surfaces text[] not null default '{}';

comment on column public.aiops_guardrails.team_ids is
  'Équipes (service_dashboards) auxquelles la règle s''applique. Vide = toutes.';
comment on column public.aiops_guardrails.surfaces is
  'internal (agents internes) et/ou public (agents publics). Vide = les deux.';

-- ── Le genre d'outil `governance` (outil policy_audit) ───────────────────────
-- Même règle que 0236/0258 : la liste doit porter TOUS les genres déjà en base.
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'tracker', 'support', 'governance',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom'
    )
  );

comment on constraint internal_agent_tools_kind_check on public.internal_agent_tools is
  'Les genres d''outils que le runtime sait construire. Toute addition dans internal-agent-tools.ts doit passer ici, sans quoi la capacité est inaccordable.';
