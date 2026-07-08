-- 0097_zombie_reconcile_cron.sql
-- Automatic zombie-run reconciler (#8) — a pg_cron job (every minute) that fails
-- any run stuck in running/queued with NO recent activity, and clears its tick
-- state. Independent of traffic, so a stuck run can't linger (which would also
-- keep the chat composer locked via the "active run" check).
--
-- A long MISSION legitimately stays 'running' for many minutes while it ticks —
-- so we only fail a run when its tick state hasn't advanced in >12 min (or it
-- has no tick state, e.g. a dead chat worker, and is itself >12 min old).

create or replace function public.reconcile_zombie_runs()
  returns int language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  with z as (
    update public.internal_agent_runs r
       set status = 'failed', finished_at = now(),
           error_message = 'Reconciled zombie (worker timed out)'
     where r.status in ('running','queued')
       and coalesce(r.started_at, r.created_at) < now() - interval '12 minutes'
       and not exists (
         select 1 from public.internal_agent_run_state s
          where s.run_id = r.id and s.updated_at > now() - interval '12 minutes'
       )
    returning r.id
  )
  delete from public.internal_agent_run_state s using z where s.run_id = z.id;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.reconcile_zombie_runs() from public;

do $$ begin perform cron.unschedule('reconcile-zombie-runs'); exception when others then null; end $$;
select cron.schedule('reconcile-zombie-runs', '* * * * *', $$ select public.reconcile_zombie_runs(); $$);
