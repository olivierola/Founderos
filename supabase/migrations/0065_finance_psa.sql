-- Finance (AP/AR, treasury, close) + Projects PSA (timesheets, resourcing,
-- billing, profitability) + cross-module links. Extends 0053/0060.

-- ── Finance: AP (vendor bills) + 3-way match to supply POs ────────────────────
create table if not exists public.fin_bills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  number text,
  vendor text not null,
  amount_cents bigint not null default 0,
  currency text not null default 'eur',
  status text not null default 'received'
    check (status in ('received','matched','approved','paid','disputed','void')),
  -- 3-way match: link to the supply PO this bill should reconcile against.
  po_id uuid references public.sc_purchase_orders(id) on delete set null,
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched','matched','exception')),
  issued_date date,
  due_date date,
  paid_date date,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_fin_bills_project on public.fin_bills(project_id, status);

-- AR invoices may originate from a project (PSA billing).
alter table public.fin_invoices
  add column if not exists pm_project_id uuid references public.pm_projects(id) on delete set null,
  add column if not exists kind text not null default 'manual';   -- manual | time | fixed | milestone

-- ── Treasury: bank accounts + transactions ───────────────────────────────────
create table if not exists public.fin_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  iban_last4 text,
  currency text not null default 'eur',
  balance_cents bigint not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.fin_bank_txns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null references public.fin_bank_accounts(id) on delete cascade,
  amount_cents bigint not null default 0,   -- signed
  description text,
  occurred_on date not null default current_date,
  reconciled boolean not null default false,
  -- optional reconciliation links
  invoice_id uuid references public.fin_invoices(id) on delete set null,
  bill_id uuid references public.fin_bills(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_fin_txns_account on public.fin_bank_txns(account_id, occurred_on);

-- ── PSA: team members, allocations, timesheets, project billing rate ──────────
-- Reuse pm_projects as the project entity. Add a default day rate + billing model.
alter table public.pm_projects
  add column if not exists day_rate_cents bigint not null default 0,
  add column if not exists billing_model text not null default 'time'  -- time | fixed | milestone
    check (billing_model in ('time','fixed','milestone')),
  add column if not exists budget_cents bigint not null default 0;

create table if not exists public.psa_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  role text,
  cost_rate_cents bigint not null default 0,    -- internal cost / day
  bill_rate_cents bigint not null default 0,    -- billable / day
  capacity_hours_week numeric not null default 35,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.psa_allocations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_id uuid not null references public.psa_resources(id) on delete cascade,
  pm_project_id uuid references public.pm_projects(id) on delete cascade,
  week_start date not null,                      -- Monday of the allocated week
  hours numeric not null default 0,
  kind text not null default 'firm' check (kind in ('firm','soft')),  -- firm vs pipeline
  created_at timestamptz not null default now()
);
create index if not exists idx_psa_alloc_res on public.psa_allocations(resource_id, week_start);

create table if not exists public.psa_timesheets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_id uuid references public.psa_resources(id) on delete set null,
  pm_project_id uuid references public.pm_projects(id) on delete set null,
  task_id uuid references public.pm_tasks(id) on delete set null,
  work_date date not null default current_date,
  hours numeric not null default 0,
  billable boolean not null default true,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','billed')),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_psa_ts_project on public.psa_timesheets(pm_project_id, work_date);

-- RLS — workspace members.
do $$
declare t text;
begin
  foreach t in array array[
    'fin_bills','fin_bank_accounts','fin_bank_txns',
    'psa_resources','psa_allocations','psa_timesheets'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "m read %1$s" on public.%1$s;', t);
    execute format($f$create policy "m read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "m write %1$s" on public.%1$s;', t);
    execute format($f$create policy "m write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "m update %1$s" on public.%1$s;', t);
    execute format($f$create policy "m update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "m delete %1$s" on public.%1$s;', t);
    execute format($f$create policy "m delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
  end loop;
end $$;
