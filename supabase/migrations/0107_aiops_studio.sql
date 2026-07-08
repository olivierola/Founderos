-- 0107_aiops_studio.sql
-- Makes the AI Ops & Governance module fully functional: every entity of the
-- Guardrails / Ops / Fine-tuning Studio tabs becomes a real, project-scoped
-- table (same members-RLS block as 0106_governance). No edge functions — the
-- frontend reads/writes directly. Telemetry tabs (accès agents, prompts,
-- dépenses, incidents de runs) read the REAL internal_agent_runs /
-- internal_agent_run_events tables and need nothing here. Audit reuses
-- gov_audit_events; production-deploy approvals reuse gov_approvals.
-- Training/inference compute is simulated client-side (no GPU backend), but
-- the full lifecycle state machine (job → version → deployment → monitoring)
-- lives in these tables.

-- ── Guardrails (markdown rules, previously localStorage) ─────────────────────
create table if not exists public.aiops_guardrails (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  category text not null default 'Général',
  enforcement text not null default 'warn' check (enforcement in ('block','warn','log')),
  enabled boolean not null default true,
  body text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_guardrails_project on public.aiops_guardrails(project_id);

-- ── Private inference servers ────────────────────────────────────────────────
create table if not exists public.aiops_servers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  region text not null default 'eu-west · Paris',
  status text not null default 'online' check (status in ('online','degraded','offline')),
  gpu text not null default '1× H100 80GB',
  cpu_pct int not null default 30,
  ram_pct int not null default 40,
  gpu_pct int not null default 35,
  req_per_min int not null default 10,
  uptime_pct numeric(6,2) not null default 99.9,
  cost_per_day numeric(10,2) not null default 20,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_servers_project on public.aiops_servers(project_id);

-- ── Where each real agent's inference runs (cloud API or private server) ─────
create table if not exists public.aiops_agent_deployments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id uuid not null references public.internal_agents(id) on delete cascade,
  server_id uuid references public.aiops_servers(id) on delete set null, -- null → cloud
  model text not null,
  env text not null default 'prod' check (env in ('prod','staging')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id)
);
create index if not exists idx_aiops_agent_deploys_project on public.aiops_agent_deployments(project_id);

-- ── Infrastructure incidents (server-level) ──────────────────────────────────
create table if not exists public.aiops_infra_incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  server_id uuid references public.aiops_servers(id) on delete set null,
  server_name text not null default '',
  kind text not null check (kind in ('gpu_oom','disk_full','network_latency','service_down','overheat','driver_crash')),
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','resolved')),
  cause text not null default '',
  impact text not null default '',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_aiops_infra_project on public.aiops_infra_incidents(project_id);

-- ── Model catalog state: enabled cloud APIs + installs on servers ────────────
create table if not exists public.aiops_model_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  model_id text not null,                          -- id from the static MODEL_CATALOG
  kind text not null check (kind in ('cloud_enabled','install')),
  server_id uuid references public.aiops_servers(id) on delete cascade, -- installs only
  status text not null default 'enabled' check (status in ('enabled','installing','installed')),
  progress_pct int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_model_state_project on public.aiops_model_state(project_id);
create unique index if not exists uq_aiops_model_state on public.aiops_model_state(project_id, model_id, kind, coalesce(server_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── Fine-tuning: datasets (with the cleaning pipeline state) ─────────────────
create table if not exists public.aiops_ft_datasets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  ds_type text not null default 'jsonl',
  source text not null default 'Import manuel',
  docs int not null default 0,
  rows int not null default 0,
  tokens bigint not null default 0,
  size_mb numeric(10,1) not null default 0,
  lang text not null default 'FR',
  version text not null default 'v1',
  tags text[] not null default '{}',
  quality text not null default 'cleaning' check (quality in ('validated','cleaning','issues')),
  cleaning jsonb not null default '[]'::jsonb,     -- [{step,status,note}]
  before_stats jsonb not null default '{}'::jsonb, -- {rows,tokens}
  removed jsonb not null default '{}'::jsonb,      -- {dups,pii,html,emails}
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_datasets_project on public.aiops_ft_datasets(project_id);

-- ── Fine-tuning: labeling tasks (AI suggests → human validates) ──────────────
create table if not exists public.aiops_ft_label_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  dataset text not null,
  label_sets text[] not null default '{}',
  total int not null default 0,
  ai_suggested int not null default 0,
  human_validated int not null default 0,
  agreement_pct numeric(6,1) not null default 0,
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_labels_project on public.aiops_ft_label_tasks(project_id);

-- ── Fine-tuning: training jobs (client ticker advances running jobs) ─────────
create table if not exists public.aiops_ft_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  base_model text not null,
  dataset text not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  progress_pct int not null default 0,
  epochs int not null default 3,
  loss jsonb not null default '[]'::jsonb,
  gpu_hours numeric(10,1) not null default 0,
  cost_usd numeric(10,2) not null default 0,
  server_id uuid references public.aiops_servers(id) on delete set null,
  gpu text not null default 'H100',
  time_h numeric(10,1) not null default 0,
  accuracy numeric(6,1),                           -- null until succeeded
  hp jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_jobs_project on public.aiops_ft_jobs(project_id);

-- ── Fine-tuning: model registry (versions, created when a job succeeds) ──────
create table if not exists public.aiops_ft_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  version text not null default 'v1',
  base_model text not null,
  dataset text not null,
  status text not null default 'ready' check (status in ('deployed','ready','archived')),
  win_rate numeric(6,1) not null default 0,
  accuracy numeric(6,1) not null default 0,
  size_gb numeric(10,1) not null default 0,
  job_id uuid references public.aiops_ft_jobs(id) on delete set null,
  job_name text not null default '',
  author text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_versions_project on public.aiops_ft_versions(project_id);

-- ── Fine-tuning: experiments (N runs compared on one goal) ───────────────────
create table if not exists public.aiops_ft_experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  dataset text not null,
  goal text not null default '',
  status text not null default 'running' check (status in ('running','done')),
  runs jsonb not null default '[]'::jsonb,         -- [{model,accuracy,f1,latencyMs,costPerKTok}]
  winner text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_experiments_project on public.aiops_ft_experiments(project_id);

-- ── Fine-tuning: evaluations (before/after + auto benchmark) ─────────────────
create table if not exists public.aiops_ft_evals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  tuned_model text not null,
  base_model text not null,
  status text not null default 'running' check (status in ('running','done')),
  win_rate numeric(6,1) not null default 0,
  criteria jsonb not null default '[]'::jsonb,
  benchmark jsonb not null default '{}'::jsonb,
  samples int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_evals_project on public.aiops_ft_evals(project_id);

-- ── Fine-tuning: deployed endpoints (prod deploys gated by approval) ─────────
create table if not exists public.aiops_ft_endpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  version_id uuid references public.aiops_ft_versions(id) on delete cascade,
  version_name text not null,
  version text not null,
  server_id uuid references public.aiops_servers(id) on delete set null,
  env text not null default 'staging' check (env in ('prod','staging','development','testing','canary','bluegreen','ab')),
  surface text not null default 'api' check (surface in ('api','chatbot','slack','teams','crm','web','app')),
  traffic_pct int not null default 100,
  auto_rollback boolean not null default true,
  status text not null default 'active' check (status in ('pending_approval','active','rolled_back')),
  metrics jsonb not null default '{}'::jsonb,      -- {reqPerMin,p95Ms,errRatePct,driftScore,hallucinationPct,satisfactionPct,tokensPerDay}
  since timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_ft_endpoints_project on public.aiops_ft_endpoints(project_id);

-- ── Monitoring alert rules ───────────────────────────────────────────────────
create table if not exists public.aiops_alert_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  rule text not null,
  slack boolean not null default true,
  email boolean not null default false,
  sms boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_alert_rules_project on public.aiops_alert_rules(project_id);

-- ── RBAC roles for the studio ────────────────────────────────────────────────
create table if not exists public.aiops_ft_roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null,
  members int not null default 0,
  can_train boolean not null default false,
  can_delete_model boolean not null default false,
  can_deploy boolean not null default false,
  can_edit_datasets boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, role)
);
create index if not exists idx_aiops_ft_roles_project on public.aiops_ft_roles(project_id);

-- ── Studio settings (one row per project) ────────────────────────────────────
create table if not exists public.aiops_ft_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (project_id)
);

-- ── RLS: workspace members read/write (same block as 0106) ───────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'aiops_guardrails','aiops_servers','aiops_agent_deployments','aiops_infra_incidents',
    'aiops_model_state','aiops_ft_datasets','aiops_ft_label_tasks','aiops_ft_jobs',
    'aiops_ft_versions','aiops_ft_experiments','aiops_ft_evals','aiops_ft_endpoints',
    'aiops_alert_rules','aiops_ft_roles','aiops_ft_settings'
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
