-- 0263_agent_scheduler_tick_secret.sql
-- Le planificateur des missions refusait ses propres appels depuis début août.
--
-- tick_agent_scheduler() (0126) s'authentifiait par la clé de service gardée
-- dans le coffre (agent_service_key). Cette clé ne correspond plus à celle que
-- voient les fonctions (empreintes SHA-256 comparées le 28/09) : chaque minute,
-- internal-agent-scheduler répondait 401, et aucune mission planifiée n'est
-- partie depuis le 01/08.
--
-- Même correctif que 0096 pour l'envoi des tâches d'agents : le secret interne
-- dédié `agent_tick_secret`, envoyé en x-tick-secret et accepté par
-- `authorized()` du planificateur. Le Bearer reste envoyé pour la passerelle.

create or replace function public.tick_agent_scheduler()
  returns void language plpgsql security definer set search_path = public, net, vault as
$$
declare svc text; tick_secret text;
begin
  select decrypted_secret into svc         from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  select decrypted_secret into tick_secret from vault.decrypted_secrets where name = 'agent_tick_secret' limit 1;
  if svc is null and tick_secret is null then return; end if;
  perform net.http_post(
    url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/internal-agent-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(svc, ''),
      'x-tick-secret', coalesce(tick_secret, '')
    ),
    body    := '{}'::jsonb,
    -- 5 s par défaut : un passage qui lance des missions ou réconcilie des
    -- runs dépasse ce délai, et pg_net enregistre alors une réponse vide — la
    -- fonction a travaillé, mais le journal ne dit plus ce qu'elle a fait.
    timeout_milliseconds := 55000
  );
end $$;

revoke all on function public.tick_agent_scheduler() from public;
