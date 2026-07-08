-- 0090_run_event_plan_kind.sql
-- Agents now run an upfront reasoning & planning pass before acting. The plan
-- is recorded as a run event of kind 'plan' (rendered in the live timeline), so
-- extend the internal_agent_run_events.kind CHECK constraint to allow it.

alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;

alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in ('llm_call','tool_call','tool_result','status','log','error','plan'));
