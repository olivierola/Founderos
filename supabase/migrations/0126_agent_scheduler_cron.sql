-- 0126_agent_scheduler_cron.sql
-- Branche enfin le scheduler des agents sur pg_cron. La fonction Edge
-- internal-agent-scheduler existait depuis 0037 mais rien ne l'invoquait :
-- les missions planifiées (et les Automations de 0109) ne partaient jamais
-- seules. Un tick par minute :
--   1. lance les missions dues (status active, next_run_at <= now),
--   2. rescue les runs 'queued' > 5 min (fire-and-forget UI raté),
--   3. time-out les runs 'running' > 30 min.
-- Même mécanique que le drainer de 0095 : pg_net POST vers la fonction Edge,
-- service-role key lue dans Vault ('agent_service_key').

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.tick_agent_scheduler()
  returns void language plpgsql security definer set search_path = public, net, vault as
$$
declare svc text;
begin
  select decrypted_secret into svc from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  if svc is null then return; end if;
  perform net.http_post(
    url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/internal-agent-scheduler',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||svc),
    body    := '{}'::jsonb
  );
end $$;

revoke all on function public.tick_agent_scheduler() from public;

do $$ begin perform cron.unschedule('tick-agent-scheduler'); exception when others then null; end $$;
select cron.schedule('tick-agent-scheduler', '* * * * *', $$ select public.tick_agent_scheduler(); $$);
