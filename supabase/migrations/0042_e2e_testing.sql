-- E2E Testing module (DevOps → Testing): agentic end-to-end tests driven by
-- Playwright in a runner. An AI agent plans a natural-language test into
-- concrete browser actions, the runner executes them against the app URL and
-- streams back DOM snapshots + screenshots, and the agent decides the next
-- action (fill, click, scroll, assert) or pauses to ask the user for input.
--
-- Persistence only here; the orchestration edge functions and the Playwright
-- runner are shipped alongside. Runner auth reuses ops_settings.runner_token_hash.

-- ---- Test suites -----------------------------------------------------------
-- A suite groups test cases against one target application URL.
create table if not exists public.test_suites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  -- The application under test. Can be overridden per run.
  app_url text not null,
  -- Default viewport + auth hints the agent/runner can use.
  config jsonb default '{}'::jsonb,             -- { viewport: {w,h}, base_path, headers }
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---- Test cases ------------------------------------------------------------
-- One natural-language test scenario. The agent turns `instructions` into steps.
create table if not exists public.test_cases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  suite_id uuid not null references public.test_suites(id) on delete cascade,
  name text not null,
  -- Free-form description of what to test, in plain language.
  instructions text not null,
  -- Optional explicit success criteria / assertions in plain language.
  expected_outcome text,
  -- Data the agent may need to fill forms (non-secret). Secrets should live in
  -- ops_secrets and be referenced by key; here we keep simple known values.
  fixtures jsonb default '{}'::jsonb,           -- { email: "...", plan: "pro" }
  -- start_url overrides the suite app_url when set.
  start_url text,
  enabled boolean default true,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---- Test runs -------------------------------------------------------------
-- One execution of a test case.
create table if not exists public.test_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  suite_id uuid not null references public.test_suites(id) on delete cascade,
  case_id uuid not null references public.test_cases(id) on delete cascade,
  app_url text not null,
  status text not null default 'queued' check (status in (
    'queued',        -- waiting for a runner to claim
    'planning',      -- agent is drafting the step plan
    'running',       -- runner executing / agent deciding actions
    'needs_input',   -- paused, waiting for the user to answer an agent question
    'passed',
    'failed',
    'error',
    'cancelled'
  )),
  -- The agent's high-level plan (ordered list of intents) drafted up front.
  plan jsonb default '[]'::jsonb,
  -- The pending action the runner should execute next (set by the orchestrator).
  -- e.g. { type: "fill", selector: "#email", value: "a@b.c" }
  next_action jsonb,
  -- When status = needs_input, the question shown to the user + where to resume.
  pending_question text,
  -- Latest observation captured by the runner (used by the orchestrator).
  last_dom_excerpt text,
  last_screenshot_url text,
  current_url text,
  -- Outcome
  result jsonb default '{}'::jsonb,             -- { assertions: [...], summary }
  error_message text,
  -- Runner bookkeeping (mirrors ops_jobs).
  runner_id text,
  attempts int default 0,
  scheduled_at timestamptz default now(),
  picked_up_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ---- Test run steps (append-only timeline) ---------------------------------
-- Each agent decision or runner observation. Drives the live view.
create table if not exists public.test_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.test_runs(id) on delete cascade,
  idx int not null,                              -- ordering within the run
  -- Who produced this step.
  actor text not null check (actor in ('agent','runner','user','system')),
  -- The kind of step.
  kind text not null check (kind in (
    'plan','navigate','click','fill','select','scroll','press','wait',
    'assert','screenshot','dom_snapshot','ask_user','user_answer','thought',
    'pass','fail','error','info'
  )),
  -- Human-readable label, e.g. "Fill email field".
  label text,
  -- Structured action/observation payload.
  payload jsonb default '{}'::jsonb,
  -- Optional captured screenshot for this step.
  screenshot_url text,
  status text default 'done' check (status in ('pending','running','done','failed','skipped')),
  created_at timestamptz default now()
);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.test_suites enable row level security;
alter table public.test_cases enable row level security;
alter table public.test_runs enable row level security;
alter table public.test_run_steps enable row level security;

do $$
declare t text;
begin
  foreach t in array array['test_suites','test_cases','test_runs']
  loop
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s"
      on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members manage %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')))
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')));
    $f$, t);
  end loop;
end $$;

-- test_run_steps inherits scope from its parent run (no workspace_id column).
drop policy if exists "Members read test_run_steps" on public.test_run_steps;
create policy "Members read test_run_steps"
on public.test_run_steps for select
using (exists (
  select 1
  from public.test_runs r
  join public.workspace_members wm on wm.workspace_id = r.workspace_id
  where r.id = test_run_steps.run_id and wm.user_id = auth.uid()
));

-- ============================================================================
-- Indexes
-- ============================================================================

create index if not exists idx_test_suites_project on public.test_suites(project_id, created_at desc);
create index if not exists idx_test_cases_suite on public.test_cases(suite_id, created_at desc);
create index if not exists idx_test_cases_project on public.test_cases(project_id);
create index if not exists idx_test_runs_project on public.test_runs(project_id, created_at desc);
create index if not exists idx_test_runs_case on public.test_runs(case_id, created_at desc);
create index if not exists idx_test_runs_queue on public.test_runs(status, scheduled_at)
  where status in ('queued','running','needs_input');
create index if not exists idx_test_run_steps_run on public.test_run_steps(run_id, idx);

-- ============================================================================
-- Helper: claim_test_run — atomic pickup for the Playwright runner.
-- Mirrors claim_ops_job: the runner claims the oldest queued run project-wide.
-- ============================================================================

create or replace function public.claim_test_run(p_runner_id text)
returns public.test_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.test_runs;
begin
  select * into v_run
  from public.test_runs
  where status = 'queued'
  order by scheduled_at asc
  limit 1
  for update skip locked;

  if v_run.id is null then
    return null;
  end if;

  update public.test_runs
     set status = 'running',
         runner_id = p_runner_id,
         picked_up_at = now(),
         started_at = coalesce(started_at, now()),
         attempts = attempts + 1
   where id = v_run.id
   returning * into v_run;

  return v_run;
end;
$$;

-- ============================================================================
-- Storage: screenshots streamed by the test runner. Public read so the live
-- view can render frames; writes happen via the service role (the runner),
-- which bypasses RLS.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('test-artifacts', 'test-artifacts', true)
on conflict (id) do nothing;

drop policy if exists "test-artifacts select" on storage.objects;
create policy "test-artifacts select"
  on storage.objects for select
  using (bucket_id = 'test-artifacts');
