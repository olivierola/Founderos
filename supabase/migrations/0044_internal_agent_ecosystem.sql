-- Internal agents: collaboration ecosystem.
--
-- Turns isolated autonomous agents into a collaborating team. Adds:
--   1. Agent-to-agent (A2A) messaging — threaded conversations between two
--      agents in the same project. A pinged agent reacts autonomously.
--   2. Mission delegation — an agent hands a mission to another agent and can
--      read the result. Reuses internal_agent_missions (a delegated mission is
--      owned by the assignee agent; provenance is tracked).
--   3. Team memory — a shared, project-level knowledge pool every agent in the
--      project can read and contribute to (distinct from per-agent memory).
--   4. A short role/skills profile on each agent, so peers can discover who to
--      collaborate with.

-- ---- Agent collaboration profile -------------------------------------------

alter table public.internal_agents
  -- One-line role used in the team directory ("Research analyst", "Copywriter"…).
  add column if not exists role text,
  -- Free-form skill tags for discovery ({"research","seo","finance"}).
  add column if not exists skills text[] not null default '{}'::text[],
  -- When true, peers may message and delegate to this agent.
  add column if not exists collaboration_enabled boolean not null default true;

-- ---- A2A threads + messages ------------------------------------------------

create table if not exists public.internal_agent_a2a_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  -- The two collaborating agents (ordered low/high uuid to dedupe a pair).
  agent_a uuid not null references public.internal_agents(id) on delete cascade,
  agent_b uuid not null references public.internal_agents(id) on delete cascade,
  topic text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_a, agent_b)
);

create table if not exists public.internal_agent_a2a_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.internal_agent_a2a_threads(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  -- Sender / recipient agents.
  from_agent uuid not null references public.internal_agents(id) on delete cascade,
  to_agent uuid not null references public.internal_agents(id) on delete cascade,
  content text not null,
  -- Lifecycle for the recipient's autonomous reaction:
  --   pending   — recipient hasn't processed it yet
  --   processing— recipient's worker is reacting
  --   answered  — recipient produced a reply (linked via reply_to on the reply)
  --   ignored   — recipient chose not to reply
  status text not null default 'pending'
    check (status in ('pending','processing','answered','ignored')),
  -- When this message is itself a reply, point at the message it answers.
  reply_to uuid references public.internal_agent_a2a_messages(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---- Mission delegation provenance -----------------------------------------

alter table public.internal_agent_missions
  -- The agent that delegated this mission to the owning agent (null for missions
  -- a human created directly).
  add column if not exists delegated_by_agent uuid
    references public.internal_agents(id) on delete set null,
  -- When set, the delegating agent wants the final report mirrored back.
  add column if not exists report_back_to_agent uuid
    references public.internal_agents(id) on delete set null;

-- ---- Team memory (project-level shared knowledge) --------------------------

create table if not exists public.internal_agent_team_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null default 'fact'
    check (kind in ('fact','preference','learning','context','decision')),
  content text not null,
  -- Which agent (or human) contributed it.
  author_agent uuid references public.internal_agents(id) on delete set null,
  source text not null default 'agent' check (source in ('agent','user')),
  importance int not null default 3 check (importance between 1 and 5),
  is_pinned boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---- RLS -------------------------------------------------------------------
-- Project members (anyone who can see the project's workspace) may read these.
-- Writes happen through the service-role worker, so only SELECT policies are
-- exposed to clients (team memory also allows member inserts for the UI).

alter table public.internal_agent_a2a_threads enable row level security;
alter table public.internal_agent_a2a_messages enable row level security;
alter table public.internal_agent_team_memories enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'internal_agent_a2a_threads','internal_agent_a2a_messages','internal_agent_team_memories'
  ]
  loop
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s"
      on public.%1$s for select
      using (exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
      ));
    $f$, t);
  end loop;
end $$;

-- Team memory: members can add/curate from the UI.
drop policy if exists "Members write team memory" on public.internal_agent_team_memories;
create policy "Members write team memory"
on public.internal_agent_team_memories for insert
with check (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = internal_agent_team_memories.workspace_id and wm.user_id = auth.uid()
));
drop policy if exists "Members update team memory" on public.internal_agent_team_memories;
create policy "Members update team memory"
on public.internal_agent_team_memories for update
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = internal_agent_team_memories.workspace_id and wm.user_id = auth.uid()
));
drop policy if exists "Members delete team memory" on public.internal_agent_team_memories;
create policy "Members delete team memory"
on public.internal_agent_team_memories for delete
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = internal_agent_team_memories.workspace_id and wm.user_id = auth.uid()
));

-- ---- Indexes ---------------------------------------------------------------

create index if not exists idx_a2a_threads_project on public.internal_agent_a2a_threads(project_id, updated_at desc);
create index if not exists idx_a2a_messages_thread on public.internal_agent_a2a_messages(thread_id, created_at);
create index if not exists idx_a2a_messages_to_pending
  on public.internal_agent_a2a_messages(to_agent, status) where status = 'pending';
create index if not exists idx_team_memories_project
  on public.internal_agent_team_memories(project_id, is_pinned desc, importance desc, updated_at desc);
create index if not exists idx_missions_delegated_by
  on public.internal_agent_missions(delegated_by_agent) where delegated_by_agent is not null;
