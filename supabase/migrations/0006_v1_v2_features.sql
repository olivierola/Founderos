-- FounderOS — Sprint 9: Engagement, Compliance, Workflows, Runbooks,
-- Errors, Incidents, Webhooks Out, API Keys, Team Invitations, Deployments.

-- product_events (engagement) -------------------------------------------
create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  event_name text not null,
  customer_external_id text,
  user_email text,
  properties jsonb default '{}'::jsonb,
  occurred_at timestamptz default now(),
  created_at timestamptz default now()
);
alter table public.product_events enable row level security;
create policy "Members read product_events"
on public.product_events for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = product_events.workspace_id and wm.user_id = auth.uid())
);

-- compliance_controls ----------------------------------------------------
create table if not exists public.compliance_controls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  framework text not null check (framework in ('gdpr','soc2','iso27001','hipaa')),
  control_key text not null,
  status text not null default 'pending' check (status in ('pending','in_progress','satisfied','not_applicable')),
  evidence text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (workspace_id, framework, control_key)
);
alter table public.compliance_controls enable row level security;
create policy "Members read compliance"
on public.compliance_controls for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = compliance_controls.workspace_id and wm.user_id = auth.uid())
);
create policy "Admins mutate compliance"
on public.compliance_controls for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = compliance_controls.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = compliance_controls.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
);

-- workflows --------------------------------------------------------------
create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  description text,
  trigger_event text not null,
  steps jsonb default '[]'::jsonb,
  enabled boolean default true,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
alter table public.workflows enable row level security;
create policy "Members read workflows"
on public.workflows for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = workflows.workspace_id and wm.user_id = auth.uid())
);
create policy "Admins mutate workflows"
on public.workflows for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = workflows.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = workflows.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
);

create table if not exists public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  workflow_id uuid references public.workflows(id) on delete cascade,
  status text default 'pending' check (status in ('pending','running','succeeded','failed')),
  trigger_payload jsonb default '{}'::jsonb,
  result jsonb default '{}'::jsonb,
  error_message text,
  started_at timestamptz default now(),
  finished_at timestamptz
);
alter table public.workflow_runs enable row level security;
create policy "Members read workflow_runs"
on public.workflow_runs for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = workflow_runs.workspace_id and wm.user_id = auth.uid())
);

-- runbooks ---------------------------------------------------------------
create table if not exists public.runbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  category text,
  steps jsonb default '[]'::jsonb,
  generated_by_ai boolean default false,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
alter table public.runbooks enable row level security;
create policy "Members read runbooks"
on public.runbooks for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = runbooks.workspace_id and wm.user_id = auth.uid())
);
create policy "Admins mutate runbooks"
on public.runbooks for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = runbooks.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = runbooks.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
);

-- error_events (Errors page) --------------------------------------------
create table if not exists public.error_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  source text default 'manual',
  level text default 'error' check (level in ('warn','error','fatal')),
  message text not null,
  stack text,
  url text,
  user_agent text,
  fingerprint text,
  occurrences int default 1,
  metadata jsonb default '{}'::jsonb,
  last_seen_at timestamptz default now(),
  first_seen_at timestamptz default now()
);
alter table public.error_events enable row level security;
create policy "Members read error_events"
on public.error_events for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = error_events.workspace_id and wm.user_id = auth.uid())
);

-- incidents --------------------------------------------------------------
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  description text,
  severity text default 'minor' check (severity in ('minor','major','critical')),
  status text default 'open' check (status in ('open','identified','monitoring','resolved')),
  started_at timestamptz default now(),
  resolved_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
alter table public.incidents enable row level security;
create policy "Members read incidents"
on public.incidents for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = incidents.workspace_id and wm.user_id = auth.uid())
);
create policy "Admins mutate incidents"
on public.incidents for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = incidents.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = incidents.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
);

-- outgoing webhooks -----------------------------------------------------
create table if not exists public.outgoing_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  url text not null,
  events text[] default '{}',
  secret text,
  enabled boolean default true,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
alter table public.outgoing_webhooks enable row level security;
create policy "Members read outgoing_webhooks"
on public.outgoing_webhooks for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = outgoing_webhooks.workspace_id and wm.user_id = auth.uid())
);
create policy "Admins mutate outgoing_webhooks"
on public.outgoing_webhooks for all
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = outgoing_webhooks.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
)
with check (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = outgoing_webhooks.workspace_id
      and wm.user_id = auth.uid() and wm.role in ('owner','admin'))
);

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid references public.outgoing_webhooks(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  event_type text not null,
  payload jsonb default '{}'::jsonb,
  status_code int,
  response_body text,
  attempts int default 1,
  delivered_at timestamptz,
  created_at timestamptz default now()
);
alter table public.webhook_deliveries enable row level security;
create policy "Members read webhook_deliveries"
on public.webhook_deliveries for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = webhook_deliveries.workspace_id and wm.user_id = auth.uid())
);

-- founder_api_keys (real, server-side, hashed) -------------------------
create table if not exists public.founder_api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  label text not null,
  key_hash text not null,
  key_prefix text not null,
  last_used_at timestamptz,
  created_at timestamptz default now()
);
alter table public.founder_api_keys enable row level security;
create policy "Users read own api keys"
on public.founder_api_keys for select
using (user_id = auth.uid());
create policy "Users delete own api keys"
on public.founder_api_keys for delete
using (user_id = auth.uid());

-- team_invitations -----------------------------------------------------
create table if not exists public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner','admin','member','viewer')),
  token text unique not null,
  invited_by uuid references auth.users(id),
  status text default 'pending' check (status in ('pending','accepted','revoked','expired')),
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '14 days'),
  accepted_at timestamptz
);
alter table public.team_invitations enable row level security;
create policy "Members read team_invitations"
on public.team_invitations for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = team_invitations.workspace_id and wm.user_id = auth.uid())
);

-- deployments ---------------------------------------------------------
create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text default 'github',
  environment text default 'production',
  sha text,
  ref text,
  state text,
  url text,
  created_at_provider timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, provider, sha, environment)
);
alter table public.deployments enable row level security;
create policy "Members read deployments"
on public.deployments for select
using (
  exists (select 1 from public.workspace_members wm
    where wm.workspace_id = deployments.workspace_id and wm.user_id = auth.uid())
);

-- fos_run_select: SECURITY DEFINER function used by run-sql Edge Function
-- to execute a single safe SELECT with a hard statement timeout.
create or replace function public.fos_run_select(query_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  result jsonb;
begin
  if query_text is null or btrim(query_text) = '' then
    raise exception 'empty query';
  end if;
  if not (lower(btrim(query_text)) like 'select%') then
    raise exception 'only SELECT allowed';
  end if;
  perform set_config('statement_timeout', '5000', true);
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query_text) into result;
  return result;
end;
$$;

revoke all on function public.fos_run_select(text) from public;
grant execute on function public.fos_run_select(text) to service_role;

-- Indexes -------------------------------------------------------------
create index if not exists idx_product_events_project on public.product_events(project_id, occurred_at desc);
create index if not exists idx_product_events_name on public.product_events(project_id, event_name);
create index if not exists idx_workflow_runs_workflow on public.workflow_runs(workflow_id, started_at desc);
create index if not exists idx_error_events_project on public.error_events(project_id, last_seen_at desc);
create index if not exists idx_error_events_fingerprint on public.error_events(project_id, fingerprint);
create index if not exists idx_incidents_project on public.incidents(project_id, status, started_at desc);
create index if not exists idx_webhook_deliveries_webhook on public.webhook_deliveries(webhook_id, created_at desc);
create index if not exists idx_team_invitations_workspace on public.team_invitations(workspace_id, status);
create index if not exists idx_deployments_project on public.deployments(project_id, created_at_provider desc);
