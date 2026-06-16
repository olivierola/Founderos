-- Project Inbox — team + agent chatrooms inside the Projets module.
-- Channels (public or private), per-channel membership for private ones, and
-- realtime messages from humans and internal agents.

-- ============================ Tables =====================================
create table if not exists public.project_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  is_private boolean not null default false,
  -- The default #general channel cannot be deleted.
  is_default boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_project_channels_project on public.project_channels(project_id);

-- Membership rows (used to gate private channels). Public channels don't need
-- rows — every project member can see them.
create table if not exists public.project_channel_members (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.project_channels(id) on delete cascade,
  -- Exactly one of user_id / agent_id is set.
  user_id uuid references auth.users(id) on delete cascade,
  agent_id uuid references public.internal_agents(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (channel_id, user_id),
  unique (channel_id, agent_id)
);
create index if not exists idx_pcm_channel on public.project_channel_members(channel_id);

create table if not exists public.project_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  channel_id uuid not null references public.project_channels(id) on delete cascade,
  -- Author: a human (user_id) OR an internal agent (agent_id). 'system' rows
  -- have neither and carry a system notice (e.g. "agent is thinking…").
  author_kind text not null default 'user' check (author_kind in ('user','agent','system')),
  user_id uuid references auth.users(id) on delete set null,
  agent_id uuid references public.internal_agents(id) on delete set null,
  body text not null,
  -- Agent ids @mentioned in the message — used to dispatch agent replies.
  mentions uuid[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_project_messages_channel on public.project_messages(channel_id, created_at);

-- ============================ Helper: channel visibility ==================
-- A channel is visible to the current user if it's public (and they're a
-- workspace member) or private and they're a channel member.
create or replace function public.can_access_channel(_channel_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_channels c
    join public.workspace_members wm
      on wm.workspace_id = c.workspace_id and wm.user_id = auth.uid()
    where c.id = _channel_id
      and (
        c.is_private = false
        or exists (
          select 1 from public.project_channel_members m
          where m.channel_id = c.id and m.user_id = auth.uid()
        )
      )
  );
$$;

-- ============================ RLS ========================================
alter table public.project_channels enable row level security;
alter table public.project_channel_members enable row level security;
alter table public.project_messages enable row level security;

-- Channels: members of the workspace see public channels + private ones they
-- belong to. Insert/update/delete require workspace membership.
drop policy if exists "read channels" on public.project_channels;
create policy "read channels" on public.project_channels for select
  using (
    exists (select 1 from public.workspace_members wm
      where wm.workspace_id = project_channels.workspace_id and wm.user_id = auth.uid())
    and (
      is_private = false
      or exists (select 1 from public.project_channel_members m
        where m.channel_id = project_channels.id and m.user_id = auth.uid())
      or created_by = auth.uid()
    )
  );
drop policy if exists "write channels" on public.project_channels;
create policy "write channels" on public.project_channels for insert
  with check (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = project_channels.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "update channels" on public.project_channels;
create policy "update channels" on public.project_channels for update
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = project_channels.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "delete channels" on public.project_channels;
create policy "delete channels" on public.project_channels for delete
  using (is_default = false and exists (select 1 from public.workspace_members wm
    where wm.workspace_id = project_channels.workspace_id and wm.user_id = auth.uid()));

-- Channel members: visible to anyone who can access the channel; writable by
-- workspace members.
drop policy if exists "read channel members" on public.project_channel_members;
create policy "read channel members" on public.project_channel_members for select
  using (public.can_access_channel(channel_id));
drop policy if exists "write channel members" on public.project_channel_members;
create policy "write channel members" on public.project_channel_members for insert
  with check (exists (select 1 from public.project_channels c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id and wm.user_id = auth.uid()
    where c.id = channel_id));
drop policy if exists "delete channel members" on public.project_channel_members;
create policy "delete channel members" on public.project_channel_members for delete
  using (exists (select 1 from public.project_channels c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id and wm.user_id = auth.uid()
    where c.id = channel_id));

-- Messages: read if you can access the channel; insert your own messages into
-- channels you can access (agents post via service role, bypassing RLS).
drop policy if exists "read messages" on public.project_messages;
create policy "read messages" on public.project_messages for select
  using (public.can_access_channel(channel_id));
drop policy if exists "write messages" on public.project_messages;
create policy "write messages" on public.project_messages for insert
  with check (
    author_kind = 'user'
    and user_id = auth.uid()
    and public.can_access_channel(channel_id)
  );

-- ============================ Realtime ===================================
-- Stream new messages to connected clients.
alter publication supabase_realtime add table public.project_messages;
