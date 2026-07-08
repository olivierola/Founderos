-- 0098_run_state_adaptive.sql
-- Adaptive mission control: missions now run with NO round budget (they stop only
-- when the task is verified done), but if the agent loops or accumulates errors it
-- triggers a re-plan, and on "finished" it self-verifies the result. These
-- counters live on the tick state so they persist across ticks.

alter table public.internal_agent_run_state
  add column if not exists error_count  int not null default 0,  -- errors since the last (re)plan
  add column if not exists replans       int not null default 0,  -- how many re-plans so far
  add column if not exists verify_fails  int not null default 0;  -- failed self-verifications
