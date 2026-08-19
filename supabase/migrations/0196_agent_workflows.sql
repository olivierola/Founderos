-- 0196_agent_workflows.sql
-- Workflows: an editor for a PROCEDURE, whose output is a markdown playbook.
--
-- The shape that matters: a workflow is not a graph the backend walks node by
-- node. Blocks are assembled on a canvas, compiled into a `workflow.md`, and
-- when the trigger fires the service's ASSISTANT reads that playbook and
-- executes it — deciding for itself who does what, exactly as it does for a
-- request typed in a room. So the runtime here is three things: compile,
-- trigger, hand to an agent. Everything else (tool loop, checklist, success
-- contract, deliverables, cost) is the agent runtime that already exists.
--
-- This also means a workflow run is observable for free: it points at a normal
-- internal_agent_run, with its timeline, its deliverables and its budget.
--
-- The v1 `workflows` table (0006) modelled an automation as a flat `steps`
-- array with one trigger — enough for "on X, POST to Y", useless the moment a
-- procedure branches, waits for a human, or needs judgement. It stays for
-- automation-receiver; nothing new should be written to it.

create table if not exists public.agent_workflows (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  project_id           uuid not null references public.projects(id) on delete cascade,
  -- Workflows belong to a service the way agents and rooms do.
  service_dashboard_id uuid references public.service_dashboards(id) on delete cascade,
  name                 text not null,
  description          text,
  status               text not null default 'draft'
                       check (status in ('draft','active','paused','archived')),

  -- ── The two faces of the same procedure ───────────────────────────────────
  -- `blocks` is the canvas (React Flow's own shape, so the editor neither
  -- serialises nor rehydrates). `document` is the compiled markdown, which is
  -- ALSO editable: each block is anchored in it with an HTML comment
  -- (`<!-- b:step-a3f9 -->`), which is what lets an edit on either side map
  -- back to the other without rebuilding the graph and losing its layout.
  blocks               jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  document             text  not null default '',

  -- Denormalised out of the trigger block so the scheduler can find due
  -- workflows with an index instead of parsing every graph in the project.
  schedule             text,
  next_run_at          timestamptz,
  last_run_at          timestamptz,

  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_agent_workflows_dashboard on public.agent_workflows(service_dashboard_id, updated_at desc);
create index if not exists idx_agent_workflows_project on public.agent_workflows(project_id, updated_at desc);
create index if not exists idx_agent_workflows_due on public.agent_workflows(next_run_at)
  where status = 'active' and next_run_at is not null;

-- ── Runs ─────────────────────────────────────────────────────────────────────
-- A workflow run is a POINTER to the agent run that executed the playbook.
-- Keeping per-step state here would duplicate what the agent's own timeline
-- already records, and the two copies would disagree within the first minute.
create table if not exists public.agent_workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null references public.agent_workflows(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  -- The assistant's run. Null only if the launch itself failed.
  agent_run_id    uuid references public.internal_agent_runs(id) on delete set null,
  agent_id        uuid references public.internal_agents(id) on delete set null,
  status          text not null default 'running'
                  check (status in ('running','succeeded','failed','cancelled')),
  trigger         text not null default 'manual',
  trigger_payload jsonb not null default '{}'::jsonb,
  -- The exact playbook this run received. A workflow edited afterwards must not
  -- rewrite the history of what was actually executed.
  document        text,
  error_message   text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  triggered_by    uuid references auth.users(id) on delete set null
);
create index if not exists idx_agent_workflow_runs on public.agent_workflow_runs(workflow_id, started_at desc);
create index if not exists idx_agent_workflow_runs_agent on public.agent_workflow_runs(agent_run_id);

-- ── RLS — workspace membership, like every other workforce object ────────────
alter table public.agent_workflows      enable row level security;
alter table public.agent_workflow_runs  enable row level security;

drop policy if exists "members manage agent workflows" on public.agent_workflows;
create policy "members manage agent workflows" on public.agent_workflows for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_workflows.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_workflows.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "members read agent workflow runs" on public.agent_workflow_runs;
create policy "members read agent workflow runs" on public.agent_workflow_runs for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_workflow_runs.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_workflow_runs.workspace_id and wm.user_id = auth.uid()));
