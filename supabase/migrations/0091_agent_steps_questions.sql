-- 0091_agent_steps_questions.sql
-- Live plan-execute upgrade for autonomous agents:
--   * plan_step  — a planned step's lifecycle update (active / done / blocked)
--   * tool_error — a malformed/incomplete tool call that stalled the agent
--   * question   — the agent paused to ask the human for clarification
-- Plus a new run status `awaiting_input` (agent is blocked waiting on a human)
-- and a column to carry the pending question for mission-mode runs.

alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;
alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in (
    'llm_call','tool_call','tool_result','status','log','error',
    'plan','plan_step','tool_error','question'
  ));

alter table public.internal_agent_runs
  drop constraint if exists internal_agent_runs_status_check;
alter table public.internal_agent_runs
  add constraint internal_agent_runs_status_check
  check (status in ('queued','running','succeeded','failed','cancelled','awaiting_input'));

alter table public.internal_agent_runs
  add column if not exists pending_question jsonb;
