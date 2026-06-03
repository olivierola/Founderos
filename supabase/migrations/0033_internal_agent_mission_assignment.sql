-- Internal agent missions: richer assignment + scheduling metadata, and a
-- structured "instruction blocks" column on the agent so the instructions
-- editor can store sections (role, tone, steps, constraints, output format)
-- in addition to the free-form `instructions` text.
--
-- All additions are nullable / defaulted so existing rows keep working and the
-- v1 worker (which only reads `instructions` and the mission brief) is
-- unaffected.

-- ---- Missions: assignment + scheduling -------------------------------------

alter table public.internal_agent_missions
  add column if not exists priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  add column if not exists due_date timestamptz,
  -- Member responsible for the mission outcome (a human owner, distinct from
  -- the agent that executes it). Nullable — missions can be unassigned.
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  -- Free-form labels for grouping ("marketing", "research", "weekly").
  add column if not exists tags text[] not null default '{}'::text[],
  -- When set, the worker should re-run the mission on this cron-ish cadence.
  -- One of: null (manual), 'daily', 'weekly', 'monthly'.
  add column if not exists schedule text
    check (schedule is null or schedule in ('daily','weekly','monthly')),
  add column if not exists updated_by uuid references auth.users(id);

create index if not exists idx_internal_agent_missions_assigned
  on public.internal_agent_missions(assigned_to) where assigned_to is not null;
create index if not exists idx_internal_agent_missions_status_priority
  on public.internal_agent_missions(agent_id, status, priority);

-- ---- Agent: structured instruction blocks ----------------------------------
-- Stored as an ordered JSON array of { id, kind, title, body }. The worker can
-- keep reading `instructions` (we mirror a rendered version there on save), so
-- this is purely an editor-side enrichment.

alter table public.internal_agents
  add column if not exists instruction_blocks jsonb not null default '[]'::jsonb;

-- ---- Deliverables: pin / star for the deliverables hub ---------------------
-- Lets a member mark a deliverable as a keeper so it floats to the top of the
-- agent-wide deliverables view.

alter table public.internal_agent_deliverables
  add column if not exists is_pinned boolean not null default false,
  add column if not exists summary text;

create index if not exists idx_internal_agent_deliverables_agent
  on public.internal_agent_deliverables(agent_id, created_at desc);
