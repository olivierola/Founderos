-- HR/ATS depth + onboarding + EU AI Act governance, plus CRM scoring & support
-- resolution metrics. Extends 0053/0055.

-- ── ATS: candidate sourcing (which channel a candidate came from) ────────────
alter table public.hr_candidates
  add column if not exists source text,                 -- linkedin | indeed | wttj | greenhouse | lever | workable | referral | manual
  add column if not exists source_ref text,             -- external id from the source
  add column if not exists phone text,
  add column if not exists location text,
  add column if not exists ai_score int,                -- 0..100 (AI screening)
  add column if not exists ai_summary text,
  add column if not exists ai_decision text check (ai_decision in ('advance','review','reject') or ai_decision is null),
  add column if not exists human_override boolean not null default false,
  add column if not exists applied_at timestamptz not null default now();

-- ── Onboarding: per-new-hire coordinated workflow ────────────────────────────
create table if not exists public.hr_onboardings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  employee_id uuid references public.hr_employees(id) on delete set null,
  candidate_id uuid references public.hr_candidates(id) on delete set null,
  name text not null,
  role text,
  start_date date,
  status text not null default 'preboarding'
    check (status in ('preboarding','active','complete','stalled')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.hr_onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  onboarding_id uuid not null references public.hr_onboardings(id) on delete cascade,
  title text not null,
  owner_kind text not null default 'hr' check (owner_kind in ('hr','it','manager','employee')),
  due_offset_days int not null default 0,               -- relative to start_date (− = preboarding)
  status text not null default 'pending' check (status in ('pending','done','blocked')),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_hr_onb_tasks on public.hr_onboarding_tasks(onboarding_id, position);

-- ── EU AI Act governance: audit every automated/assisted HR decision ─────────
create table if not exists public.hr_ai_audit (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  subject_kind text not null default 'candidate',       -- candidate | employee
  subject_id uuid,
  action text not null,                                 -- screen | rank | recommend | override
  model text,
  decision text,
  rationale text,
  human_in_loop boolean not null default true,
  decided_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_hr_ai_audit on public.hr_ai_audit(project_id, created_at);

-- ── CRM: lead scoring + deal risk + activity capture ─────────────────────────
alter table public.crm_contacts
  add column if not exists lead_score int,              -- 0..100
  add column if not exists score_reason text;
alter table public.crm_deals
  add column if not exists risk text check (risk in ('low','medium','high') or risk is null),
  add column if not exists risk_reason text,
  add column if not exists last_activity_at timestamptz;

-- ── Support: resolution tracking (autonomous resolution rate) ────────────────
alter table public.support_tickets
  add column if not exists resolution text check (resolution in ('ai_resolved','human_resolved','escalated') or resolution is null),
  add column if not exists ai_confidence int,           -- 0..100
  add column if not exists csat int check (csat between 1 and 5 or csat is null),
  add column if not exists resolved_at timestamptz;

-- RLS — workspace members (new tables only; altered tables keep their policies).
do $$
declare t text;
begin
  foreach t in array array['hr_onboardings','hr_onboarding_tasks','hr_ai_audit'] loop
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
