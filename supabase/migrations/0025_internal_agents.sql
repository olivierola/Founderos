-- Internal agents: agency-internal AI agents created by project members.
-- Unlike rag_agents which are customer-facing widgets, internal agents are
-- collaborators for the team — they can chat and execute structured "missions"
-- producing concrete deliverables.
--
-- Access control: each agent has a per-agent ACL (internal_agent_members).
-- The creator is implicitly an "owner" via internal_agents.created_by; other
-- project members must be added explicitly to see/run the agent.

create table if not exists public.internal_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  description text,
  avatar_emoji text default '🤖',
  accent_color text default '#2F2FE4',
  -- System-level configuration
  persona text,
  instructions text,                            -- detailed behavioral instructions
  model text default 'groq',                    -- groq | deepseek | gpt-4
  temperature numeric default 0.3,
  -- Mode flags: both can be true (agent works in chat AND missions)
  chat_enabled boolean default true,
  mission_enabled boolean default true,
  -- Owner / visibility
  created_by uuid references auth.users(id),
  is_archived boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ACL: explicit members who can access the agent (beyond the creator).
create table if not exists public.internal_agent_members (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.internal_agents(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  -- Role within the agent: viewer (read-only), user (can run), editor (can edit config).
  -- Creator is always "owner" implicitly via created_by — no need to insert here.
  role text default 'user' check (role in ('viewer','user','editor')),
  added_by uuid references auth.users(id),
  added_at timestamptz default now(),
  unique (agent_id, user_id)
);

-- Tools available to a given agent. Each row represents one tool grant.
-- Tools come from a fixed catalogue (kind), and may carry per-agent config
-- (e.g. which vault connector to use, which edge function to call).
create table if not exists public.internal_agent_tools (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.internal_agents(id) on delete cascade,
  kind text not null check (kind in ('web_search','web_fetch','db_read','edge_function','vault_connector','custom')),
  name text not null,                           -- display name
  description text,
  -- Per-tool configuration (varies by kind):
  --   db_read: { tables: ["deals","posts"] }
  --   edge_function: { slug: "marketing-publish", schema: {...} }
  --   vault_connector: { connector_id: "uuid" }
  --   web_search: { provider: "tavily" | "serper" }
  config jsonb default '{}'::jsonb,
  enabled boolean default true,
  created_at timestamptz default now()
);

-- Missions: structured tasks given to an agent. Each mission can be re-run.
create table if not exists public.internal_agent_missions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.internal_agents(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  -- Mission brief: detailed prompt + acceptance criteria + context.
  brief text,
  acceptance_criteria text,                     -- what counts as "done"
  expected_deliverables jsonb default '[]'::jsonb,  -- [{ kind, name, description }]
  status text default 'draft' check (status in ('draft','active','archived')),
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Mission runs: each execution attempt of a mission.
create table if not exists public.internal_agent_runs (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid references public.internal_agent_missions(id) on delete cascade,
  agent_id uuid references public.internal_agents(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  status text default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  -- Worker bookkeeping
  started_at timestamptz,
  finished_at timestamptz,
  -- Cost & action accounting
  tokens_in int default 0,
  tokens_out int default 0,
  cost_usd numeric(10, 6) default 0,
  action_count int default 0,                   -- tool calls performed
  -- Result
  final_output text,
  error_message text,
  triggered_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- Per-run events: tool calls, LLM messages, status transitions. Append-only.
create table if not exists public.internal_agent_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.internal_agent_runs(id) on delete cascade,
  agent_id uuid references public.internal_agents(id) on delete cascade,
  kind text not null check (kind in ('llm_call','tool_call','tool_result','status','log','error')),
  payload jsonb default '{}'::jsonb,
  tokens_in int default 0,
  tokens_out int default 0,
  cost_usd numeric(10, 6) default 0,
  created_at timestamptz default now()
);

-- Deliverables produced by a run. Stored as text (markdown/json) or as a
-- pointer to a file in storage. Multiple deliverables per run are allowed.
create table if not exists public.internal_agent_deliverables (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.internal_agent_runs(id) on delete cascade,
  mission_id uuid references public.internal_agent_missions(id) on delete cascade,
  agent_id uuid references public.internal_agents(id) on delete cascade,
  kind text not null,                           -- "markdown" | "json" | "file" | "url" | "code"
  name text not null,
  content text,                                 -- inline content (md/json/code)
  file_url text,                                -- pointer for binary deliverables
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Chat conversations (mode "chat" — separate from mission runs).
create table if not exists public.internal_agent_conversations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.internal_agents(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.internal_agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.internal_agent_conversations(id) on delete cascade,
  agent_id uuid references public.internal_agents(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  tool_calls jsonb default '[]'::jsonb,         -- when role='assistant' and it called tools
  tokens_in int default 0,
  tokens_out int default 0,
  cost_usd numeric(10, 6) default 0,
  created_at timestamptz default now()
);

-- ---- Access helpers --------------------------------------------------------

-- Returns true if the given user has access to the agent.
-- Creator OR explicit ACL member always passes.
create or replace function public.has_internal_agent_access(p_agent_id uuid, p_user_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.internal_agents a
    where a.id = p_agent_id and a.created_by = p_user_id
  ) or exists (
    select 1 from public.internal_agent_members m
    where m.agent_id = p_agent_id and m.user_id = p_user_id
  );
$$;

-- ---- RLS -------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'internal_agents','internal_agent_members','internal_agent_tools',
    'internal_agent_missions','internal_agent_runs','internal_agent_run_events',
    'internal_agent_deliverables','internal_agent_conversations','internal_agent_messages'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- internal_agents: SELECT — creator OR member; INSERT — any workspace member
-- (the inserter becomes creator); UPDATE/DELETE — creator or editor members.
-- Policies are dropped first so the migration is safe to re-run after a
-- partial apply (the tables may already have been created outside the
-- migration history).
drop policy if exists "Internal agents: read by creator or member" on public.internal_agents;
create policy "Internal agents: read by creator or member"
on public.internal_agents for select
using (
  created_by = auth.uid()
  or exists (select 1 from public.internal_agent_members m
             where m.agent_id = internal_agents.id and m.user_id = auth.uid())
);

drop policy if exists "Internal agents: workspace members can create" on public.internal_agents;
create policy "Internal agents: workspace members can create"
on public.internal_agents for insert
with check (
  created_by = auth.uid()
  and exists (select 1 from public.workspace_members wm
              where wm.workspace_id = internal_agents.workspace_id and wm.user_id = auth.uid())
);

drop policy if exists "Internal agents: creator or editor can update" on public.internal_agents;
create policy "Internal agents: creator or editor can update"
on public.internal_agents for update
using (
  created_by = auth.uid()
  or exists (select 1 from public.internal_agent_members m
             where m.agent_id = internal_agents.id and m.user_id = auth.uid() and m.role = 'editor')
)
with check (
  created_by = auth.uid()
  or exists (select 1 from public.internal_agent_members m
             where m.agent_id = internal_agents.id and m.user_id = auth.uid() and m.role = 'editor')
);

drop policy if exists "Internal agents: creator can delete" on public.internal_agents;
create policy "Internal agents: creator can delete"
on public.internal_agents for delete
using (created_by = auth.uid());

-- All child tables follow the same pattern: access guarded by has_internal_agent_access.
do $$
declare t text;
begin
  foreach t in array array[
    'internal_agent_members','internal_agent_tools',
    'internal_agent_missions','internal_agent_runs','internal_agent_run_events',
    'internal_agent_deliverables','internal_agent_conversations','internal_agent_messages'
  ]
  loop
    -- Drop-then-create each policy so the migration stays idempotent.
    execute format('drop policy if exists "Read %1$s via agent access" on public.%1$s;', t);
    execute format($f$
      create policy "Read %1$s via agent access"
      on public.%1$s for select
      using (public.has_internal_agent_access(%1$s.agent_id, auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Insert %1$s via agent access" on public.%1$s;', t);
    execute format($f$
      create policy "Insert %1$s via agent access"
      on public.%1$s for insert
      with check (public.has_internal_agent_access(%1$s.agent_id, auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Update %1$s via agent access" on public.%1$s;', t);
    execute format($f$
      create policy "Update %1$s via agent access"
      on public.%1$s for update
      using (public.has_internal_agent_access(%1$s.agent_id, auth.uid()))
      with check (public.has_internal_agent_access(%1$s.agent_id, auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Delete %1$s via agent access" on public.%1$s;', t);
    execute format($f$
      create policy "Delete %1$s via agent access"
      on public.%1$s for delete
      using (public.has_internal_agent_access(%1$s.agent_id, auth.uid()));
    $f$, t);
  end loop;
end $$;

-- internal_agent_messages: read access via conversation → agent.
drop policy if exists "Read internal_agent_messages via conversation" on public.internal_agent_messages;
create policy "Read internal_agent_messages via conversation"
on public.internal_agent_messages for select
using (exists (
  select 1 from public.internal_agent_conversations c
  where c.id = internal_agent_messages.conversation_id
    and public.has_internal_agent_access(c.agent_id, auth.uid())
));

-- ---- Indexes ---------------------------------------------------------------

create index if not exists idx_internal_agents_project on public.internal_agents(project_id);
create index if not exists idx_internal_agents_creator on public.internal_agents(created_by);
create index if not exists idx_internal_agent_members_agent on public.internal_agent_members(agent_id);
create index if not exists idx_internal_agent_members_user on public.internal_agent_members(user_id);
create index if not exists idx_internal_agent_tools_agent on public.internal_agent_tools(agent_id);
create index if not exists idx_internal_agent_missions_agent on public.internal_agent_missions(agent_id, created_at desc);
create index if not exists idx_internal_agent_runs_mission on public.internal_agent_runs(mission_id, created_at desc);
create index if not exists idx_internal_agent_runs_status on public.internal_agent_runs(status) where status in ('queued','running');
create index if not exists idx_internal_agent_run_events_run on public.internal_agent_run_events(run_id, created_at);
create index if not exists idx_internal_agent_deliverables_mission on public.internal_agent_deliverables(mission_id);
create index if not exists idx_internal_agent_conversations_agent on public.internal_agent_conversations(agent_id, updated_at desc);
create index if not exists idx_internal_agent_messages_conv on public.internal_agent_messages(conversation_id, created_at);
