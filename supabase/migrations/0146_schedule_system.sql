-- 0146_schedule_system.sql
-- Full scheduling system for autonomous agent missions.
--
-- Before: `schedule` was one of null/'daily'/'weekly'/'monthly' and the
-- scheduler fired at "now + interval" (drifting, no chosen time-of-day).
-- Now: add an 'hourly' cadence and time-alignment columns so a schedule runs
-- at a chosen minute/hour/day-of-week/day-of-month (all UTC). The scheduler
-- (internal-agent-scheduler) computes next_run_at aligned to these.

-- 1. Widen the cadence check to include 'hourly'.
alter table public.internal_agent_missions
  drop constraint if exists internal_agent_missions_schedule_check;
alter table public.internal_agent_missions
  add constraint internal_agent_missions_schedule_check
  check (schedule is null or schedule in ('hourly','daily','weekly','monthly'));

-- 2. Alignment columns (all UTC). Nullable — when null the scheduler falls back
--    to the legacy "now + interval" behaviour so existing rows keep working.
alter table public.internal_agent_missions
  add column if not exists schedule_minute int
    check (schedule_minute is null or (schedule_minute >= 0 and schedule_minute <= 59)),
  add column if not exists schedule_hour int
    check (schedule_hour is null or (schedule_hour >= 0 and schedule_hour <= 23)),
  add column if not exists schedule_dow int
    check (schedule_dow is null or (schedule_dow >= 0 and schedule_dow <= 6)),   -- 0 = Sunday
  add column if not exists schedule_dom int
    check (schedule_dom is null or (schedule_dom >= 1 and schedule_dom <= 28));  -- capped so every month has the day
