-- 0214_company_graph.sql
-- Le graphe d'entreprise — DÉRIVÉ, pas dessiné.
--
-- Il existait déjà trois vues en graphe dans le produit, toutes locales :
-- RoomGraph (les agents d'UNE room), MemoryGraph (la mémoire d'UN service) et
-- AssetMap (React Flow sur asset_nodes/asset_edges). AssetMap était la plus
-- proche d'une carte d'entreprise, avec deux défauts rédhibitoires : elle
-- n'était plus routée nulle part depuis le cull de juillet, et elle était
-- MANUELLE — un humain posait les nœuds (pos_x/pos_y) et traçait les arêtes à
-- la main. Un tableau blanc posé sur des objets réels, pas une topologie.
--
-- Or la topologie existe déjà : elle est écrite dans les clés étrangères.
-- entreprise → objectifs → services → agents → rooms → missions → livrables,
-- et sur le côté les outils connectés, les collections de connaissance et les
-- ressources déposées. Il n'y a rien à modéliser ; il y a à LIRE.
--
-- D'où deux vues, et rien d'autre :
--
--   company_graph_nodes — un nœud par objet réel, avec un `id` textuel
--                         "<kind>:<uuid>" unique tous types confondus.
--   company_graph_edges — une arête par clé étrangère qui a un sens pour un
--                         lecteur humain.
--
-- Trois conséquences de ce choix :
--
--   • Rien à synchroniser. Le graphe ne peut pas mentir : créez un agent, il
--     apparaît ; archivez-le, il disparaît. Aucun job, aucune dérive.
--   • Les agents peuvent l'interroger. C'est le point : `explore_company_graph`
--     répond à « qui s'occupe de la facturation ? », « quel service a déjà
--     Shopify connecté ? », « qui porte l'objectif dont je dépends ? » sans
--     qu'on ait à câbler une requête par question.
--   • security_invoker : la vue applique la RLS des tables de base AU NOM DE
--     L'APPELANT. Un membre ne voit donc que le graphe de ses workspaces —
--     l'isolation multi-tenant n'est pas contournée par la vue.
--
-- Ce qui est volontairement borné : les livrables et les missions sont limités
-- aux 90 derniers jours. Un graphe qui contient trois ans de production n'est
-- pas une carte, c'est un mur ; l'historique complet reste dans ses tables.

-- ── Les nœuds ───────────────────────────────────────────────────────────────
create or replace view public.company_graph_nodes
  with (security_invoker = on) as

-- L'entreprise elle-même : la racine, et le seul nœud qui existe toujours.
select
  p.id                                   as project_id,
  'company:' || p.id::text               as id,
  'company'                              as kind,
  coalesce(cp.legal_name, p.name)        as label,
  cp.activity                            as sublabel,
  null::text                             as status,
  p.id                                   as ref_id,
  null::uuid                             as dashboard_id,
  p.created_at                           as created_at
from public.projects p
left join public.company_profile cp on cp.project_id = p.id

union all
-- Les objectifs. `status` porte l'état (active / at_risk / done…), ce qui
-- permet de colorer l'arbre sans requête supplémentaire.
select o.project_id, 'objective:' || o.id::text, 'objective', o.title,
       nullif(concat_ws(' ', o.metric, o.target_value::text, o.unit), ''),
       o.status, o.id, o.owner_dashboard_id, o.created_at
from public.company_objectives o
where o.status <> 'abandoned'

union all
-- Les services : l'unité d'organisation du produit.
select d.project_id, 'service:' || d.id::text, 'service', d.name,
       d.mission, d.collaboration, d.id, d.id, d.created_at
from public.service_dashboards d

union all
-- Les agents. Un agent sans service existe (agents créés avant 0133) : il se
-- rattache alors directement à l'entreprise, cf. les arêtes plus bas.
select a.project_id, 'agent:' || a.id::text, 'agent', a.name,
       coalesce(a.role, a.persona), null::text, a.id, a.service_dashboard_id, a.created_at
from public.internal_agents a
where coalesce(a.is_archived, false) = false

union all
-- Les rooms : là où le travail se discute.
select r.project_id, 'room:' || r.id::text, 'room', r.title,
       null::text, null::text, r.id, r.dashboard_id, r.created_at
from public.service_rooms r

union all
-- Les missions récentes : le travail en cours ou tout juste fini.
select m.project_id, 'mission:' || m.id::text, 'mission', m.title,
       null::text, m.status, m.id, ag.service_dashboard_id, m.created_at
from public.internal_agent_missions m
left join public.internal_agents ag on ag.id = m.agent_id
where m.created_at > now() - interval '90 days'
  and m.status <> 'archived'

union all
-- Les livrables récents : la sortie réelle de la workforce. Le projet se lit
-- sur le run OU sur la mission — un livrable produit en chat n'a pas de run
-- rattaché, et il compte quand même comme production.
select coalesce(r.project_id, m.project_id, ag.project_id),
       'deliverable:' || dl.id::text, 'deliverable', dl.name,
       dl.kind, null::text, dl.id, ag.service_dashboard_id, dl.created_at
from public.internal_agent_deliverables dl
left join public.internal_agent_runs r on r.id = dl.run_id
left join public.internal_agent_missions m on m.id = dl.mission_id
left join public.internal_agents ag on ag.id = dl.agent_id
where dl.created_at > now() - interval '90 days'
  and coalesce(r.project_id, m.project_id, ag.project_id) is not null

union all
-- Les outils connectés : les mains de la workforce sur le monde réel.
select c.project_id, 'connector:' || c.id::text, 'connector', c.provider,
       c.permissions, c.status, c.id, c.service_dashboard_id, c.created_at
from public.connectors c
where c.project_id is not null

union all
-- Les collections de connaissance.
select k.project_id, 'collection:' || k.id::text, 'collection', k.name,
       k.description, null::text, k.id, null::uuid, k.created_at
from public.rag_collections k

union all
-- Les ressources déposées dans un service (dépôts, liens, personnes, clés…).
select s.project_id, 'asset:' || s.id::text, 'asset', s.label,
       s.value, s.kind, s.id, s.dashboard_id, s.created_at
from public.service_dashboard_assets s;

grant select on public.company_graph_nodes to authenticated;

comment on view public.company_graph_nodes is
  'Graphe d''entreprise (nœuds), dérivé des tables réelles. id = "<kind>:<uuid>". RLS appliquée au nom de l''appelant.';

-- ── Les arêtes ──────────────────────────────────────────────────────────────
create or replace view public.company_graph_edges
  with (security_invoker = on) as

-- entreprise → objectif racine
select o.project_id,
       'company:' || o.project_id::text as source_id,
       'objective:' || o.id::text       as target_id,
       'objective'                      as relation
from public.company_objectives o
where o.parent_id is null and o.status <> 'abandoned'

union all
-- objectif → sous-objectif : la chaîne de causalité qu'un agent peut remonter
-- pour savoir POURQUOI on lui demande ça.
select o.project_id, 'objective:' || o.parent_id::text, 'objective:' || o.id::text, 'sub_objective'
from public.company_objectives o
where o.parent_id is not null and o.status <> 'abandoned'

union all
-- objectif → service porteur
select o.project_id, 'objective:' || o.id::text, 'service:' || o.owner_dashboard_id::text, 'owned_by'
from public.company_objectives o
where o.owner_dashboard_id is not null and o.status <> 'abandoned'

union all
-- objectif → agent responsable
select o.project_id, 'objective:' || o.id::text, 'agent:' || o.owner_agent_id::text, 'assigned_to'
from public.company_objectives o
where o.owner_agent_id is not null and o.status <> 'abandoned'

union all
-- entreprise → service
select d.project_id, 'company:' || d.project_id::text, 'service:' || d.id::text, 'service'
from public.service_dashboards d

union all
-- service → agent (ou entreprise → agent quand l'agent n'a pas de service)
select a.project_id,
       case when a.service_dashboard_id is null
            then 'company:' || a.project_id::text
            else 'service:' || a.service_dashboard_id::text end,
       'agent:' || a.id::text, 'member'
from public.internal_agents a
where coalesce(a.is_archived, false) = false

union all
-- agent → agent : l'organigramme (0213).
select a.project_id, 'agent:' || a.parent_agent_id::text, 'agent:' || a.id::text, 'reports_to'
from public.internal_agents a
where coalesce(a.is_archived, false) = false and a.parent_agent_id is not null

union all
-- service → room
select r.project_id, 'service:' || r.dashboard_id::text, 'room:' || r.id::text, 'room'
from public.service_rooms r

union all
-- room → agent participant
select r.project_id, 'room:' || r.id::text, 'agent:' || ra.agent_id::text, 'participates'
from public.service_room_agents ra
join public.service_rooms r on r.id = ra.room_id

union all
-- agent → mission
select m.project_id, 'agent:' || m.agent_id::text, 'mission:' || m.id::text, 'runs'
from public.internal_agent_missions m
where m.agent_id is not null
  and m.created_at > now() - interval '90 days'
  and m.status <> 'archived'

union all
-- mission → livrable (sinon agent → livrable : un livrable de chat n'a pas de
-- mission, et il compte quand même comme production).
select coalesce(r.project_id, m.project_id, ag.project_id),
       case when dl.mission_id is not null
            then 'mission:' || dl.mission_id::text
            else 'agent:' || dl.agent_id::text end,
       'deliverable:' || dl.id::text, 'produced'
from public.internal_agent_deliverables dl
left join public.internal_agent_runs r on r.id = dl.run_id
left join public.internal_agent_missions m on m.id = dl.mission_id
left join public.internal_agents ag on ag.id = dl.agent_id
where dl.created_at > now() - interval '90 days'
  and (dl.mission_id is not null or dl.agent_id is not null)
  and coalesce(r.project_id, m.project_id, ag.project_id) is not null

union all
-- service → outil connecté (ou entreprise → outil pour les connexions
-- project-wide antérieures à 0177)
select c.project_id,
       case when c.service_dashboard_id is null
            then 'company:' || c.project_id::text
            else 'service:' || c.service_dashboard_id::text end,
       'connector:' || c.id::text, 'connected'
from public.connectors c
where c.project_id is not null

union all
-- agent → collection de connaissance activée
select ca.project_id, 'agent:' || ca.agent_id::text, 'collection:' || ca.collection_id::text, 'reads'
from public.rag_collection_agents ca
where ca.agent_kind = 'internal_agent'

union all
-- service → ressource déposée
select s.project_id, 'service:' || s.dashboard_id::text, 'asset:' || s.id::text, 'holds'
from public.service_dashboard_assets s;

grant select on public.company_graph_edges to authenticated;

comment on view public.company_graph_edges is
  'Graphe d''entreprise (arêtes), dérivé des clés étrangères réelles. Rien à synchroniser : le graphe ne peut pas dériver.';
