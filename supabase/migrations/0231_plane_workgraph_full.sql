-- 0231_plane_workgraph_full.sql
-- Le Workgraph couvre tout l'espace de travail, pas seulement trois niveaux.
--
-- La version de 0224 ne cartographiait que initiative → projet → epic. C'était
-- suffisant pour une vue de direction, et insuffisant pour ce à quoi la carte
-- sert vraiment : retrouver un objet dont on sait à quoi il se rattache mais
-- pas où il est rangé. Une page de spec, un cycle, une note prise en réunion
-- n'apparaissaient nulle part, alors que ce sont précisément les objets qu'on
-- perd.
--
-- D'où sept familles au lieu de trois, toutes rattachées à leur parent naturel
-- (le projet pour un cycle, un module ou une page ; le work item parent ou
-- l'epic pour un work item ; rien pour une note, qui n'appartient à personne).
--
-- Le coût est borné par une LIMITE sur les work items : un dashboard qui en
-- porte dix mille produirait un graphe illisible et une requête lente. On prend
-- les plus récemment touchés, qui sont ceux qu'on cherche.

-- L'ancienne signature de 0224 s'en va : sans ce drop, on obtiendrait une
-- SURCHARGE (deux fonctions du même nom), et un appel sans arguments nommés
-- pourrait tomber sur la version périmée.
drop function if exists public.pj_workgraph(uuid);

create or replace function public.pj_workgraph(
  p_dashboard uuid,
  p_kinds text[] default null,
  p_issue_limit int default 300
)
returns table (
  node_kind text, node_id uuid, label text, sub_label text,
  health text, status text, lead_id uuid, percent int, parent_id uuid
) language sql stable as $$
  with proj as (
    select p.id, p.name, p.identifier, p.lead_id, p.health::text as health,
           count(i.*) filter (where i.archived_at is null and not i.is_draft) as total,
           count(i.*) filter (where s."group" = 'completed') as done
    from public.pj_projects p
    left join public.pj_issues i on i.pj_project_id = p.id
    left join public.pj_states s on s.id = i.state_id
    where p.dashboard_id = p_dashboard and p.archived_at is null
    group by p.id
  ),
  -- Les work items retenus, une seule fois : la sous-requête sert à la fois de
  -- source de nœuds et de borne pour les arêtes, sinon un enfant pourrait
  -- pointer vers un parent qui n'a pas été retenu.
  kept as (
    select i.id, i.name, i.sequence_id, i.pj_project_id, i.parent_id,
           i.priority, s."group" as state_group, s.name as state_name, s.color
    from public.pj_issues i
    join public.pj_projects p on p.id = i.pj_project_id
    left join public.pj_states s on s.id = i.state_id
    where p.dashboard_id = p_dashboard
      and i.archived_at is null and not i.is_draft and not i.is_epic
    order by i.updated_at desc
    limit greatest(p_issue_limit, 0)
  )
  select * from (
    select 'initiative'::text, ini.id, ini.name, ''::text, ini.health::text, ini.status, ini.lead_id,
           coalesce((select (ip.completed * 100 / nullif(ip.total, 0))::int
                     from public.pj_initiative_progress(ini.id) ip), 0),
           null::uuid
    from public.pj_initiatives ini
    where ini.dashboard_id = p_dashboard and ini.archived_at is null

    union all
    select 'project', proj.id, proj.name, proj.identifier, proj.health, null, proj.lead_id,
           coalesce((proj.done * 100 / nullif(proj.total, 0))::int, 0),
           (select ip.initiative_id from public.pj_initiative_projects ip
             where ip.pj_project_id = proj.id limit 1)
    from proj

    union all
    select 'epic', e.id, e.name, p.identifier || '-' || e.sequence_id, null, null, null,
           coalesce((
             select (count(*) filter (where st."group" = 'completed') * 100
                     / nullif(count(*), 0))::int
             from public.pj_epic_issues ei
             join public.pj_issues ci on ci.id = ei.issue_id
             left join public.pj_states st on st.id = ci.state_id
             where ei.epic_id = e.id
           ), 0),
           e.pj_project_id
    from public.pj_issues e
    join public.pj_projects p on p.id = e.pj_project_id
    where e.is_epic and p.dashboard_id = p_dashboard and e.archived_at is null

    -- Un cycle : son avancement est celui des work items qu'il porte, et son
    -- sous-titre ses dates — c'est ce qui le distingue d'un module au premier
    -- coup d'œil, les deux étant des regroupements.
    union all
    select 'cycle', c.id, c.name,
           coalesce(to_char(c.start_date, 'DD/MM') || ' → ' || to_char(c.end_date, 'DD/MM'), 'Sans dates'),
           null, null, c.owned_by,
           coalesce((
             select (count(*) filter (where st."group" = 'completed') * 100
                     / nullif(count(*), 0))::int
             from public.pj_cycle_issues cyi
             join public.pj_issues ci on ci.id = cyi.issue_id
             left join public.pj_states st on st.id = ci.state_id
             where cyi.cycle_id = c.id and ci.archived_at is null
           ), 0),
           c.pj_project_id
    from public.pj_cycles c
    join public.pj_projects p on p.id = c.pj_project_id
    where p.dashboard_id = p_dashboard and c.archived_at is null

    union all
    select 'module', m.id, m.name, m.status, null, m.status, m.lead_id,
           coalesce((
             select (count(*) filter (where st."group" = 'completed') * 100
                     / nullif(count(*), 0))::int
             from public.pj_module_issues mi
             join public.pj_issues ci on ci.id = mi.issue_id
             left join public.pj_states st on st.id = ci.state_id
             where mi.module_id = m.id and ci.archived_at is null
           ), 0),
           m.pj_project_id
    from public.pj_modules m
    join public.pj_projects p on p.id = m.pj_project_id
    where p.dashboard_id = p_dashboard and m.archived_at is null

    -- Une page se range sous la page PARENTE quand elle en a une : c'est ainsi
    -- qu'un wiki s'organise, et aplatir la hiérarchie sur le projet perdrait
    -- justement le rangement que quelqu'un a pris la peine de faire.
    union all
    select 'page', pg.id, coalesce(nullif(pg.name, ''), 'Sans titre'), ''::text,
           null, null, pg.owned_by, 0,
           coalesce(pg.parent_id, pg.pj_project_id)
    from public.pj_pages pg
    left join public.pj_projects p on p.id = pg.pj_project_id
    where pg.archived_at is null
      and (p.dashboard_id = p_dashboard or pg.dashboard_id = p_dashboard)

    -- Un work item se rattache à son PARENT quand il en a un, à son epic
    -- sinon, et au projet en dernier recours. C'est l'ordre de la lecture :
    -- « où est ce ticket » se répond par le plus petit contenant connu.
    union all
    select 'issue', k.id, k.name, p.identifier || '-' || k.sequence_id,
           null, k.state_name, null,
           case when k.state_group = 'completed' then 100 else 0 end,
           coalesce(
             (select k2.id from kept k2 where k2.id = k.parent_id),
             (select ei.epic_id from public.pj_epic_issues ei where ei.issue_id = k.id limit 1),
             k.pj_project_id
           )
    from kept k
    join public.pj_projects p on p.id = k.pj_project_id

    -- Une note n'a pas de parent : elle est personnelle et ne relève d'aucun
    -- projet. Elle flotte, et c'est exact — c'est même la raison d'en prendre.
    union all
    select 'sticky', st.id,
           coalesce(nullif(left(regexp_replace(st.content, '\s+', ' ', 'g'), 60), ''), 'Note'),
           ''::text, null, null, st.user_id, 0, null::uuid
    from public.pj_stickies st
    where st.dashboard_id = p_dashboard
      and coalesce(st.content, '') <> ''
  ) g(node_kind, node_id, label, sub_label, health, status, lead_id, percent, parent_id)
  where p_kinds is null or g.node_kind = any(p_kinds);
$$;

comment on function public.pj_workgraph is
  'Le graphe entier d''un dashboard en une requête : initiatives, projets, epics, cycles, modules, pages, work items (bornés) et notes. `p_kinds` filtre côté serveur ; `p_issue_limit` borne les work items aux plus récemment touchés.';
