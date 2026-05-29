-- FounderOS — Sprint 6: costs tracking + LLM usage + budgets

-- cost_records ---------------------------------------------------------------
create table if not exists public.cost_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null,
  category text default 'infra' check (category in ('infra','hosting','database','ai','email','analytics','monitoring','storage','other')),
  amount_cents int not null,
  currency text default 'eur',
  period_start date,
  period_end date,
  source text default 'manual' check (source in ('manual','synced','llm_usage')),
  note text,
  metadata jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table public.cost_records enable row level security;

create policy "Workspace members read cost_records"
on public.cost_records for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = cost_records.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace admins insert cost_records"
on public.cost_records for insert
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = cost_records.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

create policy "Workspace admins delete cost_records"
on public.cost_records for delete
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = cost_records.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- llm_usage ------------------------------------------------------------------
create table if not exists public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null,
  model text,
  task text,
  prompt_tokens int default 0,
  completion_tokens int default 0,
  total_tokens int default 0,
  estimated_cost_cents int default 0,
  currency text default 'eur',
  feature text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.llm_usage enable row level security;

create policy "Workspace members read llm_usage"
on public.llm_usage for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = llm_usage.workspace_id and wm.user_id = auth.uid()
  )
);

-- budgets --------------------------------------------------------------------
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text,
  monthly_limit_cents int not null,
  currency text default 'eur',
  alert_threshold_pct int default 80,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, provider)
);

alter table public.budgets enable row level security;

create policy "Workspace members read budgets"
on public.budgets for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = budgets.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace admins mutate budgets"
on public.budgets for all
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = budgets.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
)
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = budgets.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- Indexes --------------------------------------------------------------------
create index if not exists idx_cost_records_project on public.cost_records(project_id, period_start desc);
create index if not exists idx_cost_records_provider on public.cost_records(project_id, provider);
create index if not exists idx_llm_usage_project on public.llm_usage(project_id, created_at desc);
create index if not exists idx_llm_usage_provider on public.llm_usage(project_id, provider, model);
