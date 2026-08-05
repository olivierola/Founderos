-- Room agent turns run inline (service-room-post, EdgeRuntime.waitUntil). If the
-- background task is killed by the edge wall-clock mid-turn, its "thinking"
-- placeholder is never updated → the UI shows "réfléchit…" forever. A hard kill
-- can't run the function's own catch, so we reconcile from the DB: any agent
-- placeholder still 'thinking' after 8 minutes is flipped to a graceful message.

create or replace function public.reconcile_stuck_room_messages()
  returns int language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  update public.service_room_messages
  set status = 'failed',
      content = '⏸️ Réponse interrompue (tâche trop longue pour une room). Pour un travail autonome lourd (analyse complète, sourcing, rapport), lance-moi en chat direct ou en mission.'
  where status = 'thinking'
    and created_at < now() - interval '8 minutes';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.reconcile_stuck_room_messages() from public;

do $$ begin perform cron.unschedule('reconcile-stuck-room-messages'); exception when others then null; end $$;
select cron.schedule('reconcile-stuck-room-messages', '* * * * *', $$ select public.reconcile_stuck_room_messages(); $$);
