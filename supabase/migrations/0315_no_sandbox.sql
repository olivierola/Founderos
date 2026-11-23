-- 0315 — Plus de sandbox ni de runner : la machine d'équipe est le seul monde
-- d'exécution des agents.
--
-- Un agent choisissait où exécuter (0092, 0117) : « cloud » (rien), « runner »
-- (la machine de l'opérateur), « sandbox » (un conteneur jetable joint par un
-- tunnel) ou « hybride » (les deux). Depuis 0296 et 0304, chaque agent travaille
-- sur la machine de son équipe, ou la sienne, créée à la demande (0311) : ses
-- commandes, ses fichiers, ses processus et son navigateur y sont. Les deux
-- anciens mondes disparaissent, avec leurs réglages.
--
-- Les automatisations qui exécutaient du code dans la sandbox le font sur la
-- machine de l'assistant du service.

drop trigger if exists trg_internal_agents_guard_sandbox_url on public.internal_agents;
drop function if exists public.internal_agents_guard_sandbox_url();

alter table public.internal_agents drop constraint if exists internal_agents_sandbox_mode_check;
alter table public.internal_agents drop column if exists sandbox_mode;
alter table public.internal_agents drop column if exists sandbox_url;

delete from public.app_config where key in ('sandbox_url', 'runner_browser_url');

-- Les réglages par défaut des agents d'un service (0158) n'ont plus d'environnement à choisir.
update public.service_dashboards
   set settings = jsonb_set(settings, '{agent_defaults}', (settings->'agent_defaults') - 'sandbox_mode')
 where settings ? 'agent_defaults' and settings->'agent_defaults' ? 'sandbox_mode';
