-- 0197_workflow_scheduler.sql
-- Makes workflows (0196) fire on their own.
--
-- One job, not two: start the runs whose schedule is due. There is no second
-- pass for parked steps, because a workflow does not park — the assistant that
-- received the playbook owns it from start to finish, and the agent tick engine
-- already keeps that run alive across the edge wall-clock.
--
-- Same pg_net + Vault pattern as the agent drainer (0095) and scheduler (0126).

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.tick_workflow_scheduler()
  returns int language plpgsql security definer set search_path = public, net, vault as
$$
declare
  svc text;
  r record;
  n int := 0;
begin
  select decrypted_secret into svc from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  if svc is null then return 0; end if;

  for r in
    select id from public.agent_workflows
    where status = 'active' and next_run_at is not null and next_run_at <= now()
    limit 20
  loop
    -- Clear the due date BEFORE firing: a slow edge call must not let the next
    -- minute launch the same workflow again. run-workflow re-arms it.
    update public.agent_workflows set next_run_at = null where id = r.id;
    perform net.http_post(
      url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/run-workflow',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||svc),
      body    := jsonb_build_object('workflow_id', r.id, 'trigger_payload', jsonb_build_object('trigger','schedule'))
    );
    n := n + 1;
  end loop;

  return n;
end $$;

revoke all on function public.tick_workflow_scheduler() from public;
grant execute on function public.tick_workflow_scheduler() to service_role;

do $$ begin perform cron.unschedule('tick-workflow-scheduler'); exception when others then null; end $$;
select cron.schedule('tick-workflow-scheduler', '* * * * *', $$ select public.tick_workflow_scheduler(); $$);
