-- 0125_vibe_projects.sql
-- Vibe Code "projects": a named workspace bound to exactly ONE repository.
-- Every chat session created inside a project inherits that repo as its context
-- (no per-session repo picking). Sessions without a project keep working as-is.
create table if not exists public.vibe_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  -- The single repo this project works on — the context of all its sessions.
  repository_id uuid not null references public.repositories(id) on delete cascade,
  -- Optional default branch override for the project (else the repo's default).
  branch text,
  description text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_vibe_projects_project on public.vibe_projects(project_id, updated_at desc);

-- Sessions belong to a vibe project (nullable = legacy/ad-hoc session).
alter table public.vibe_sessions
  add column if not exists vibe_project_id uuid references public.vibe_projects(id) on delete cascade;
create index if not exists idx_vibe_sessions_vibe_project on public.vibe_sessions(vibe_project_id, updated_at desc);

alter table public.vibe_projects enable row level security;
drop policy if exists "Members read vibe_projects" on public.vibe_projects;
create policy "Members read vibe_projects" on public.vibe_projects for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_projects.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write vibe_projects" on public.vibe_projects;
create policy "Members write vibe_projects" on public.vibe_projects for all
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_projects.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_projects.workspace_id and wm.user_id = auth.uid()));
