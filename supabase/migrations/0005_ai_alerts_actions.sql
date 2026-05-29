-- FounderOS — Sprint 7: AI conversations + alerts + admin_actions

-- ai_conversations ----------------------------------------------------------
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.ai_conversations enable row level security;

create policy "Workspace members read ai_conversations"
on public.ai_conversations for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = ai_conversations.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace members create ai_conversations"
on public.ai_conversations for insert
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = ai_conversations.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace members update own ai_conversations"
on public.ai_conversations for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "Workspace members delete own ai_conversations"
on public.ai_conversations for delete
using (user_id = auth.uid());

-- ai_messages ----------------------------------------------------------------
create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('system','user','assistant')),
  content text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.ai_messages enable row level security;

create policy "Members read ai_messages of accessible conversation"
on public.ai_messages for select
using (
  exists (
    select 1 from public.ai_conversations c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id
    where c.id = ai_messages.conversation_id and wm.user_id = auth.uid()
  )
);

-- alerts ---------------------------------------------------------------------
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  type text not null,
  severity text not null check (severity in ('info','warning','high','critical')),
  title text not null,
  message text,
  status text default 'open' check (status in ('open','acknowledged','resolved')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

alter table public.alerts enable row level security;

create policy "Workspace members read alerts"
on public.alerts for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = alerts.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace admins mutate alerts"
on public.alerts for all
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = alerts.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
)
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = alerts.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- admin_actions --------------------------------------------------------------
create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  connector_id uuid references public.connectors(id) on delete set null,
  action_type text not null,
  target_type text,
  target_id text,
  payload jsonb default '{}'::jsonb,
  status text default 'pending' check (status in ('pending','approved','executing','succeeded','failed','rejected')),
  risk_level text default 'low' check (risk_level in ('low','medium','high','critical')),
  requires_approval boolean default false,
  approved_by uuid references auth.users(id),
  executed_at timestamptz,
  error_message text,
  created_at timestamptz default now()
);

alter table public.admin_actions enable row level security;

create policy "Workspace members read admin_actions"
on public.admin_actions for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = admin_actions.workspace_id and wm.user_id = auth.uid()
  )
);

-- Indexes
create index if not exists idx_ai_messages_convo on public.ai_messages(conversation_id, created_at);
create index if not exists idx_ai_conversations_user on public.ai_conversations(user_id, updated_at desc);
create index if not exists idx_alerts_project on public.alerts(project_id, status, created_at desc);
create index if not exists idx_admin_actions_project on public.admin_actions(project_id, created_at desc);
