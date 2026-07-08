-- 0100_agent_channels.sql
-- Connect an internal agent to external chat channels (Slack first). A user
-- @mentions the agent in a channel → it answers in that thread, keeping context.
--
-- Metadata lives in internal_agent_channels (RLS: agent access). The Slack bot
-- token lives in a SERVICE-ROLE-ONLY table so it never reaches the browser.
-- The reply is posted back by the run finalizer using the binding stored on the
-- conversation (external Slack thread OR an internal project-inbox channel).

-- ── Channel connections (user-readable metadata) ──────────────────────────────
create table if not exists public.internal_agent_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  agent_id uuid references public.internal_agents(id) on delete cascade,
  provider text not null default 'slack' check (provider in ('slack','teams','discord','telegram')),
  external_team_id text,
  team_name text,
  bot_user_id text,
  trigger text not null default 'mention' check (trigger in ('mention','all')),
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (provider, external_team_id, agent_id)
);
create index if not exists idx_internal_agent_channels_agent on public.internal_agent_channels(agent_id);
create index if not exists idx_internal_agent_channels_team on public.internal_agent_channels(provider, external_team_id);

alter table public.internal_agent_channels enable row level security;

drop policy if exists internal_agent_channels_select on public.internal_agent_channels;
create policy internal_agent_channels_select on public.internal_agent_channels
  for select using (public.has_internal_agent_access(agent_id, auth.uid()));

drop policy if exists internal_agent_channels_write on public.internal_agent_channels;
create policy internal_agent_channels_write on public.internal_agent_channels
  for all using (public.has_internal_agent_access(agent_id, auth.uid()))
  with check (public.has_internal_agent_access(agent_id, auth.uid()));

-- ── Bot tokens (SERVICE-ROLE ONLY) ────────────────────────────────────────────
-- RLS enabled with NO policies → authenticated users can read nothing; only the
-- service role (which bypasses RLS) inside edge functions reads/writes the token.
create table if not exists public.internal_agent_channel_tokens (
  channel_id uuid primary key references public.internal_agent_channels(id) on delete cascade,
  access_token text not null,
  scope text,
  created_at timestamptz not null default now()
);
alter table public.internal_agent_channel_tokens enable row level security;

-- ── Conversation → reply-target binding ───────────────────────────────────────
-- When channel_id is set the run finalizer posts the reply back to the external
-- Slack thread. When inbox_channel_id is set it mirrors the reply into the
-- in-app project channel (repairs the async-chat regression in project-inbox-post).
alter table public.internal_agent_conversations
  add column if not exists channel_id uuid references public.internal_agent_channels(id) on delete set null,
  add column if not exists external_channel_ref text,
  add column if not exists external_thread_ref text,
  add column if not exists inbox_channel_id uuid references public.project_channels(id) on delete set null;

-- ── Inbound event dedup (Slack redelivers an event up to 3×) ───────────────────
create table if not exists public.internal_agent_channel_events (
  event_id text primary key,
  created_at timestamptz not null default now()
);
alter table public.internal_agent_channel_events enable row level security;
