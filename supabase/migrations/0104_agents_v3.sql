-- 0104_agents_v3.sql
-- Agents v3 rebuild (post fork-bomb autopsy):
--   1. app_config — DB-backed runtime config (sandbox/runner URLs) read FRESH on
--      every run, because edge workers cache env secrets until recycled (the
--      root cause of "Sandbox unreachable" while the secret was correct).
--   2. internal_agent_runs.todos — the run's plan as a STRUCTURED todo list
--      (TodoWrite-style), source of truth for the UI checklist.
--   3. internal_agent_messages.run_id — link each assistant chat message to the
--      run that produced it, so its timeline card persists in the chat history.
--   4. New event kind 'todos' (full todo-list snapshots).
--   5. Realtime publication on runs + run events for the live RunTimeline.

-- ── 1. Runtime config (service-role only: RLS on, no policies) ────────────────
create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

-- ── 2. Structured todos on runs ───────────────────────────────────────────────
alter table public.internal_agent_runs
  add column if not exists todos jsonb not null default '[]'::jsonb;

-- ── 3. Chat message ↔ run linkage ─────────────────────────────────────────────
alter table public.internal_agent_messages
  add column if not exists run_id uuid references public.internal_agent_runs(id) on delete set null;
create index if not exists idx_internal_agent_messages_run on public.internal_agent_messages(run_id);

-- ── 4. Event kind 'todos' ─────────────────────────────────────────────────────
alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;
alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in (
    'llm_call','tool_call','tool_result','status','log','error',
    'plan','plan_step','tool_error','question','todos'
  ));

-- ── 5. Realtime for the live timeline ─────────────────────────────────────────
do $$
begin
  begin
    alter publication supabase_realtime add table public.internal_agent_run_events;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.internal_agent_runs;
  exception when duplicate_object then null;
  end;
end $$;
