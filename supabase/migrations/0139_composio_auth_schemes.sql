-- Broaden Composio connections beyond OAuth: a toolkit can have a cached
-- auth config per auth scheme (OAuth-managed AND, separately, a custom
-- API_KEY/NO_AUTH one), so the cache key needs the scheme alongside the slug.

alter table public.composio_auth_configs
  add column if not exists auth_scheme text not null default 'OAUTH2';

alter table public.composio_auth_configs drop constraint composio_auth_configs_pkey;
alter table public.composio_auth_configs add primary key (toolkit_slug, auth_scheme);
