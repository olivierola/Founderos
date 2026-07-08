-- 0093_run_triggered_via_chat.sql
-- Chat runs are created with triggered_via='chat' so their tool calls/plan/steps
-- are logged to internal_agent_run_events and shown in the LIVE timeline. But the
-- triggered_via CHECK only allowed ('manual','schedule','api') → every chat run
-- insert was silently rejected → no run row → no events → the live view was stuck
-- on "Agent completed · 0 steps". Allow 'chat'.

alter table public.internal_agent_runs
  drop constraint if exists internal_agent_runs_triggered_via_check;
alter table public.internal_agent_runs
  add constraint internal_agent_runs_triggered_via_check
  check (triggered_via in ('manual','schedule','api','chat'));
