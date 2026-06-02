-- Ops module evolution: targets can be either a Server (VPS we SSH into) or
-- a Managed target (Vercel, Netlify, Fly, Railway, Render, Cloudflare…) where
-- we drive deployments via the provider's API using an existing Connector.
--
-- We don't fork the table — ops_servers becomes the single "target" entity
-- with a target_kind discriminator. SSH-only columns become optional when
-- target_kind = 'managed'.

alter table public.ops_servers
  -- Type of target: 'server' is the original (SSH/Ansible), 'managed' uses a
  -- Connector + provider API instead.
  add column if not exists target_kind text not null default 'server'
    check (target_kind in ('server', 'managed')),
  -- For managed targets, points to the existing public.connectors row that
  -- holds the provider credentials. Null for SSH servers.
  add column if not exists connector_id uuid references public.connectors(id) on delete set null,
  -- Convenience copy of the provider name (vercel, netlify, fly, railway,
  -- render, cloudflare, supabase). Kept de-normalised to make Servers list
  -- queries cheap, but ALWAYS reflects the joined connectors.provider.
  add column if not exists managed_provider text;

-- Relax SSH constraints: when target_kind = 'managed', SSH fields are
-- meaningless. We don't enforce NOT NULL on them anyway (the original
-- definition kept them nullable), so this is just documentation.
comment on column public.ops_servers.target_kind is
  'server = managed via SSH/Ansible. managed = managed via provider API + connector_id.';

-- A managed target should always have a connector_id; we encode it as a
-- partial CHECK so existing rows (all 'server') pass.
alter table public.ops_servers
  drop constraint if exists ops_servers_managed_requires_connector;
alter table public.ops_servers
  add constraint ops_servers_managed_requires_connector
  check (target_kind = 'server' or connector_id is not null);

create index if not exists idx_ops_servers_target_kind
  on public.ops_servers(target_kind);
create index if not exists idx_ops_servers_connector
  on public.ops_servers(connector_id);

-- ------------------------------------------------------------------------
-- Extend ops_jobs.job_type with managed deployment jobs.
-- ------------------------------------------------------------------------
-- Postgres won't let us add values to an existing CHECK constraint atomically
-- without dropping it, so we do exactly that.

alter table public.ops_jobs drop constraint if exists ops_jobs_job_type_check;
alter table public.ops_jobs add constraint ops_jobs_job_type_check
  check (job_type in (
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
    -- Managed provider deploys (new)
    'managed_deploy','managed_redeploy','managed_rollback','managed_env_sync',
    -- Generic
    'ssh_exec','custom'
  ));

-- ------------------------------------------------------------------------
-- Extend the existing public.deployments table to carry an Ops linkage and a
-- "source" tag so the Ops Overview can be the deployment hub.
-- ------------------------------------------------------------------------

alter table public.deployments
  -- Where this deployment came from in terms of FounderOS workflow:
  --   external_sync = pulled via sync-deployments from Vercel/Netlify/...
  --   founderos_ops = triggered by Ops (ops-managed-deploy or app_deploy job)
  add column if not exists source text default 'external_sync'
    check (source in ('external_sync','founderos_ops','manual')),
  -- When source = founderos_ops, the originating Ops job.
  add column if not exists ops_job_id uuid references public.ops_jobs(id) on delete set null,
  -- When applicable, the Ops target the deployment landed on.
  add column if not exists ops_server_id uuid references public.ops_servers(id) on delete set null;

create index if not exists idx_deployments_source
  on public.deployments(source);
create index if not exists idx_deployments_ops_job
  on public.deployments(ops_job_id);
