-- Internal agents: persistent memory.
--
-- Agents accumulate durable knowledge across chat sessions and mission runs:
-- the worker injects the most relevant memories into every system prompt, and
-- the agent itself writes new ones through the save_memory tool. Team members
-- curate the store (add / pin / delete) from the Memory tab.
--
-- Chat "sessions" need no schema change — internal_agent_conversations already
-- persists them; the UI gains a session list and the worker now bumps
-- updated_at on each reply so sessions sort by recency.

create table if not exists public.internal_agent_memories (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.internal_agents(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  -- What kind of knowledge this is:
  --   fact       — stable truth about the product/team/users
  --   preference — how the team wants the agent to behave/format output
  --   learning   — lesson learned from a past run (what worked / failed)
  --   context    — background info useful across missions
  kind text not null default 'fact'
    check (kind in ('fact','preference','learning','context')),
  content text not null,
  -- Who wrote it: the agent itself (via tool) or a human (via UI).
  source text not null default 'agent' check (source in ('agent','user')),
  source_run_id uuid references public.internal_agent_runs(id) on delete set null,
  source_conversation_id uuid references public.internal_agent_conversations(id) on delete set null,
  -- 1 (minor) … 5 (critical). Drives prompt-injection priority.
  importance int not null default 3 check (importance between 1 and 5),
  -- Pinned memories are always injected, regardless of importance.
  is_pinned boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.internal_agent_memories enable row level security;

-- Same pattern as the other internal-agent child tables: full access for
-- anyone with agent access (the worker uses the service role anyway).
drop policy if exists "Read internal_agent_memories via agent access" on public.internal_agent_memories;
create policy "Read internal_agent_memories via agent access"
on public.internal_agent_memories for select
using (public.has_internal_agent_access(internal_agent_memories.agent_id, auth.uid()));

drop policy if exists "Insert internal_agent_memories via agent access" on public.internal_agent_memories;
create policy "Insert internal_agent_memories via agent access"
on public.internal_agent_memories for insert
with check (public.has_internal_agent_access(internal_agent_memories.agent_id, auth.uid()));

drop policy if exists "Update internal_agent_memories via agent access" on public.internal_agent_memories;
create policy "Update internal_agent_memories via agent access"
on public.internal_agent_memories for update
using (public.has_internal_agent_access(internal_agent_memories.agent_id, auth.uid()))
with check (public.has_internal_agent_access(internal_agent_memories.agent_id, auth.uid()));

drop policy if exists "Delete internal_agent_memories via agent access" on public.internal_agent_memories;
create policy "Delete internal_agent_memories via agent access"
on public.internal_agent_memories for delete
using (public.has_internal_agent_access(internal_agent_memories.agent_id, auth.uid()));

create index if not exists idx_internal_agent_memories_agent
  on public.internal_agent_memories(agent_id, is_pinned desc, importance desc, updated_at desc);
