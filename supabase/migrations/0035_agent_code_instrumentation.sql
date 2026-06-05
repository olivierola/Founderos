-- Agent-driven code instrumentation + advanced analytics configuration.
--
-- This migration backs the feature where the FounderOS agent writes to a
-- connected GitHub repo to instrument analytics events, feature flags and SDKs.
--
--   * Extends event_definitions with advanced analytics configuration.
--   * Adds analytics_instrumentation: a record of where/how each event is
--     instrumented in the codebase, tied to the admin_action (and PR) that did it.
--   * Adds feature_flags.config for richer flagging (rollout %, variants).
--
-- The actual GitHub write is performed by execute-admin-action (action_type
-- 'code.apply_changes') after human approval. These tables hold the durable
-- configuration + audit trail.

-- ── Advanced event configuration ──────────────────────────────────────────
alter table public.event_definitions
  add column if not exists value_type text
    check (value_type in ('none','count','sum','duration','revenue')) default 'count',
  -- Natural-language spec the user gave the agent ("track when a user finishes
  -- onboarding"), kept for traceability and re-instrumentation.
  add column if not exists nl_spec text,
  -- Where the event sits in a user journey, if any (free-form step key).
  add column if not exists journey_step text,
  -- Rich config: { unit, currency, dedupe_window_s, sampling, alias[], ... }.
  add column if not exists config jsonb not null default '{}'::jsonb,
  -- Lifecycle of the event definition vs. its code instrumentation.
  add column if not exists instrumentation_status text
    check (instrumentation_status in ('not_instrumented','proposed','instrumented','removed'))
    default 'not_instrumented';

-- ── User journeys (ordered sequences of events the agent can instrument) ───
create table if not exists public.analytics_journeys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  description text,
  -- Natural-language description of the journey to track, given to the agent.
  nl_spec text,
  -- Ordered steps: [{ event_name, label, optional? }].
  steps jsonb not null default '[]'::jsonb,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analytics_journeys_project_idx
  on public.analytics_journeys(project_id, created_at desc);

-- ── Instrumentation records (audit of agent code changes) ──────────────────
create table if not exists public.analytics_instrumentation (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  -- What kind of instrumentation the agent applied.
  kind text not null
    check (kind in ('event','journey','feature_flag','sdk_install','custom')),

  -- Optional links to the config object being instrumented.
  event_definition_id uuid references public.event_definitions(id) on delete set null,
  journey_id uuid references public.analytics_journeys(id) on delete set null,

  -- The repo + code location(s) touched: [{ path, anchor?, snippet? }].
  repository_id uuid references public.repositories(id) on delete set null,
  full_name text,                       -- owner/repo (denormalized for display)
  targets jsonb not null default '[]'::jsonb,

  -- The admin_action that performed (or will perform) the write, and the
  -- resulting PR/commit once executed.
  admin_action_id uuid references public.admin_actions(id) on delete set null,
  pull_request_url text,
  commit_sha text,

  status text not null
    check (status in ('proposed','approved','applied','failed','reverted'))
    default 'proposed',

  -- The natural-language instruction + the agent's plan, for traceability.
  nl_spec text,
  plan jsonb not null default '{}'::jsonb,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analytics_instrumentation_project_idx
  on public.analytics_instrumentation(project_id, created_at desc);
create index if not exists analytics_instrumentation_action_idx
  on public.analytics_instrumentation(admin_action_id);

-- ── Richer feature flags ───────────────────────────────────────────────────
-- 0006 created feature_flags(flag_key, enabled, target_email). Add structured
-- config so the agent can express rollout %, variants and code anchors.
alter table public.feature_flags
  add column if not exists description text,
  add column if not exists rollout_percent int
    check (rollout_percent between 0 and 100) default 100,
  add column if not exists variants jsonb not null default '[]'::jsonb,
  add column if not exists config jsonb not null default '{}'::jsonb,
  add column if not exists instrumented boolean not null default false;

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.analytics_journeys enable row level security;
alter table public.analytics_instrumentation enable row level security;

do $$
declare t text;
begin
  foreach t in array array['analytics_journeys','analytics_instrumentation']
  loop
    execute format('drop policy if exists "members manage %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members manage %1$s"
      on public.%1$s for all
      using (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
        )
      );
    $f$, t);
  end loop;
end $$;
