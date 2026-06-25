-- 0088 · Module projects: project-based navigation for all modules.
-- Each module (except CRM/Assets/Settings) now shows a project list as its
-- landing page. Users create typed projects (audit, data pipeline, etc.)
-- and work inside them via tabs.

create table if not exists public.module_projects (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  module_slug text not null,
  project_type text not null,
  name        text not null,
  description text,
  status      text not null default 'active'
    check (status in ('planning','active','on_hold','completed','archived')),
  color       text default '#6366f1',
  icon        text default 'FolderKanban',
  start_date  date,
  due_date    date,
  metadata    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_module_projects_lookup
  on public.module_projects(project_id, module_slug, status);

alter table public.module_projects enable row level security;

create policy "members manage module_projects"
  on public.module_projects for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = module_projects.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = module_projects.workspace_id and wm.user_id = auth.uid()));

alter publication supabase_realtime add table public.module_projects;

-- Register in CRM catalog so module projects appear as CRM objects.
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('module-projects', 'module_projects', 'name', 'Project', 'Projects', 'FolderKanban', 'text-violet-500')
on conflict (slug) do nothing;
