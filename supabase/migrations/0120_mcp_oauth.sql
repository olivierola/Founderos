-- 0120_mcp_oauth.sql
-- OAuth 2.1 authorization for MCP servers (the MCP "Authorization" spec), in
-- addition to the existing static-header auth. Per-server auth_mode; tokens are
-- shared at the workspace level (one connection per server). Secrets live in a
-- separate table with NO RLS policy → only the service role can read them.

-- auth_mode: 'none' (open server) | 'header' (static headers, the default/legacy)
--            | 'oauth' (interactive OAuth 2.1 flow).
alter table public.mcp_servers add column if not exists auth_mode text not null default 'header';
alter table public.mcp_servers drop constraint if exists mcp_servers_auth_mode_check;
alter table public.mcp_servers add constraint mcp_servers_auth_mode_check check (auth_mode in ('none','header','oauth'));

-- Non-secret OAuth state surfaced to the UI: discovered endpoints, client_id,
-- scope, resource, and { status: 'connected' | 'disconnected', connected_at }.
alter table public.mcp_servers add column if not exists oauth jsonb not null default '{}';

-- Secrets: access/refresh tokens, client_secret (if DCR issued one), and the
-- transient PKCE verifier + state during an in-flight authorization. RLS is
-- enabled with NO policy, so authenticated users can't read it — only the
-- service role (mcp-oauth / internal-agent-run) touches these values.
create table if not exists public.mcp_oauth_secrets (
  server_id     uuid primary key references public.mcp_servers(id) on delete cascade,
  client_secret text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  code_verifier text,
  state         text,
  redirect_uri  text,
  updated_at    timestamptz not null default now()
);

create index if not exists idx_mcp_oauth_secrets_state on public.mcp_oauth_secrets(state);

alter table public.mcp_oauth_secrets enable row level security;
-- (intentionally no policies — service-role only)
