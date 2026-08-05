-- 0135_service_rooms.sql
-- Multi-agent rooms inside a service dashboard: a shared thread where the human
-- and one or more agent participants talk. @mention an agent (or several) to
-- have them reply; unmentioned turns go to the room's default responder (its
-- orchestrator or first agent). Keeps each team's conversations in their own
-- dashboard — no cross-team clutter.

create table if not exists public.service_rooms (
  id           uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.service_dashboards(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  title        text not null default 'Nouvelle room',
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_service_rooms_dashboard on public.service_rooms(dashboard_id, updated_at desc);

create table if not exists public.service_room_agents (
  room_id   uuid not null references public.service_rooms(id) on delete cascade,
  agent_id  uuid not null references public.internal_agents(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (room_id, agent_id)
);

create table if not exists public.service_room_messages (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.service_rooms(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  author_kind  text not null check (author_kind in ('user','agent','system')),
  user_id      uuid references auth.users(id),
  agent_id     uuid references public.internal_agents(id) on delete set null,
  content      text not null default '',
  ui_blocks    jsonb,
  status       text not null default 'done' check (status in ('thinking','done','failed')),
  created_at   timestamptz not null default now()
);
create index if not exists idx_service_room_messages_room on public.service_room_messages(room_id, created_at);

alter table public.service_rooms enable row level security;
alter table public.service_room_agents enable row level security;
alter table public.service_room_messages enable row level security;

create policy "members manage service_rooms" on public.service_rooms for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_rooms.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_rooms.workspace_id and wm.user_id = auth.uid()));

create policy "members read/manage room agents" on public.service_room_agents for all
  using  (exists (select 1 from public.service_rooms r join public.workspace_members wm on wm.workspace_id = r.workspace_id where r.id = service_room_agents.room_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.service_rooms r join public.workspace_members wm on wm.workspace_id = r.workspace_id where r.id = service_room_agents.room_id and wm.user_id = auth.uid()));

create policy "members read/write room messages" on public.service_room_messages for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_room_messages.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_room_messages.workspace_id and wm.user_id = auth.uid()));
