-- Business modules: HR, CRM, Support, Projects.
-- Each table is workspace+project scoped and guarded by workspace membership
-- (the same RLS pattern used across the app). Service-role edges bypass RLS.

-- Helper: a single SELECT/INSERT/UPDATE/DELETE policy set keyed on workspace
-- membership, applied to every business table via a DO block at the end.

-- ============================ HR =========================================

create table if not exists public.hr_employees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  full_name text not null,
  email text,
  job_title text,
  department text,
  manager_id uuid references public.hr_employees(id) on delete set null,
  employment_type text default 'full_time'
    check (employment_type in ('full_time','part_time','contractor','intern')),
  status text default 'active' check (status in ('active','on_leave','terminated','candidate')),
  start_date date,
  end_date date,
  location text,
  salary_cents bigint,
  currency text default 'eur',
  avatar_emoji text default '🧑',
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.hr_leave_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  employee_id uuid references public.hr_employees(id) on delete cascade,
  kind text default 'paid' check (kind in ('paid','unpaid','sick','parental','other')),
  start_date date not null,
  end_date date not null,
  days numeric,
  reason text,
  status text default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.hr_job_openings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  department text,
  location text,
  employment_type text default 'full_time',
  description text,
  status text default 'open' check (status in ('draft','open','paused','closed')),
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists public.hr_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  opening_id uuid references public.hr_job_openings(id) on delete set null,
  full_name text not null,
  email text,
  resume_url text,
  -- Recruitment pipeline stage.
  stage text default 'applied'
    check (stage in ('applied','screening','interview','offer','hired','rejected')),
  rating int check (rating between 1 and 5),
  notes text,
  created_at timestamptz default now()
);

create table if not exists public.hr_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  employee_id uuid references public.hr_employees(id) on delete cascade,
  kind text default 'contract' check (kind in ('contract','payslip','id','certificate','other')),
  name text not null,
  file_url text,
  content text,
  period text,           -- e.g. payslip month "2026-05"
  created_at timestamptz default now()
);

-- ============================ CRM ========================================

create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  company text,
  title text,
  status text default 'lead' check (status in ('lead','prospect','customer','churned')),
  owner_id uuid references auth.users(id),
  tags text[] not null default '{}'::text[],
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.crm_deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  contact_id uuid references public.crm_contacts(id) on delete set null,
  title text not null,
  amount_cents bigint default 0,
  currency text default 'eur',
  stage text default 'new'
    check (stage in ('new','qualified','proposal','negotiation','won','lost')),
  probability int default 10 check (probability between 0 and 100),
  expected_close date,
  owner_id uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  contact_id uuid references public.crm_contacts(id) on delete cascade,
  deal_id uuid references public.crm_deals(id) on delete set null,
  kind text default 'note' check (kind in ('note','call','email','meeting','task')),
  subject text,
  body text,
  due_at timestamptz,
  done boolean default false,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ============================ SUPPORT ====================================

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  subject text not null,
  body text,
  requester_email text,
  priority text default 'normal' check (priority in ('low','normal','high','urgent')),
  status text default 'open' check (status in ('open','pending','on_hold','solved','closed')),
  assignee_id uuid references auth.users(id),
  tags text[] not null default '{}'::text[],
  first_response_at timestamptz,
  solved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  author text default 'agent' check (author in ('agent','customer')),
  body text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists public.support_articles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  body text,
  category text,
  status text default 'draft' check (status in ('draft','published','archived')),
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================ PROJECTS / TASKS ===========================

create table if not exists public.pm_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  description text,
  color text default '#CB2957',
  status text default 'active' check (status in ('planning','active','on_hold','done','archived')),
  start_date date,
  due_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists public.pm_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  board_id uuid references public.pm_projects(id) on delete cascade,
  title text not null,
  description text,
  column_key text default 'todo' check (column_key in ('backlog','todo','in_progress','review','done')),
  priority text default 'normal' check (priority in ('low','normal','high','urgent')),
  assignee_id uuid references auth.users(id),
  due_date date,
  position int default 0,
  labels text[] not null default '{}'::text[],
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================ FINANCE ====================================

create table if not exists public.fin_invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  number text,
  client_name text not null,
  amount_cents bigint not null default 0,
  currency text default 'eur',
  status text default 'draft' check (status in ('draft','sent','paid','overdue','void')),
  issued_date date,
  due_date date,
  paid_date date,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists public.fin_expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  vendor text,
  category text,
  amount_cents bigint not null default 0,
  currency text default 'eur',
  spent_on date,
  status text default 'pending' check (status in ('pending','approved','reimbursed','rejected')),
  receipt_url text,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists public.fin_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  category text not null,
  period text,                    -- e.g. "2026-Q2" or "2026-06"
  amount_cents bigint not null default 0,
  currency text default 'eur',
  created_at timestamptz default now()
);

-- ============================ RLS ========================================

do $$
declare t text;
begin
  foreach t in array array[
    'hr_employees','hr_leave_requests','hr_job_openings','hr_candidates','hr_documents',
    'crm_contacts','crm_deals','crm_activities',
    'support_tickets','support_messages','support_articles',
    'pm_projects','pm_tasks',
    'fin_invoices','fin_expenses','fin_budgets'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members write %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members update %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members delete %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;

-- ============================ Indexes ====================================

create index if not exists idx_hr_employees_project on public.hr_employees(project_id, status);
create index if not exists idx_hr_leave_project on public.hr_leave_requests(project_id, status);
create index if not exists idx_hr_candidates_project on public.hr_candidates(project_id, stage);
create index if not exists idx_hr_documents_employee on public.hr_documents(employee_id);
create index if not exists idx_crm_contacts_project on public.crm_contacts(project_id, status);
create index if not exists idx_crm_deals_project on public.crm_deals(project_id, stage);
create index if not exists idx_crm_activities_contact on public.crm_activities(contact_id, created_at desc);
create index if not exists idx_support_tickets_project on public.support_tickets(project_id, status);
create index if not exists idx_support_messages_ticket on public.support_messages(ticket_id, created_at);
create index if not exists idx_pm_tasks_board on public.pm_tasks(board_id, column_key, position);
create index if not exists idx_fin_invoices_project on public.fin_invoices(project_id, status);
create index if not exists idx_fin_expenses_project on public.fin_expenses(project_id, status);
create index if not exists idx_fin_budgets_project on public.fin_budgets(project_id);
