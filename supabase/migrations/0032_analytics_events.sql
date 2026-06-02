-- Event analytics layer on top of product_events.
--
-- product_events (0006) is the raw event stream. This migration adds the
-- *configuration* objects that turn that stream into a real analytics product:
--   * event_definitions  — the catalog of known/custom events (taxonomy)
--   * analytics_funnels   — saved multi-step funnels
--   * analytics_cohorts   — saved retention cohort definitions
--
-- Heavy aggregation (funnel conversion, retention grids, trends) is computed by
-- the `analytics-query` edge function directly in Postgres, not stored here.

-- ── Event taxonomy / custom events ────────────────────────────────────────
create table if not exists public.event_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  -- The raw event_name as it arrives in product_events (the join key).
  event_name text not null,
  display_name text,
  description text,
  category text not null default 'product'
    check (category in ('product','lifecycle','revenue','marketing','system','custom')),

  -- Whether this event counts as a "key/activation" action — used as a default
  -- in funnels and activation metrics.
  is_key_action boolean not null default false,

  -- Declared property schema: [{ key, type, required? }]. Purely descriptive,
  -- used by the UI to hint/validate when emitting test events.
  property_schema jsonb not null default '[]'::jsonb,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, event_name)
);

create index if not exists event_definitions_project_idx
  on public.event_definitions(project_id, category);

-- ── Saved funnels ─────────────────────────────────────────────────────────
create table if not exists public.analytics_funnels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  description text,

  -- Ordered steps: [{ event_name, label? }]. A user must complete steps in
  -- order, within `window_days`, to count as converted.
  steps jsonb not null default '[]'::jsonb,
  window_days int not null default 30,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analytics_funnels_project_idx
  on public.analytics_funnels(project_id, created_at desc);

-- ── Saved retention cohorts ───────────────────────────────────────────────
create table if not exists public.analytics_cohorts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  description text,

  -- The event that places a user in a cohort (acquisition), and the event that
  -- counts as "retained" in a later period.
  acquisition_event text not null,
  return_event text not null,

  -- 'day' | 'week' | 'month' bucket for both cohort grouping and the retention
  -- period columns.
  period text not null default 'week' check (period in ('day','week','month')),
  periods int not null default 8,             -- how many period columns to compute

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analytics_cohorts_project_idx
  on public.analytics_cohorts(project_id, created_at desc);

-- Speeds up the analytics-query aggregations on the raw stream.
create index if not exists idx_product_events_name_time
  on public.product_events(project_id, event_name, occurred_at);
create index if not exists idx_product_events_user_time
  on public.product_events(project_id, user_email, occurred_at);

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.event_definitions enable row level security;
alter table public.analytics_funnels enable row level security;
alter table public.analytics_cohorts enable row level security;

-- Config objects are created/edited from the dashboard, so members get full
-- CRUD (scoped to their workspace); the edge functions use the service role.
do $$
declare t text;
begin
  foreach t in array array['event_definitions','analytics_funnels','analytics_cohorts']
  loop
    execute format('drop policy if exists "members manage %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members manage %1$s"
      on public.%1$s for all
      using (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
        )
      );
    $f$, t);
  end loop;
end $$;
