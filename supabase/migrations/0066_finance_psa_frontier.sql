-- Frontier layer: general ledger (multi-entity/currency), audit trail,
-- PSA Gantt (dependencies/milestones) + soft/firm allocations already exist
-- (psa_allocations.kind). Adds the accounting backbone + governance.

-- ── Entities (multi-entity / multi-currency) ─────────────────────────────────
create table if not exists public.fin_entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  country text,
  base_currency text not null default 'eur',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ── Chart of accounts ────────────────────────────────────────────────────────
create table if not exists public.fin_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_id uuid references public.fin_entities(id) on delete cascade,
  code text not null,                              -- e.g. 401, 512, 70
  name text not null,
  type text not null default 'expense'
    check (type in ('asset','liability','equity','revenue','expense')),
  created_at timestamptz not null default now()
);
create index if not exists idx_fin_accounts_project on public.fin_accounts(project_id);

-- ── Journal entries + lines (double-entry) ───────────────────────────────────
create table if not exists public.fin_journal_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_id uuid references public.fin_entities(id) on delete set null,
  reference text,
  memo text,
  entry_date date not null default current_date,
  currency text not null default 'eur',
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  -- Provenance for the shared-context ontology (which doc generated this entry).
  source_kind text,                               -- invoice | bill | expense | manual | adjustment
  source_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_fin_je_project on public.fin_journal_entries(project_id, entry_date);

create table if not exists public.fin_journal_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entry_id uuid not null references public.fin_journal_entries(id) on delete cascade,
  account_id uuid references public.fin_accounts(id) on delete set null,
  debit_cents bigint not null default 0,
  credit_cents bigint not null default 0,
  description text
);
create index if not exists idx_fin_jl_entry on public.fin_journal_lines(entry_id);

-- ── Accounting periods (monthly close) ───────────────────────────────────────
create table if not exists public.fin_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_id uuid references public.fin_entities(id) on delete set null,
  label text not null,                            -- e.g. 2026-06
  status text not null default 'open' check (status in ('open','closing','closed')),
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ── Immutable-ish audit trail (governance / HITL preservation) ───────────────
create table if not exists public.fin_audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor uuid references auth.users(id),
  actor_kind text not null default 'user' check (actor_kind in ('user','agent','system')),
  action text not null,                           -- e.g. bill.approved, period.closed
  entity_kind text,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_fin_audit_project on public.fin_audit_log(project_id, created_at);

-- ── PSA Gantt: task dependencies + milestones + planning fields ──────────────
alter table public.pm_tasks
  add column if not exists start_date date,
  add column if not exists progress int not null default 0,        -- 0..100
  add column if not exists is_milestone boolean not null default false,
  add column if not exists estimate_hours numeric;

create table if not exists public.pm_task_deps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  board_id uuid references public.pm_projects(id) on delete cascade,
  predecessor_id uuid not null references public.pm_tasks(id) on delete cascade,
  successor_id uuid not null references public.pm_tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (predecessor_id, successor_id)
);

-- RLS — workspace members.
do $$
declare t text;
begin
  foreach t in array array[
    'fin_entities','fin_accounts','fin_journal_entries','fin_journal_lines',
    'fin_periods','fin_audit_log','pm_task_deps'
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
