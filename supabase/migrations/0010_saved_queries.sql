-- Saved visual queries for the Database Console query builder.
create table if not exists public.saved_queries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  spec jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table public.saved_queries enable row level security;

create policy "Workspace members read saved_queries"
on public.saved_queries for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = saved_queries.workspace_id and wm.user_id = auth.uid())
);

create policy "Workspace members manage saved_queries"
on public.saved_queries for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = saved_queries.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = saved_queries.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member'))
);

create index if not exists idx_saved_queries_project on public.saved_queries(project_id, created_at desc);
