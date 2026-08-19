-- 0201_public_agent_mcp.sql
-- Public (customer-facing) agents get MCP servers as their capability layer.
--
-- This is how a public agent reaches a catalogue and gets ACTIONS: not a
-- bespoke REST integration per platform, but the MCP servers the merchant
-- already has. Shopify's Storefront MCP (https://{shop}/api/mcp — one
-- unauthenticated endpoint per store, exposing catalogue search and cart
-- operations) is the reference case; anything else speaking MCP works the same
-- way, which is the whole point of going through the protocol.
--
-- The registry itself (mcp_servers, 0119/0120, with its OAuth support) is
-- reused as-is. What's missing is the attach side: agent_mcp_servers points at
-- internal_agents, and a public agent is a rag_agents row.

-- ── Attach: which servers (and which of their tools) a public agent may use ──
create table if not exists public.rag_agent_mcp_servers (
  agent_id      uuid not null references public.rag_agents(id) on delete cascade,
  server_id     uuid not null references public.mcp_servers(id) on delete cascade,

  -- Per-tool allowlist. Unlike the internal-agent attach — where activating a
  -- server grants all its tools to a trusted employee — a public agent is
  -- driven by anonymous internet traffic, and a storefront MCP exposes cart
  -- mutations next to catalogue reads. So the merchant ticks tools explicitly
  -- and an EMPTY array grants nothing.
  allowed_tools text[] not null default '{}',

  created_at    timestamptz not null default now(),
  primary key (agent_id, server_id)
);

create index if not exists idx_rag_agent_mcp_servers_server on public.rag_agent_mcp_servers(server_id);

-- ── Per-agent tool-use switches ──────────────────────────────────────────────
alter table public.rag_agents
  -- Off by default: turning a RAG answerer into something that calls external
  -- systems on behalf of strangers is an explicit decision, and it changes the
  -- cost profile of every message (a tool loop is several completions).
  add column if not exists tool_use_enabled boolean not null default false,
  -- Ceiling on tool-call rounds per message.
  add column if not exists max_tool_calls int not null default 4,
  -- Public storefront origin, when product links from the MCP server point at
  -- an internal/admin host (a Shopify store on a custom domain).
  add column if not exists storefront_url text;

alter table public.rag_agents drop constraint if exists rag_agents_max_tool_calls_check;
alter table public.rag_agents add constraint rag_agents_max_tool_calls_check
  check (max_tool_calls between 1 and 10);

-- ── Audit ────────────────────────────────────────────────────────────────────
-- An anonymous visitor can now cause calls into a merchant's live store (adding
-- to a cart, reading a catalogue). That needs a trail the merchant can read:
-- what was called, with which arguments, for which visitor, and whether it
-- worked. It is also the only place a tool-loop cost shows up per conversation.
create table if not exists public.rag_agent_tool_calls (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  agent_id        uuid not null references public.rag_agents(id) on delete cascade,
  conversation_id uuid references public.rag_conversations(id) on delete set null,
  visitor_id      text,
  server_id       uuid references public.mcp_servers(id) on delete set null,
  tool_name       text not null,
  args            jsonb not null default '{}',
  ok              boolean not null default true,
  error           text,
  duration_ms     int,
  created_at      timestamptz not null default now()
);

create index if not exists idx_rag_agent_tool_calls_agent
  on public.rag_agent_tool_calls(agent_id, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.rag_agent_mcp_servers enable row level security;
alter table public.rag_agent_tool_calls  enable row level security;

drop policy if exists "members manage rag agent mcp servers" on public.rag_agent_mcp_servers;
create policy "members manage rag agent mcp servers" on public.rag_agent_mcp_servers for all
  using (exists (
    select 1 from public.rag_agents a
    join public.workspace_members wm on wm.workspace_id = a.workspace_id
    where a.id = rag_agent_mcp_servers.agent_id and wm.user_id = auth.uid()))
  with check (exists (
    select 1 from public.rag_agents a
    join public.workspace_members wm on wm.workspace_id = a.workspace_id
    where a.id = rag_agent_mcp_servers.agent_id and wm.user_id = auth.uid()));

-- Read-only from the client: rows are written by rag-chat on a visitor's
-- behalf, and an audit trail a member can edit is not an audit trail.
drop policy if exists "members read rag agent tool calls" on public.rag_agent_tool_calls;
create policy "members read rag agent tool calls" on public.rag_agent_tool_calls for select
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = rag_agent_tool_calls.workspace_id and wm.user_id = auth.uid()));
