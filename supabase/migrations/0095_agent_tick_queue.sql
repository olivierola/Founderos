-- 0095_agent_tick_queue.sql
-- Tick-based execution for LONG autonomous missions (#1). The Edge runtime caps
-- a worker's wall clock (~400s), so a long mission can't finish in one
-- invocation. We split the agent loop into short "ticks" (a few rounds each):
-- each tick loads persisted state, runs a few rounds, persists, and re-enqueues
-- the next tick on a durable pgmq queue. A pg_cron drainer dispatches queued
-- ticks to the Edge function via pg_net. Crashes are recovered by pgmq's
-- visibility-timeout redelivery. (Chat stays synchronous-background — it fits.)

create extension if not exists pg_net;
create extension if not exists pgmq cascade;
create extension if not exists pg_cron;

-- Durable queue (idempotent).
do $$ begin perform pgmq.create('agent_run_ticks'); exception when others then null; end $$;

-- Per-run resumable state. Locked down: no RLS policies → only the service role
-- (which bypasses RLS) can touch it; the messages may carry sensitive context.
create table if not exists public.internal_agent_run_state (
  run_id           uuid primary key references public.internal_agent_runs(id) on delete cascade,
  mode             text not null,
  agent_id         uuid not null references public.internal_agents(id) on delete cascade,
  conversation_id  uuid,
  mission_id       uuid,
  messages         jsonb not null default '[]'::jsonb,
  round            int   not null default 0,
  max_rounds       int   not null default 30,
  provider         text,
  model            text,
  meta             jsonb not null default '{}'::jsonb,
  processing_until timestamptz,              -- lease to prevent double-processing
  tokens_in        int not null default 0,
  tokens_out       int not null default 0,
  cost_usd         numeric(10,6) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.internal_agent_run_state enable row level security;

-- Wrappers (security definer): the Edge function (service role) calls these via
-- RPC to enqueue / atomically hand off / ack ticks.
create or replace function public.agent_tick_enqueue(p_run_id uuid)
  returns bigint language sql security definer set search_path = public, pgmq as
$$ select pgmq.send('agent_run_ticks', jsonb_build_object('run_id', p_run_id)); $$;

-- Atomic hand-off: delete the current message AND enqueue the next in one tx, so
-- a run always has exactly one in-flight tick (no double-fan-out).
create or replace function public.agent_tick_next(p_msg_id bigint, p_run_id uuid)
  returns bigint language plpgsql security definer set search_path = public, pgmq as
$$ begin perform pgmq.delete('agent_run_ticks', p_msg_id);
         return pgmq.send('agent_run_ticks', jsonb_build_object('run_id', p_run_id)); end $$;

create or replace function public.agent_tick_ack(p_msg_id bigint)
  returns boolean language sql security definer set search_path = public, pgmq as
$$ select pgmq.delete('agent_run_ticks', p_msg_id); $$;

-- Drainer: read pending ticks (180s visibility) and POST each to the Edge fn.
-- The service-role key lives in Vault under 'agent_service_key'.
create or replace function public.drain_agent_ticks()
  returns int language plpgsql security definer set search_path = public, pgmq, net, vault as
$$
declare r record; n int := 0; svc text;
begin
  select decrypted_secret into svc from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  if svc is null then return 0; end if;
  for r in select * from pgmq.read('agent_run_ticks', 180, 10) loop
    perform net.http_post(
      url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/internal-agent-run',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||svc),
      body    := jsonb_build_object('mode','tick','run_id', r.message->>'run_id', 'msg_id', r.msg_id)
    );
    n := n + 1;
  end loop;
  return n;
end $$;

-- Only internal callers may enqueue/dispatch ticks.
revoke all on function public.agent_tick_enqueue(uuid) from public;
revoke all on function public.agent_tick_next(bigint, uuid) from public;
revoke all on function public.agent_tick_ack(bigint) from public;
revoke all on function public.drain_agent_ticks() from public;
grant execute on function public.agent_tick_enqueue(uuid) to service_role;
grant execute on function public.agent_tick_next(bigint, uuid) to service_role;
grant execute on function public.agent_tick_ack(bigint) to service_role;

-- Run the drainer every 10 seconds (pg_cron 1.6 supports sub-minute intervals).
do $$ begin perform cron.unschedule('drain-agent-ticks'); exception when others then null; end $$;
select cron.schedule('drain-agent-ticks', '10 seconds', $$ select public.drain_agent_ticks(); $$);
