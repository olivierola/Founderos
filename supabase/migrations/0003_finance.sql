-- FounderOS — Sprint 5: Stripe sync + finance metrics

-- customers -------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text default 'stripe',
  external_id text not null,
  email text,
  name text,
  created_at_provider timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, provider, external_id)
);

alter table public.customers enable row level security;

create policy "Workspace members read customers"
on public.customers for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = customers.workspace_id and wm.user_id = auth.uid()
  )
);

-- subscriptions ---------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text default 'stripe',
  external_id text not null,
  customer_external_id text,
  status text,
  plan_name text,
  amount_cents int default 0,
  currency text default 'eur',
  interval text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  started_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, provider, external_id)
);

alter table public.subscriptions enable row level security;

create policy "Workspace members read subscriptions"
on public.subscriptions for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = subscriptions.workspace_id and wm.user_id = auth.uid()
  )
);

-- invoices --------------------------------------------------------------------
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text default 'stripe',
  external_id text not null,
  customer_external_id text,
  status text,
  amount_paid_cents int default 0,
  amount_due_cents int default 0,
  currency text default 'eur',
  paid_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, provider, external_id)
);

alter table public.invoices enable row level security;

create policy "Workspace members read invoices"
on public.invoices for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = invoices.workspace_id and wm.user_id = auth.uid()
  )
);

-- revenue_records (atomic revenue events: charge, refund, subscription cycle) -
create table if not exists public.revenue_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text default 'stripe',
  external_id text,
  amount_cents int not null,
  currency text default 'eur',
  type text,
  customer_external_id text,
  occurred_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.revenue_records enable row level security;

create policy "Workspace members read revenue_records"
on public.revenue_records for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = revenue_records.workspace_id and wm.user_id = auth.uid()
  )
);

-- metrics_snapshots (daily aggregates) ----------------------------------------
create table if not exists public.metrics_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  snapshot_date date not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, snapshot_date)
);

alter table public.metrics_snapshots enable row level security;

create policy "Workspace members read metrics_snapshots"
on public.metrics_snapshots for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = metrics_snapshots.workspace_id and wm.user_id = auth.uid()
  )
);

-- Indexes ---------------------------------------------------------------------
create index if not exists idx_customers_project on public.customers(project_id, created_at desc);
create index if not exists idx_subscriptions_project on public.subscriptions(project_id, status);
create index if not exists idx_invoices_project on public.invoices(project_id, paid_at desc);
create index if not exists idx_revenue_records_project on public.revenue_records(project_id, occurred_at desc);
create index if not exists idx_metrics_snapshots_project on public.metrics_snapshots(project_id, snapshot_date desc);
