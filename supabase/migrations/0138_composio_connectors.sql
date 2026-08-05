-- Composio-backed connectors, added alongside (not replacing) the in-house
-- credential-paste system in 0002_scan_pipeline.sql. Every existing row,
-- column, table and edge function of that system stays untouched — this
-- migration is purely additive so the old path can be revived later.

alter table public.connectors
  add column if not exists source text not null default 'in_house',
  add column if not exists composio_connected_account_id text,
  add column if not exists composio_auth_config_id text;

alter table public.connectors
  add constraint connectors_source_check check (source in ('in_house', 'composio'));

-- A project may now have both an in-house AND a Composio connection for the
-- same provider slug — disambiguate the unique key by source.
alter table public.connectors
  drop constraint connectors_workspace_id_project_id_provider_key;
alter table public.connectors
  add constraint connectors_workspace_id_project_id_provider_source_key
  unique (workspace_id, project_id, provider, source);

-- 'pending' covers the window between initiating a Composio OAuth connection
-- and the user completing it (polled by composio-connection-status).
alter table public.connectors
  drop constraint connectors_status_check;
alter table public.connectors
  add constraint connectors_status_check check (
    status in ('detected', 'not_connected', 'pending', 'connected', 'invalid_credentials', 'read_only', 'write_enabled', 'needs_attention')
  );

-- Cache of Composio "auth config" ids per toolkit — created lazily, once,
-- the first time any project connects that toolkit (Composio-managed OAuth
-- auth configs are not project-scoped). Service-role only, same pattern as
-- encrypted_credentials: no client select/insert policy.
create table if not exists public.composio_auth_configs (
  toolkit_slug text primary key,
  auth_config_id text not null,
  created_at timestamptz default now()
);

alter table public.composio_auth_configs enable row level security;
