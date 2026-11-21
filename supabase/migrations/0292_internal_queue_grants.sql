-- 0292_internal_queue_grants.sql
--
-- Les rouages internes du moteur des agents n'étaient fermés qu'à PUBLIC.
--
-- Les migrations qui les ont créés (0095, 0096, 0097…) font
-- `revoke all … from public`. Sur Supabase, ça ne suffit pas : les privilèges
-- par défaut du schéma public donnent EXPLICITEMENT `execute` à anon et à
-- authenticated sur chaque nouvelle fonction, et un revoke à PUBLIC ne retire
-- pas un droit accordé nommément. Constaté le 10/11/2026 sur le cloud : avec la
-- seule clé anon (celle du bundle du front), n'importe qui pouvait appeler
-- /rest/v1/rpc/agent_tick_ack et SUPPRIMER les ticks en file (tous les runs en
-- cours s'arrêtaient), injecter des ticks pour n'importe quel run
-- (agent_tick_enqueue), ou lancer à la chaîne les planificateurs.
--
-- Ces fonctions ne sont appelées que par pg_cron (superutilisateur) et par les
-- fonctions edge avec le service role : on retire le droit à anon et
-- authenticated, et on le donne nommément au service role. Idempotente ; une
-- fonction absente (installation partielle) est ignorée.

do $$
declare
  fn text;
  internal text[] := array[
    'public.agent_tick_ack(bigint)',
    'public.agent_tick_enqueue(uuid)',
    'public.agent_tick_next(bigint, uuid)',
    'public.drain_agent_ticks()',
    'public.reconcile_zombie_runs()',
    'public.pj_drain_webhooks()',
    'public.tick_agent_scheduler()',
    'public.tick_sentinelflow()',
    'public.tick_workflow_scheduler()'
  ];
begin
  foreach fn in array internal loop
    if to_regprocedure(fn) is null then
      continue;
    end if;
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
