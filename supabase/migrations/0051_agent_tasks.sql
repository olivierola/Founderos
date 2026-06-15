-- Tasks that agents (or humans) file as durable, trackable to-dos.
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Optional origin agent.
  agent_id uuid references public.internal_agents(id) on delete set null,
  title text not null,
  detail text,
  status text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  due_at timestamptz,
  assignee text,                                -- free-text owner (name/email)
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.agent_tasks enable row level security;

drop policy if exists "Members read agent_tasks" on public.agent_tasks;
create policy "Members read agent_tasks" on public.agent_tasks for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = agent_tasks.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members manage agent_tasks" on public.agent_tasks;
create policy "Members manage agent_tasks" on public.agent_tasks for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = agent_tasks.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = agent_tasks.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

create index if not exists idx_agent_tasks_project on public.agent_tasks(project_id, status, created_at desc);
