-- 0119_mcp_servers.sql
-- MCP (Model Context Protocol) servers as tool providers for the AI workforce.
-- A workspace registers remote MCP servers (Streamable HTTP / SSE); each internal
-- agent can attach a subset. At run time internal-agent-run discovers the server's
-- tools (cached here) and exposes them to the agent, executing via JSON-RPC
-- tools/call. HTTP/SSE remote transport only (edge-callable) — no stdio.

create table if not exists public.mcp_servers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text,
  transport      text not null default 'http' check (transport in ('http','sse')),
  url            text not null,
  -- Auth / custom headers sent on every request (e.g. { "Authorization": "Bearer …" }).
  headers        jsonb not null default '{}',
  enabled        boolean not null default true,
  -- Tools discovered from tools/list, cached so the run loop doesn't re-handshake
  -- every tick: [{ name, description, inputSchema }].
  cached_tools   jsonb not null default '[]',
  status         text,            -- 'ok' | 'error' | null (never tested)
  last_error     text,
  last_checked_at timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, name)
);

create index if not exists idx_mcp_servers_workspace on public.mcp_servers(workspace_id);

create table if not exists public.agent_mcp_servers (
  agent_id   uuid not null references public.internal_agents(id) on delete cascade,
  server_id  uuid not null references public.mcp_servers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agent_id, server_id)
);

alter table public.mcp_servers enable row level security;
alter table public.agent_mcp_servers enable row level security;

create policy "members manage mcp_servers" on public.mcp_servers for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = mcp_servers.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = mcp_servers.workspace_id and wm.user_id = auth.uid()));

create policy "members manage agent_mcp_servers" on public.agent_mcp_servers for all
  using  (exists (select 1 from public.internal_agents a join public.workspace_members wm on wm.workspace_id = a.workspace_id where a.id = agent_mcp_servers.agent_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.internal_agents a join public.workspace_members wm on wm.workspace_id = a.workspace_id where a.id = agent_mcp_servers.agent_id and wm.user_id = auth.uid()));
