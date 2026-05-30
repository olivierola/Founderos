-- Daily snapshot of SaaS KPIs surfaced in Actions → SaaS Analytics.
-- Computed by an edge function (generate-saas-analytics-snapshot) — typically
-- triggered by a cron or on-demand "refresh" button in the UI.

create table if not exists saas_analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  snapshot_date date not null,

  -- Revenue
  mrr_cents bigint default 0,
  arr_cents bigint default 0,
  mrr_growth_pct numeric,                 -- vs previous snapshot
  net_new_mrr_cents bigint default 0,

  -- Users / retention
  total_users int default 0,
  active_users_30d int default 0,
  new_signups_7d int default 0,
  churn_rate_30d numeric,                 -- 0..1
  churn_users_30d int default 0,
  paying_users int default 0,

  -- Engagement / activation
  activation_rate numeric,                -- signups → first key action
  top_features jsonb default '[]'::jsonb, -- [{ feature, usage_count }]

  -- Operational alerts that warrant an Action
  open_alerts int default 0,
  open_incidents int default 0,
  failed_payments_7d int default 0,
  pending_approvals int default 0,

  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, snapshot_date)
);

create index if not exists saas_analytics_snapshots_project_date_idx
  on saas_analytics_snapshots(project_id, snapshot_date desc);

alter table saas_analytics_snapshots enable row level security;

create policy "members read saas_analytics_snapshots"
  on saas_analytics_snapshots for select
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = saas_analytics_snapshots.workspace_id
      and wm.user_id = auth.uid()
    )
  );

create policy "service role writes saas_analytics_snapshots"
  on saas_analytics_snapshots for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
