-- 0185_room_mission_watchdog.sql
-- A room mission could stall for ever.
--
-- What happened: an agent's room turn runs on the durable tick engine. If the
-- edge worker is killed mid-turn, nothing in TypeScript observes it — the SQL
-- reconciler (0097) flips the RUN to 'failed' from the database, and that is the
-- end of it. The mission's task stays 'in_progress', the orchestrator's frontier
-- reads "one task in flight" on every pass and waits, and the mission sits at
-- "en cours" with nothing running. The only visible trace was the placeholder
-- message flipped to "⏸️ Réponse interrompue" by 0157.
--
-- Two fixes here (the third is in the tick engine, which no longer drops a
-- redelivered tick whose lease is held, and now reports the task when it finds
-- its run already dead):
--   1. The placeholder reconciler stops lying: it only gives up on a "thinking"
--      message once the run behind it is actually over (or absent), instead of
--      at a flat 8 minutes — a long mission task legitimately thinks longer.
--   2. A watchdog re-enters the orchestrator on missions whose frontier has
--      nothing alive left, through the same pg_net + vault path the tick drainer
--      uses. advanceRoomMission then closes the dead tasks, replans around them,
--      or finishes the mission.

-- ── 1. Placeholder reconciler, run-aware ─────────────────────────────────────
create or replace function public.reconcile_stuck_room_messages()
  returns int language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  update public.service_room_messages m
     set status = 'failed',
         content = '⏸️ Réponse interrompue (le worker a été coupé en cours de tâche). La mission reprend la main : la tâche est marquée en échec et l''orchestrateur replanifie.'
   where m.status = 'thinking'
     and m.created_at < now() - interval '10 minutes'
     -- Only when the run behind it is really over. A tick engine still working
     -- gets to finish: it writes the reply into this same placeholder.
     and (
       m.run_id is null
       or not exists (
         select 1 from public.internal_agent_runs r
          where r.id = m.run_id and r.status in ('running', 'queued')
       )
     );
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.reconcile_stuck_room_messages() from public;

-- ── 2. Stalled-mission watchdog ──────────────────────────────────────────────
-- "Stalled" is deliberately narrow: a mission with open work, untouched for a
-- while, and with NO task whose run is still alive. A mission genuinely waiting
-- on a long task never matches, so this cannot spam the orchestrator.
create or replace function public.reconcile_stalled_room_missions()
  returns int language plpgsql security definer
  set search_path = public, net, vault as
$$
declare r record; n int := 0; svc text;
begin
  select decrypted_secret into svc from vault.decrypted_secrets
   where name = 'agent_service_key' limit 1;
  if svc is null then return 0; end if;

  for r in
    select m.id
      from public.service_room_missions m
     where m.status in ('planning', 'running')
       and m.updated_at < now() - interval '10 minutes'
       -- Something still to do…
       and exists (
         select 1 from public.service_room_tasks t
          where t.mission_id = m.id
            and t.status in ('todo', 'in_progress', 'waiting', 'review')
       )
       -- …and nothing actually alive doing it.
       and not exists (
         select 1
           from public.service_room_tasks t
           join public.internal_agent_runs run on run.id = t.run_id
          where t.mission_id = m.id
            and t.status in ('in_progress', 'waiting', 'review')
            and run.status in ('running', 'queued')
       )
     limit 20
  loop
    perform net.http_post(
      url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/internal-agent-run',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || svc),
      body    := jsonb_build_object('mode', 'room_advance', 'mission_id', r.id)
    );
    -- Claim it so the next pass (a minute later) doesn't re-post before the
    -- orchestrator has had time to answer.
    update public.service_room_missions set updated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.reconcile_stalled_room_missions() from public;

do $$ begin perform cron.unschedule('reconcile-stalled-room-missions'); exception when others then null; end $$;
select cron.schedule('reconcile-stalled-room-missions', '*/2 * * * *',
                     $$ select public.reconcile_stalled_room_missions(); $$);
