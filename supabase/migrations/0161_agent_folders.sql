-- 0161_agent_folders.sql
-- Folders to file agents in, inside a service dashboard. A roster of a dozen
-- agents in one flat grid stops being readable; folders group them by the work
-- they do ("Sécurité", "Contenu", "Support"…) without touching their config.
--
-- Scoped to a dashboard like the agents themselves. Deleting a folder does NOT
-- delete its agents — they fall back to "unfiled" (on delete set null).

create table if not exists public.agent_folders (
  id           uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.service_dashboards(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  name         text not null,
  color        text not null default 'bg-slate-500',
  position     int  not null default 0,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists idx_agent_folders_dashboard
  on public.agent_folders(dashboard_id, position, created_at);

alter table public.internal_agents
  add column if not exists folder_id uuid references public.agent_folders(id) on delete set null;
create index if not exists idx_internal_agents_folder
  on public.internal_agents(folder_id) where folder_id is not null;

alter table public.agent_folders enable row level security;

drop policy if exists "members manage agent_folders" on public.agent_folders;
create policy "members manage agent_folders" on public.agent_folders for all
  using  (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
