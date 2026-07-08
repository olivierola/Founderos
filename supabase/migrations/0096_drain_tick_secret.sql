-- 0096_drain_tick_secret.sql
-- The tick endpoint now authenticates via a dedicated shared secret
-- (x-tick-secret) rather than relying on the service key byte-matching the
-- function env. The drainer reads that secret from Vault ('agent_tick_secret')
-- and forwards it on every dispatched tick. The Authorization bearer (service
-- key) is still sent so the API gateway routes the request.

create or replace function public.drain_agent_ticks()
  returns int language plpgsql security definer set search_path = public, pgmq, net, vault as
$$
declare r record; n int := 0; svc text; tick_secret text;
begin
  select decrypted_secret into svc        from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  select decrypted_secret into tick_secret from vault.decrypted_secrets where name = 'agent_tick_secret' limit 1;
  if svc is null then return 0; end if;
  for r in select * from pgmq.read('agent_run_ticks', 180, 10) loop
    perform net.http_post(
      url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/internal-agent-run',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'Authorization','Bearer '||svc,
        'x-tick-secret', coalesce(tick_secret,'')
      ),
      body    := jsonb_build_object('mode','tick','run_id', r.message->>'run_id', 'msg_id', r.msg_id)
    );
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.drain_agent_ticks() from public;
