-- 0133_service_dashboards.sql
-- Service dashboards — user-created, per-service workspaces that appear in the
-- dashboard switcher and render as a clean single-sidebar space (Rooms / Agents
-- / Schedules / Activity / Artifacts / Assets). Keeps each service's work
-- separate ("ne pas tout mélanger"). Agents created inside a dashboard are
-- scoped to it; the Assets tab is a catch-all resource hub for the service.

create table if not exists public.service_dashboards (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  name         text not null,
  icon         text not null default 'Squares',   -- phosphor icon name
  color        text not null default 'bg-indigo-500',
  position     int  not null default 0,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_service_dashboards_project on public.service_dashboards(project_id, position);

-- The "drop everything here" hub for a service dashboard: people with access,
-- agents, GitHub repos, links, files, access keys, connected tools, notes.
create table if not exists public.service_dashboard_assets (
  id            uuid primary key default gen_random_uuid(),
  dashboard_id  uuid not null references public.service_dashboards(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid not null references public.projects(id) on delete cascade,
  kind          text not null check (kind in ('human','agent','repo','link','file','key','connector','note')),
  label         text not null,
  value         text,                              -- url / email / repo full_name / note body…
  metadata      jsonb not null default '{}'::jsonb,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_service_dashboard_assets_board on public.service_dashboard_assets(dashboard_id, kind, created_at desc);

-- Agents (and thus their rooms/missions/runs/deliverables) scope to a dashboard.
alter table public.internal_agents
  add column if not exists service_dashboard_id uuid references public.service_dashboards(id) on delete set null;
create index if not exists idx_internal_agents_service_dashboard on public.internal_agents(service_dashboard_id);

-- ── RLS: workspace members read/write within their workspace ──
alter table public.service_dashboards enable row level security;
alter table public.service_dashboard_assets enable row level security;

create policy "members manage service_dashboards" on public.service_dashboards for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_dashboards.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_dashboards.workspace_id and wm.user_id = auth.uid()));

create policy "members manage service_dashboard_assets" on public.service_dashboard_assets for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_dashboard_assets.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_dashboard_assets.workspace_id and wm.user_id = auth.uid()));
