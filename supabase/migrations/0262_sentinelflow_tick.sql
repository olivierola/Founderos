-- 0262_sentinelflow_tick.sql
-- Le passage planifié de SentinelFlow : interroger les sources dues et trier
-- les alertes reçues, chaque minute.
--
-- Il a SA propre tâche plutôt qu'une place dans tick-agent-scheduler : ce
-- dernier refuse ses appels (401) depuis début août — la clé de service gardée
-- dans le coffre (agent_service_key) ne correspond plus à celle des fonctions.
-- Le passage SentinelFlow s'authentifie donc comme l'envoi des tâches d'agents
-- (0096) : par le secret interne dédié `agent_tick_secret`, envoyé en
-- x-tick-secret. automation-receiver ne vérifie pas le JWT : le Bearer ne sert
-- qu'au routage de la passerelle.
--
-- Rien n'est appelé tant qu'aucune source active n'existe ou qu'aucune alerte
-- n'attend : un projet sans SentinelFlow ne paie pas une invocation par minute.

create or replace function public.tick_sentinelflow()
  returns void language plpgsql security definer set search_path = public, net, vault as
$$
declare svc text; tick_secret text;
begin
  if not exists (select 1 from public.sentinel_sources where enabled and kind in ('poll', 'internal'))
     and not exists (select 1 from public.sentinel_alerts where status = 'new') then
    return;
  end if;
  select decrypted_secret into svc         from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  select decrypted_secret into tick_secret from vault.decrypted_secrets where name = 'agent_tick_secret' limit 1;
  if tick_secret is null then return; end if;
  perform net.http_post(
    url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/automation-receiver?sentinel=tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(svc, ''),
      'x-tick-secret', tick_secret
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end $$;

revoke all on function public.tick_sentinelflow() from public;

do $$ begin perform cron.unschedule('tick-sentinelflow'); exception when others then null; end $$;
select cron.schedule('tick-sentinelflow', '* * * * *', $$ select public.tick_sentinelflow(); $$);
