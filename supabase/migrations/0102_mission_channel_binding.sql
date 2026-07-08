-- 0102_mission_channel_binding.sql
-- A mission can be created from an external channel (e.g. a Slack thread with
-- "mission: …"). Store where to report back so the run finalizer posts the
-- completion report into that thread. Mirrors the conversation binding (0100).
alter table public.internal_agent_missions
  add column if not exists channel_id uuid references public.internal_agent_channels(id) on delete set null,
  add column if not exists external_channel_ref text,
  add column if not exists external_thread_ref text;
