-- Ops Module: servers, blueprints, generated infra files, jobs queue, checks.
-- Project-scoped (per the architecture decision). The runner — a Node.js
-- daemon polling ops_jobs — executes SSH/Ansible/Terraform/kubectl. This
-- migration creates the persistence layer; the runner code and edge functions
-- are shipped alongside.

-- ---- Servers ---------------------------------------------------------------
create table if not exists public.ops_servers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  -- Connection
  provider text default 'vps' check (provider in ('vps','hetzner','digitalocean','aws','gcp','azure','scaleway','ovh','other')),
  ip_address text not null,
  ssh_port int default 22,
  ssh_user text not null,
  -- Reference to the encrypted SSH private key blob (see ops_secrets below).
  ssh_key_secret_id uuid,
  -- Discovered metadata (filled by ops-server-test job)
  os_name text,
  os_version text,
  architecture text,
  cpu_count int,
  ram_mb int,
  disk_gb int,
  docker_installed boolean,
  nginx_installed boolean,
  ufw_enabled boolean,
  fail2ban_enabled boolean,
  -- Lifecycle
  environment text default 'production' check (environment in ('production','staging','development','sandbox')),
  domain text,
  status text default 'unknown' check (status in ('unknown','online','offline','degraded','provisioning','error')),
  last_checked_at timestamptz,
  last_check_result jsonb default '{}'::jsonb,
  -- Security score 0-100, computed by ops-server-test
  security_score int,
  -- Free-form tags (env, team, customer, etc.)
  tags text[] default '{}',
  metadata jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---- Ops secrets -----------------------------------------------------------
-- Mirror of `encrypted_credentials` pattern but for Ops scope (SSH keys, API
-- tokens for cloud providers, registry credentials, etc.). Service role only.
create table if not exists public.ops_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  server_id uuid references public.ops_servers(id) on delete cascade,
  kind text not null check (kind in ('ssh_private_key','cloud_token','registry_auth','env_var')),
  name text not null,
  encrypted_payload text not null,
  iv text not null,
  key_version text default 'v1',
  metadata jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- Wire the FK from ops_servers → ops_secrets now that the table exists.
alter table public.ops_servers
  add constraint ops_servers_ssh_key_fk foreign key (ssh_key_secret_id)
  references public.ops_secrets(id) on delete set null;

-- ---- Generated infra files -------------------------------------------------
-- Each row = one file the AI generated for a deployment workflow.
-- Lives independently of any specific server so blueprints can be reused.
create table if not exists public.ops_generated_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Bundle: a group of files generated together (a "workflow" run of the AI).
  bundle_id uuid not null,
  bundle_label text,                          -- e.g. "Docker Compose deploy for prod-01"
  -- File data
  file_path text not null,                    -- relative path inside the bundle
  file_type text not null check (file_type in (
    'dockerfile','docker_compose','nginx_conf','ansible_playbook','ansible_inventory',
    'terraform','kubernetes_manifest','helm_chart','env_example','script','readme','other'
  )),
  content text not null,
  -- Lifecycle
  status text default 'draft' check (status in ('draft','reviewed','applied','superseded')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz default now()
);

-- ---- Jobs queue (the heart of the runner) ---------------------------------
-- Each job is a unit of execution: an SSH command sequence, an Ansible
-- playbook apply, a Terraform plan/apply, a docker compose up, etc.
create table if not exists public.ops_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  server_id uuid references public.ops_servers(id) on delete set null,
  bundle_id uuid,                              -- optional link to a generated files bundle
  job_type text not null check (job_type in (
    -- Discovery / health
    'server_test','server_health','security_audit',
    -- Provisioning
    'ansible_apply','docker_install','nginx_setup','ssl_setup','firewall_setup','backup_setup',
    -- Terraform
    'terraform_plan','terraform_apply','terraform_destroy',
    -- Kubernetes
    'k8s_apply','k8s_rollout','k8s_rollback',
    -- App deploy
    'docker_compose_up','docker_compose_down','app_deploy','app_rollback','app_restart',
    -- Generic
    'ssh_exec','custom'
  )),
  -- Autonomy mode (one of the spec's 2 MVP modes; the 4-mode space is captured here for V2).
  autonomy_mode text default 'assisted' check (autonomy_mode in ('advisor','assisted','controlled','autopilot')),
  -- Risk classification for the approval UI
  risk_level text default 'medium' check (risk_level in ('low','medium','high','critical')),
  -- Lifecycle
  status text default 'draft' check (status in (
    'draft','awaiting_approval','approved','queued','running','succeeded','failed','cancelled','rolled_back'
  )),
  -- Approval flow
  requires_approval boolean default true,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  -- Job payload — interpreted by the runner.
  -- Examples:
  --   ssh_exec:    { commands: [{ run: "uname -a", allow_failure: false }] }
  --   ansible_apply: { playbook_id: uuid, extra_vars: {...} }
  --   terraform_apply: { bundle_id: uuid, target: "prod" }
  --   docker_compose_up: { bundle_id: uuid, service: "app" }
  input jsonb default '{}'::jsonb,
  -- Output written by the runner as it progresses.
  result jsonb default '{}'::jsonb,
  exit_code int,
  error_message text,
  -- Rollback chaining
  rollback_job_id uuid references public.ops_jobs(id) on delete set null,
  parent_job_id uuid references public.ops_jobs(id) on delete set null,
  -- Runner bookkeeping
  runner_id text,                              -- which runner picked this job
  attempts int default 0,
  -- Timestamps
  scheduled_at timestamptz default now(),
  picked_up_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ---- Job logs (append-only, streamed by the runner) -----------------------
create table if not exists public.ops_job_logs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ops_jobs(id) on delete cascade,
  level text default 'info' check (level in ('debug','info','warn','error','stdout','stderr')),
  message text not null,
  step text,                                   -- e.g. "Installing Docker"
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- ---- Checks (post-deploy validation + baseline comparison) ----------------
-- A check definition: a recurring or one-shot probe.
create table if not exists public.ops_check_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  server_id uuid references public.ops_servers(id) on delete set null,
  name text not null,
  -- Category drives display and aggregation.
  category text not null check (category in ('technical','product','security')),
  -- Probe details
  probe_type text not null check (probe_type in (
    'http_status','http_contains','http_latency','ssl_valid','dns_resolve',
    'tcp_port','container_running','disk_usage','memory_usage','custom_ssh'
  )),
  config jsonb default '{}'::jsonb,            -- url, expected_status, timeout_ms, etc.
  -- Thresholds for baseline comparison
  baseline jsonb default '{}'::jsonb,           -- { latency_ms: 180, status: 200 }
  -- Mode
  mode text default 'post_deploy' check (mode in ('post_deploy','baseline_compare','scheduled')),
  enabled boolean default true,
  created_at timestamptz default now()
);

-- Each individual check execution (one row per probe attempt).
create table if not exists public.ops_check_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  definition_id uuid references public.ops_check_definitions(id) on delete cascade,
  -- Optional links so runs can be grouped: "all checks after deployment X"
  deployment_id uuid,
  job_id uuid references public.ops_jobs(id) on delete set null,
  status text not null check (status in ('passed','failed','warn','skipped')),
  measured_value jsonb default '{}'::jsonb,    -- { latency_ms: 920, status: 200 }
  delta jsonb default '{}'::jsonb,             -- vs baseline
  message text,
  duration_ms int,
  created_at timestamptz default now()
);

-- ---- Per-project Ops settings ---------------------------------------------
create table if not exists public.ops_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Where the runner phones home; set to NULL until a runner is registered.
  runner_url text,
  runner_token_hash text,                      -- for runner auth (compare against incoming X-Runner-Token)
  default_autonomy_mode text default 'assisted' check (default_autonomy_mode in ('advisor','assisted','controlled','autopilot')),
  -- Command allowlist / denylist (regex patterns)
  command_denylist text[] default array[
    'rm\s+-rf\s+/',
    'mkfs',
    '\bdd\s+if=',
    '\bshutdown\b',
    '\breboot\b',
    'ufw\s+disable',
    'iptables\s+-F',
    '\buserdel\b',
    'DROP\s+DATABASE',
    'terraform\s+destroy',
    'kubectl\s+delete\s+namespace'
  ],
  command_allowlist text[] default '{}',
  -- Notification preferences
  notify_on_job_status text[] default array['failed','succeeded'],
  updated_at timestamptz default now()
);

-- ---- Infra blueprints in scan_results -------------------------------------
-- Add a column instead of a separate table — a blueprint is a derived view of
-- a scan, not a first-class resource.
alter table public.scan_results
  add column if not exists infra_blueprint jsonb default '{}'::jsonb;

-- ============================================================================
-- RLS
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'ops_servers','ops_secrets','ops_generated_files','ops_jobs','ops_job_logs',
    'ops_check_definitions','ops_check_runs','ops_settings'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- Workspace members can read & manage ops_servers, generated files, jobs,
-- logs, checks, and settings for their workspace's projects.
do $$
declare t text;
begin
  -- Tables that own a workspace_id column directly.
  foreach t in array array[
    'ops_servers','ops_generated_files','ops_jobs',
    'ops_check_definitions','ops_check_runs','ops_settings'
  ]
  loop
    -- Drop-then-create so the migration replays cleanly on top of partial state.
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s"
      on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members manage %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')))
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')));
    $f$, t);
  end loop;
end $$;

-- ops_job_logs has no workspace_id of its own — it inherits scope from its
-- parent ops_jobs row. Members of the job's workspace can read; insert is
-- restricted to service role (the runner uses it via ops-runner-poll).
drop policy if exists "Members read ops_job_logs" on public.ops_job_logs;
create policy "Members read ops_job_logs"
on public.ops_job_logs for select
using (exists (
  select 1
  from public.ops_jobs j
  join public.workspace_members wm on wm.workspace_id = j.workspace_id
  where j.id = ops_job_logs.job_id and wm.user_id = auth.uid()
));

-- ops_secrets: intentionally NO select policy — only service role (edge
-- functions and the runner) can read the encrypted payloads. Frontend never
-- decrypts. Admins can delete to rotate.
drop policy if exists "Workspace admins delete ops_secrets" on public.ops_secrets;
create policy "Workspace admins delete ops_secrets"
on public.ops_secrets for delete
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = ops_secrets.workspace_id and wm.user_id = auth.uid()
      and wm.role in ('owner','admin'))
);

-- Allow members to insert references metadata (the encrypted payload is
-- written via service role from an edge function).
drop policy if exists "Workspace members can register ops_secrets" on public.ops_secrets;
create policy "Workspace members can register ops_secrets"
on public.ops_secrets for insert
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = ops_secrets.workspace_id and wm.user_id = auth.uid()
      and wm.role in ('owner','admin','member'))
);

-- ============================================================================
-- Indexes
-- ============================================================================

create index if not exists idx_ops_servers_project on public.ops_servers(project_id);
create index if not exists idx_ops_servers_status on public.ops_servers(status);
create index if not exists idx_ops_secrets_server on public.ops_secrets(server_id);
create index if not exists idx_ops_generated_files_bundle on public.ops_generated_files(bundle_id);
create index if not exists idx_ops_generated_files_project on public.ops_generated_files(project_id, created_at desc);
create index if not exists idx_ops_jobs_project_status on public.ops_jobs(project_id, status);
create index if not exists idx_ops_jobs_queue on public.ops_jobs(status, scheduled_at)
  where status in ('queued','running');
create index if not exists idx_ops_jobs_server on public.ops_jobs(server_id, created_at desc);
create index if not exists idx_ops_job_logs_job on public.ops_job_logs(job_id, created_at);
create index if not exists idx_ops_check_runs_project on public.ops_check_runs(project_id, created_at desc);
create index if not exists idx_ops_check_runs_definition on public.ops_check_runs(definition_id, created_at desc);

-- ============================================================================
-- Helper: claim_ops_job — atomic job pickup for the runner.
-- The runner calls this RPC; it returns the next queued job (FIFO) and marks
-- it as running. Prevents two runners from grabbing the same job.
-- ============================================================================

create or replace function public.claim_ops_job(p_runner_id text)
returns public.ops_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.ops_jobs;
begin
  -- Pick the oldest queued job, lock the row, mark it running.
  select * into v_job
  from public.ops_jobs
  where status = 'queued'
  order by scheduled_at asc
  limit 1
  for update skip locked;

  if v_job.id is null then
    return null;
  end if;

  update public.ops_jobs
     set status = 'running',
         runner_id = p_runner_id,
         picked_up_at = now(),
         started_at = now(),
         attempts = attempts + 1
   where id = v_job.id
   returning * into v_job;

  return v_job;
end;
$$;

-- A runner-friendly view of a job's transcript (logs concatenated by step).
create or replace function public.ops_job_transcript(p_job_id uuid)
returns jsonb
language sql stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'step', l.step,
    'level', l.level,
    'message', l.message,
    'at', l.created_at
  ) order by l.created_at), '[]'::jsonb)
  from public.ops_job_logs l
  where l.job_id = p_job_id;
$$;
