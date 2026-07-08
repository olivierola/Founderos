-- 0101_run_midflight_input.sql
-- Steer a running agent: a message sent while a chat run is in flight is picked
-- up by the next tick (instead of starting a competing run). We track the
-- created_at of the last conversation message already folded into the run so the
-- tick only pulls in genuinely new user turns.
alter table public.internal_agent_run_state
  add column if not exists last_input_at timestamptz;
