-- 0114_onboarding_generative.sql
-- Palier 1 of Agentic Onboarding: the "generative" layer. The unit the client
-- manipulates shifts from a hand-drawn *flow* to an activation *goal*. The agent
-- composes flows/tours/checklists as versioned, disposable artefacts under a
-- goal, then A/B-optimises them against a causal holdout.
--
-- Reuses existing infra rather than duplicating it:
--   · product_events        → the light event stream (runtime + measurement)
--   · event_definitions      → where the aha-moment (activation_event) is declared
--   · analytics_funnels/…    → the activation funnel + TTV
--   · activation_* engine    → the runtime intervention substrate
--   · rag_onboarding_flows/steps/runs/progress (0020) → generated artefacts + runs

-- ── Goals: the new primitive ────────────────────────────────────────────────
create table if not exists public.onboarding_goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  name text not null,
  -- The objective, declared in natural language (drives generation).
  objective text not null,
  -- Who this goal targets: { personas?: [], roles?: [], plans?: [], filter?: {} }.
  segment jsonb not null default '{}'::jsonb,
  -- The aha-moment: an event_name (joins product_events / event_definitions).
  activation_event text,
  -- Optional richer activation rule: { all?: [event], any?: [event], within_days? }.
  activation_rule jsonb not null default '{}'::jsonb,
  -- Guardrails the agent must respect: { max_nudges_per_session?, tone?, no_block?, locale? }.
  constraints jsonb not null default '{}'::jsonb,
  -- Causal attribution: % of enrolled users held out (receive no onboarding).
  holdout_pct int not null default 10 check (holdout_pct between 0 and 90),
  status text not null default 'draft'
    check (status in ('draft','active','paused','archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_onb_goals_project on public.onboarding_goals(project_id, status);
create index if not exists idx_onb_goals_agent on public.onboarding_goals(agent_id);

-- ── Flows become generated + versioned artefacts under a goal ────────────────
alter table public.rag_onboarding_flows
  add column if not exists goal_id uuid references public.onboarding_goals(id) on delete cascade,
  add column if not exists generated boolean not null default false,
  add column if not exists version int not null default 1,
  -- Variant label for A/B ('A','B',…); null = the single live parcours.
  add column if not exists variant text,
  -- Generative lifecycle, distinct from the runtime `enabled` matching flag.
  add column if not exists lifecycle_status text not null default 'draft'
    check (lifecycle_status in ('draft','live','archived')),
  -- { prompt, model, source: 'scan'|'description', experiment_id? }.
  add column if not exists generation_meta jsonb not null default '{}'::jsonb;
create index if not exists idx_onb_flows_goal on public.rag_onboarding_flows(goal_id, lifecycle_status);

-- ── Runs carry activation + holdout + experiment attribution ────────────────
alter table public.rag_onboarding_runs
  add column if not exists goal_id uuid references public.onboarding_goals(id) on delete set null,
  -- When the aha-moment fired for this run (drives TTV + activation rate).
  add column if not exists activated_at timestamptz,
  -- Causal control arm: this user was enrolled but deliberately received nothing.
  add column if not exists is_holdout boolean not null default false,
  add column if not exists experiment_id uuid,
  add column if not exists variant_label text;
create index if not exists idx_onb_runs_goal on public.rag_onboarding_runs(goal_id, status);
create index if not exists idx_onb_runs_holdout on public.rag_onboarding_runs(goal_id, is_holdout);

-- ── Experiments: A/B of generated variants against the holdout control ───────
create table if not exists public.onboarding_experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  goal_id uuid not null references public.onboarding_goals(id) on delete cascade,
  name text not null,
  -- The optimiser's hypothesis, e.g. "the 'connect Slack' step fires too early".
  hypothesis text,
  status text not null default 'running'
    check (status in ('running','decided','stopped')),
  -- [{ label, flow_id, weight }] — traffic allocation across variants.
  variants jsonb not null default '[]'::jsonb,
  -- 'holdout' = compare against the causal control; 'variant' = A vs B only.
  control text not null default 'holdout',
  metric text not null default 'activation',
  winner_flow_id uuid references public.rag_onboarding_flows(id) on delete set null,
  uplift numeric,
  started_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists idx_onb_experiments_goal on public.onboarding_experiments(goal_id, status);

-- The experiment_id FK on runs is added after the table exists (no cycle at create).
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'rag_onboarding_runs_experiment_id_fkey'
  ) then
    alter table public.rag_onboarding_runs
      add constraint rag_onboarding_runs_experiment_id_fkey
      foreign key (experiment_id) references public.onboarding_experiments(id) on delete set null;
  end if;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Goals + experiments follow the members-RLS pattern (0020). Runs/flows already
-- have policies from 0020 that cover the new columns.
do $$ declare t text;
begin
  foreach t in array array['onboarding_goals','onboarding_experiments'] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

drop policy if exists "Members read onboarding_goals" on public.onboarding_goals;
create policy "Members read onboarding_goals"
  on public.onboarding_goals for select
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = onboarding_goals.workspace_id and wm.user_id = auth.uid()
  ));
drop policy if exists "Members manage onboarding_goals" on public.onboarding_goals;
create policy "Members manage onboarding_goals"
  on public.onboarding_goals for all
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = onboarding_goals.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member')
  ))
  with check (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = onboarding_goals.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member')
  ));

drop policy if exists "Members read onboarding_experiments" on public.onboarding_experiments;
create policy "Members read onboarding_experiments"
  on public.onboarding_experiments for select
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = onboarding_experiments.workspace_id and wm.user_id = auth.uid()
  ));
drop policy if exists "Members manage onboarding_experiments" on public.onboarding_experiments;
create policy "Members manage onboarding_experiments"
  on public.onboarding_experiments for all
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = onboarding_experiments.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member')
  ))
  with check (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = onboarding_experiments.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member')
  ));
