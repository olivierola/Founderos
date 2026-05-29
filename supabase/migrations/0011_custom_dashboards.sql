-- Custom dashboards (Power-BI-style builder) + their widgets.

create table if not exists public.custom_dashboards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  description text,
  layout jsonb default '[]'::jsonb,         -- react-grid-layout positions
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.custom_dashboards enable row level security;

create policy "Members read dashboards"
on public.custom_dashboards for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = custom_dashboards.workspace_id and wm.user_id = auth.uid())
);
create policy "Members manage dashboards"
on public.custom_dashboards for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = custom_dashboards.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = custom_dashboards.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member'))
);

create table if not exists public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid references public.custom_dashboards(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  type text not null check (type in ('kpi','line','bar','area','pie','table','markdown')),
  title text,
  config jsonb not null default '{}'::jsonb, -- source, aggregation, formula, etc.
  position jsonb default '{}'::jsonb,         -- {x,y,w,h}
  created_at timestamptz default now()
);

alter table public.dashboard_widgets enable row level security;

create policy "Members read widgets"
on public.dashboard_widgets for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = dashboard_widgets.workspace_id and wm.user_id = auth.uid())
);
create policy "Members manage widgets"
on public.dashboard_widgets for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = dashboard_widgets.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = dashboard_widgets.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin','member'))
);

create index if not exists idx_dashboards_project on public.custom_dashboards(project_id, created_at desc);
create index if not exists idx_widgets_dashboard on public.dashboard_widgets(dashboard_id);
