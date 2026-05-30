-- RAG Onboarding: flows, steps, tours, checklists and run analytics for the
-- RAG agent. Each project can define multiple onboarding flows. A "run" is
-- one end user going through one flow, tracked by visitor_id (widget) or
-- external_user_id (server-side API).

create table if not exists public.rag_onboarding_flows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  name text not null,
  description text,
  kind text not null default 'flow' check (kind in ('flow','tour','checklist')),
  trigger jsonb default '{}'::jsonb,         -- e.g. { event: "user.signup" } or { route: "/dashboard" }
  enabled boolean default true,
  position int default 0,                     -- ordering when multiple flows match
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.rag_onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid references public.rag_onboarding_flows(id) on delete cascade,
  position int default 0,
  title text not null,
  body text,                                  -- markdown shown by the widget
  cta_label text,                             -- e.g. "Open billing"
  cta_url text,                               -- where the CTA points
  /* For "tour" kind: which page + selector the step lives on. */
  page_route text,
  element_selector text,
  /* Optional rule that marks the step "complete" without an explicit user action. */
  complete_on jsonb default '{}'::jsonb,      -- e.g. { event: "project.created" } or { route: "/projects/:id" }
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.rag_onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  flow_id uuid references public.rag_onboarding_flows(id) on delete cascade,
  visitor_id text,                            -- widget visitor
  external_user_id text,                      -- server-side onboarding (SaaS API)
  status text not null default 'in_progress' check (status in ('in_progress','completed','abandoned')),
  current_step_position int default 0,
  context jsonb default '{}'::jsonb,          -- any data passed by the host SaaS
  started_at timestamptz default now(),
  last_activity_at timestamptz default now(),
  completed_at timestamptz
);

create table if not exists public.rag_onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.rag_onboarding_runs(id) on delete cascade,
  step_id uuid references public.rag_onboarding_steps(id) on delete cascade,
  status text not null default 'completed' check (status in ('completed','skipped','failed')),
  created_at timestamptz default now()
);

create index if not exists idx_rag_onb_flows_agent on public.rag_onboarding_flows(agent_id);
create index if not exists idx_rag_onb_steps_flow on public.rag_onboarding_steps(flow_id, position);
create index if not exists idx_rag_onb_runs_agent on public.rag_onboarding_runs(agent_id, started_at desc);
create index if not exists idx_rag_onb_runs_flow on public.rag_onboarding_runs(flow_id, status);
create index if not exists idx_rag_onb_progress_run on public.rag_onboarding_progress(run_id);

-- RLS: members of the workspace can read/manage flows + steps; runs and progress
-- are written by the service role (the public endpoint runs with service role).
do $$ declare t text;
begin
  foreach t in array array[
    'rag_onboarding_flows','rag_onboarding_steps',
    'rag_onboarding_runs','rag_onboarding_progress'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

create policy "Members read rag_onboarding_flows"
  on public.rag_onboarding_flows for select
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = rag_onboarding_flows.workspace_id and wm.user_id = auth.uid()
  ));

create policy "Members manage rag_onboarding_flows"
  on public.rag_onboarding_flows for all
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = rag_onboarding_flows.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin','member')
  ))
  with check (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = rag_onboarding_flows.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin','member')
  ));

create policy "Members read rag_onboarding_steps"
  on public.rag_onboarding_steps for select
  using (exists (
    select 1
    from public.rag_onboarding_flows f
    join public.workspace_members wm on wm.workspace_id = f.workspace_id
    where f.id = rag_onboarding_steps.flow_id
      and wm.user_id = auth.uid()
  ));

create policy "Members manage rag_onboarding_steps"
  on public.rag_onboarding_steps for all
  using (exists (
    select 1
    from public.rag_onboarding_flows f
    join public.workspace_members wm on wm.workspace_id = f.workspace_id
    where f.id = rag_onboarding_steps.flow_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin','member')
  ))
  with check (exists (
    select 1
    from public.rag_onboarding_flows f
    join public.workspace_members wm on wm.workspace_id = f.workspace_id
    where f.id = rag_onboarding_steps.flow_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin','member')
  ));

create policy "Members read rag_onboarding_runs"
  on public.rag_onboarding_runs for select
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = rag_onboarding_runs.workspace_id and wm.user_id = auth.uid()
  ));

create policy "Service role writes runs"
  on public.rag_onboarding_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Members read rag_onboarding_progress"
  on public.rag_onboarding_progress for select
  using (exists (
    select 1
    from public.rag_onboarding_runs r
    join public.workspace_members wm on wm.workspace_id = r.workspace_id
    where r.id = rag_onboarding_progress.run_id
      and wm.user_id = auth.uid()
  ));

create policy "Service role writes progress"
  on public.rag_onboarding_progress for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
