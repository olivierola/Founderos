-- 0236_tracker_tool_kind.sql
-- L'outil « tracker » devient enregistrable.
--
-- La migration 0232 a ouvert le côté APPROBATION — `tracker_write` est une
-- nature d'action valide — mais pas le côté OUTIL : `internal_agent_tools`
-- porte toujours la liste close de 0148, où « tracker » ne figure pas. La
-- conséquence est silencieuse et totale : le runtime sait construire l'outil
-- (`hasKind("tracker")` dans internal-agent-tools.ts), mais aucune ligne de
-- ce genre ne peut être insérée — la contrainte la refuse. Autrement dit, la
-- capacité existait dans le code et était impossible à accorder.
--
-- On rouvre donc la liste. Le commentaire de 0148 vaut toujours : elle doit
-- porter TOUS les genres déjà en base, sinon l'ALTER échoue sur l'existant.
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'tracker',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom'
    )
  );

comment on constraint internal_agent_tools_kind_check on public.internal_agent_tools is
  'Les genres d''outils que le runtime sait construire. Toute addition dans internal-agent-tools.ts doit passer ici, sans quoi la capacité est inaccordable.';

-- ────────────────────────────────────────────────────────────────────────────
-- L'outil suit le périmètre
-- ────────────────────────────────────────────────────────────────────────────
-- Autoriser un agent sur un projet et lui donner l'outil pour y agir sont deux
-- gestes que rien ne distingue du point de vue de l'utilisateur : dans les deux
-- cas il répond « oui, cet agent travaille ici ». Les séparer produisait la
-- pire des situations — un agent autorisé, missionné, qui démarre et découvre
-- qu'il n'a aucun moyen de lire le work item qu'on lui confie.
--
-- Le déclencheur les réunit. Il n'accorde RIEN de plus que ce que la personne
-- vient d'accorder : l'outil est borné par `trackerScope()`, qui relit
-- `pj_project_agents` à chaque appel. Retirer l'agent du projet lui retire donc
-- l'accès dans la seconde, même si la ligne d'outil subsiste — c'est bien le
-- périmètre qui commande, pas l'outil.
--
-- Un observateur n'y a pas droit : il ne peut rien écrire, et lui donner un
-- outil d'écriture qui échouerait à chaque appel serait un mensonge coûteux
-- en jetons.
create or replace function public.grant_tracker_tool()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'observer' then
    return new;
  end if;

  insert into public.internal_agent_tools (agent_id, kind, name, description, config, enabled)
  select new.agent_id, 'tracker', 'Suivi de travail',
         'Lire et faire avancer les projets, work items, cycles et modules auxquels cet agent est rattaché.',
         '{}'::jsonb, true
  where not exists (
    select 1 from public.internal_agent_tools t
    where t.agent_id = new.agent_id and t.kind = 'tracker'
  );

  return new;
end $$;

drop trigger if exists trg_grant_tracker_tool on public.pj_project_agents;
create trigger trg_grant_tracker_tool
  after insert on public.pj_project_agents
  for each row execute function public.grant_tracker_tool();

-- Rattrapage pour les agents déjà autorisés avant ce fichier : ils portent un
-- périmètre et aucun outil, ce qui est exactement l'état que le déclencheur
-- empêche désormais.
insert into public.internal_agent_tools (agent_id, kind, name, description, config, enabled)
select distinct pa.agent_id, 'tracker', 'Suivi de travail',
       'Lire et faire avancer les projets, work items, cycles et modules auxquels cet agent est rattaché.',
       '{}'::jsonb, true
from public.pj_project_agents pa
where pa.role <> 'observer'
  and not exists (
    select 1 from public.internal_agent_tools t
    where t.agent_id = pa.agent_id and t.kind = 'tracker'
  );
