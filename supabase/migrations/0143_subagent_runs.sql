-- 0143_subagent_runs.sql
-- Parallel ephemeral sub-agent instances.
--
-- When a mission has independent subtasks, the primary run spawns short-lived
-- CHILD runs (clones of the same agent) that execute those subtasks in parallel.
-- Children stream their own events (internal_agent_run_events, keyed by run_id)
-- so their live flow can be watched individually; once finished they are marked
-- ephemeral but their row + events remain as the trace. No new table or RLS is
-- needed — children are ordinary internal_agent_runs, scoped by the same
-- workspace/project policies already on the table.

alter table public.internal_agent_runs
  add column if not exists parent_run_id uuid references public.internal_agent_runs(id) on delete cascade,
  add column if not exists run_kind text not null default 'primary' check (run_kind in ('primary', 'subagent')),
  add column if not exists label text,
  add column if not exists is_ephemeral boolean not null default false;

-- Fetch a parent's children (the instance cards) in creation order.
create index if not exists idx_internal_agent_runs_parent
  on public.internal_agent_runs(parent_run_id, created_at);
