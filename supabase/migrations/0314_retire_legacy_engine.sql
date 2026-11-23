-- 0314 — Retrait de l'ancien moteur d'agents (docs/harness-opencode/04).
--
-- Le harnais OpenCode du backend est désormais le seul moteur : il tient
-- lui-même la transcription, la reprise après redémarrage, les sous-agents et
-- la compaction. Ce qui ne servait qu'à l'ancienne boucle par ticks disparaît :
--
--   - la file pgmq `agent_run_ticks`, son vidage toutes les 10 s par pg_cron et
--     ses fonctions (agent_tick_enqueue / _next / _ack, drain_agent_ticks) ;
--   - le réveil des runs parents (agent_run_wake) et leur boîte de réception ;
--   - l'état d'un run en cours (internal_agent_run_state) : ce qui en était
--     métier vit dans internal_agent_runs.run_meta (0313) ;
--   - les sorties d'outils conservées (OpenCode garde les siennes) et le
--     registre des appels (le pont écrit les appels dans internal_agent_run_events) ;
--   - la colonne internal_agents.harness (0307) : il n'y a plus de choix de moteur.
--
-- Les runs, leurs événements, les messages, livrables et approbations restent.
-- L'état d'exécution des tables retirées n'était que transitoire.

-- ── La file des ticks ──
do $$ begin perform cron.unschedule('drain-agent-ticks'); exception when others then null; end $$;
drop function if exists public.drain_agent_ticks();
drop function if exists public.agent_tick_enqueue(uuid);
drop function if exists public.agent_tick_next(bigint, uuid);
drop function if exists public.agent_tick_ack(bigint);
drop function if exists public.agent_run_wake(uuid);
do $$ begin perform pgmq.drop_queue('agent_run_ticks'); exception when others then null; end $$;

-- ── Les runs que plus rien ne fait avancer ──
-- Un run du harnais (opencode_session_id) est suivi par le backend lui-même :
-- l'ordonnanceur clôt ceux que plus aucune session ne porte. Ici, seulement les
-- runs sans session : en file depuis une heure (jamais partis), ou « en cours »
-- depuis douze minutes sans moteur pour les porter.
create or replace function public.reconcile_zombie_runs()
  returns int language plpgsql security definer set search_path = public as
$$
declare n int;
begin
  update public.internal_agent_runs r
     set status = 'failed', finished_at = now(),
         error_message = case when r.status = 'queued'
           then 'Jamais démarré (aucun moteur ne l''a pris en charge)'
           else 'Réconcilié : aucun moteur ne portait ce run' end
   where r.opencode_session_id is null
     and (
       (r.status = 'queued' and r.created_at < now() - interval '60 minutes')
       or (r.status = 'running' and coalesce(r.started_at, r.created_at) < now() - interval '12 minutes')
     );
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.reconcile_zombie_runs() from public;

-- ── Les tables de l'ancienne boucle ──
drop table if exists public.internal_agent_run_state cascade;
drop table if exists public.internal_agent_run_inbox cascade;
drop table if exists public.internal_agent_tool_outputs cascade;
drop table if exists public.internal_agent_call_ledger cascade;

-- ── Plus de choix de moteur ──
alter table public.internal_agents drop column if exists harness;
