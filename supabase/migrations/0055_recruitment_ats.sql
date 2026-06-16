-- Recruitment v2 — a tailored ATS per job opening.
-- Builds on 0053's hr_job_openings + hr_candidates.

-- ---- Job openings: richer fields ------------------------------------------

alter table public.hr_job_openings
  add column if not exists salary_range text,
  add column if not exists hiring_manager_id uuid references public.hr_employees(id) on delete set null,
  add column if not exists requirements text,
  add column if not exists opened_at date default now(),
  add column if not exists target_close date;

-- ---- Per-opening pipeline stages (the configurable ATS) -------------------
-- Each opening has its own ordered list of stages. Candidates move through them.

create table if not exists public.hr_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  opening_id uuid references public.hr_job_openings(id) on delete cascade,
  name text not null,
  position int not null default 0,
  -- Semantic kind drives styling + funnel analytics. Free-form names allowed.
  kind text default 'middle' check (kind in ('applied','middle','interview','offer','hired','rejected')),
  created_at timestamptz default now()
);

-- ---- Candidates: ATS fields -----------------------------------------------

alter table public.hr_candidates
  -- Current stage in the opening's custom pipeline (overrides the legacy enum).
  add column if not exists stage_id uuid references public.hr_pipeline_stages(id) on delete set null,
  add column if not exists phone text,
  add column if not exists source text,                 -- where they came from
  add column if not exists location text,
  add column if not exists resume_text text,            -- pasted/extracted CV text for AI
  -- AI screening output.
  add column if not exists ai_score int check (ai_score between 0 and 100),
  add column if not exists ai_summary text,
  add column if not exists ai_strengths text,
  add column if not exists ai_gaps text,
  add column if not exists ai_screened_at timestamptz;

-- ---- Scorecard: criteria per opening + evaluations per candidate ----------

create table if not exists public.hr_scorecard_criteria (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  opening_id uuid references public.hr_job_openings(id) on delete cascade,
  label text not null,
  weight int not null default 1 check (weight between 1 and 5),
  position int not null default 0,
  created_at timestamptz default now()
);

create table if not exists public.hr_evaluations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  candidate_id uuid references public.hr_candidates(id) on delete cascade,
  criterion_id uuid references public.hr_scorecard_criteria(id) on delete cascade,
  score int check (score between 1 and 5),
  comment text,
  evaluator_id uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (candidate_id, criterion_id, evaluator_id)
);

-- ---- Interviews -----------------------------------------------------------

create table if not exists public.hr_interviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  candidate_id uuid references public.hr_candidates(id) on delete cascade,
  opening_id uuid references public.hr_job_openings(id) on delete set null,
  title text not null,
  kind text default 'phone' check (kind in ('phone','technical','culture','hr','panel','other')),
  scheduled_at timestamptz,
  duration_min int default 45,
  interviewers text[] not null default '{}'::text[],
  status text default 'scheduled' check (status in ('scheduled','done','cancelled','no_show')),
  feedback text,
  rating int check (rating between 1 and 5),
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ---- RLS (workspace membership) -------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'hr_pipeline_stages','hr_scorecard_criteria','hr_evaluations','hr_interviews'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$create policy "Members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "Members write %1$s" on public.%1$s;', t);
    execute format($f$create policy "Members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "Members update %1$s" on public.%1$s;', t);
    execute format($f$create policy "Members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "Members delete %1$s" on public.%1$s;', t);
    execute format($f$create policy "Members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
  end loop;
end $$;

create index if not exists idx_hr_stages_opening on public.hr_pipeline_stages(opening_id, position);
create index if not exists idx_hr_criteria_opening on public.hr_scorecard_criteria(opening_id, position);
create index if not exists idx_hr_evals_candidate on public.hr_evaluations(candidate_id);
create index if not exists idx_hr_interviews_candidate on public.hr_interviews(candidate_id, scheduled_at);
create index if not exists idx_hr_candidates_stage on public.hr_candidates(stage_id);

-- ---- Seed default stages for existing openings that have none --------------
insert into public.hr_pipeline_stages (workspace_id, project_id, opening_id, name, position, kind)
select o.workspace_id, o.project_id, o.id, s.name, s.pos, s.kind
from public.hr_job_openings o
cross join (values
  ('Applied', 0, 'applied'),
  ('Screening', 1, 'middle'),
  ('Interview', 2, 'interview'),
  ('Offer', 3, 'offer'),
  ('Hired', 4, 'hired'),
  ('Rejected', 5, 'rejected')
) as s(name, pos, kind)
where not exists (select 1 from public.hr_pipeline_stages ps where ps.opening_id = o.id);
