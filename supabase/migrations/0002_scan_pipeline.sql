-- FounderOS — Sprint 2: scan pipeline, connectors, credentials vault, activity logs

-- connectors ------------------------------------------------------------------
create table if not exists public.connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null,
  status text default 'not_connected'
    check (status in ('detected','not_connected','connected','invalid_credentials','read_only','write_enabled','needs_attention')),
  permissions text default 'read_only' check (permissions in ('read_only','write_enabled')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (workspace_id, project_id, provider)
);

alter table public.connectors enable row level security;

create policy "Workspace members read connectors"
on public.connectors for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = connectors.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace admins mutate connectors"
on public.connectors for all
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = connectors.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
)
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = connectors.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- encrypted_credentials -------------------------------------------------------
create table if not exists public.encrypted_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  connector_id uuid references public.connectors(id) on delete cascade,
  encrypted_payload text not null,
  iv text not null,
  key_version text default 'v1',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.encrypted_credentials enable row level security;

-- Intentionally: NO select policy from clients. Edge functions use service role.
-- Only allow admins to delete a credential record (rotation/disconnection).
create policy "Workspace admins delete credentials"
on public.encrypted_credentials for delete
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = encrypted_credentials.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- scan_jobs -------------------------------------------------------------------
create table if not exists public.scan_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  repository_id uuid references public.repositories(id) on delete cascade,
  status text default 'pending' check (status in ('pending','running','succeeded','failed')),
  progress jsonb default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz default now()
);

alter table public.scan_jobs enable row level security;

create policy "Workspace members read scan_jobs"
on public.scan_jobs for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = scan_jobs.workspace_id and wm.user_id = auth.uid()
  )
);

-- scan_results ----------------------------------------------------------------
create table if not exists public.scan_results (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid references public.scan_jobs(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  repository_id uuid references public.repositories(id) on delete cascade,
  summary jsonb default '{}'::jsonb,
  dependencies jsonb default '[]'::jsonb,
  env_vars jsonb default '[]'::jsonb,
  services jsonb default '[]'::jsonb,
  architecture jsonb default '{}'::jsonb,
  security_findings jsonb default '[]'::jsonb,
  ai_analysis jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.scan_results enable row level security;

create policy "Workspace members read scan_results"
on public.scan_results for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = scan_results.workspace_id and wm.user_id = auth.uid()
  )
);

-- activity_logs ---------------------------------------------------------------
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  event_type text not null,
  title text,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.activity_logs enable row level security;

create policy "Workspace members read activity_logs"
on public.activity_logs for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = activity_logs.workspace_id and wm.user_id = auth.uid()
  )
);

-- Workspace admins can insert repositories (used by github-list-repos flow)
create policy "Workspace admins insert repositories"
on public.repositories for insert
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = repositories.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

create policy "Workspace admins delete repositories"
on public.repositories for delete
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = repositories.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- Helpful indexes -------------------------------------------------------------
create index if not exists idx_scan_jobs_repository on public.scan_jobs(repository_id, created_at desc);
create index if not exists idx_scan_results_repository on public.scan_results(repository_id, created_at desc);
create index if not exists idx_repositories_project on public.repositories(project_id);
create index if not exists idx_activity_logs_project on public.activity_logs(project_id, created_at desc);
