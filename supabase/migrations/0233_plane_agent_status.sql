-- 0233_plane_agent_status.sql
-- Le vrai motif de « column status is ambiguous », et sa correction.
--
-- `internal_agents` N'A PAS de colonne `status`.
--
-- Elle n'en a jamais eu. Le `status text default 'draft'` de la migration 0025
-- appartient à `internal_agent_missions`, déclarée quelques lignes plus bas
-- dans le même fichier — d'où la confusion.
--
-- C'est l'explication d'une série de symptômes qui semblaient sans rapport :
--
--   · le sélecteur d'agents restait vide, parce qu'il filtrait sur
--     `status = 'active'`, c'est-à-dire sur une colonne inexistante ;
--   · la création de `pj_workgraph` échouait sur « column reference status is
--     ambiguous » — Postgres, ne trouvant pas `status` sur la table, cherchait
--     ailleurs et tombait sur l'alias du sous-select, d'où l'ambiguïté plutôt
--     qu'un franc « column does not exist ».
--
-- Les agents passent donc par une CTE qui ne sélectionne que des colonnes
-- RÉELLES. Leur `status` dans le graphe vaut null, ce qui est exact : cette
-- information n'existe pas. Le cycle de vie d'un agent se lit sur
-- `is_archived`, et c'est déjà ce que fait le filtre de la CTE.

drop function if exists public.pj_workgraph(uuid, text[], int);

create or replace function public.pj_workgraph(
  p_dashboard uuid,
  p_kinds text[] default null,
  p_issue_limit int default 300
) returns setof public.pj_workgraph_node language sql stable as $$
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
  ),
  -- Uniquement des colonnes qui EXISTENT, et le filtre de cycle de vie que le
  -- reste de l'application emploie (`is_archived`).
  agents as (
    select a.id, a.name, a.avatar_emoji
    from public.internal_agents a
    where a.service_dashboard_id = p_dashboard
      and a.is_archived = false
  )
  select * from (
    select 'initiative'::text as g_kind,
           ini.id            as g_id,
           ini.name::text    as g_label,
           ''::text          as g_sub,
           ini.health::text  as g_health,
           ini.status::text  as g_status,
           ini.lead_id       as g_lead,
           coalesce((select (ip.completed * 100 / nullif(ip.total, 0))::int
                     from public.pj_initiative_progress(ini.id) ip), 0)::int as g_percent,
           null::uuid        as g_parent,
           null::uuid[]      as g_links
    from public.pj_initiatives ini
    where ini.dashboard_id = p_dashboard and ini.archived_at is null

    union all
    select 'project', proj.id, proj.name, proj.identifier, proj.health, null, proj.lead_id,
           coalesce((proj.done * 100 / nullif(proj.total, 0))::int, 0),
           (select ip.initiative_id from public.pj_initiative_projects ip
             where ip.pj_project_id = proj.id limit 1),
           null::uuid[]
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
           e.pj_project_id, null::uuid[]
    from public.pj_issues e
    join public.pj_projects p on p.id = e.pj_project_id
    where e.is_epic and p.dashboard_id = p_dashboard and e.archived_at is null

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
           c.pj_project_id, null::uuid[]
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
           m.pj_project_id, null::uuid[]
    from public.pj_modules m
    join public.pj_projects p on p.id = m.pj_project_id
    where p.dashboard_id = p_dashboard and m.archived_at is null

    union all
    select 'page', pg.id, coalesce(nullif(pg.name, ''), 'Sans titre'), ''::text,
           null, null, pg.owned_by, 0,
           coalesce(pg.parent_id, pg.pj_project_id), null::uuid[]
    from public.pj_pages pg
    left join public.pj_projects p on p.id = pg.pj_project_id
    where pg.archived_at is null
      and (p.dashboard_id = p_dashboard or pg.dashboard_id = p_dashboard)

    union all
    select 'issue', k.id, k.name, p.identifier || '-' || k.sequence_id,
           null, k.state_name, null,
           case when k.state_group = 'completed' then 100 else 0 end,
           coalesce(
             (select k2.id from kept k2 where k2.id = k.parent_id),
             (select ei.epic_id from public.pj_epic_issues ei where ei.issue_id = k.id limit 1),
             k.pj_project_id
           ),
           coalesce(
             (select array_agg(cyi.cycle_id)
                from public.pj_cycle_issues cyi where cyi.issue_id = k.id),
             '{}'::uuid[]
           ) || coalesce(
             (select array_agg(mi.module_id)
                from public.pj_module_issues mi where mi.issue_id = k.id),
             '{}'::uuid[]
           )
    from kept k
    join public.pj_projects p on p.id = k.pj_project_id

    union all
    select 'sticky', sk.id,
           coalesce(nullif(left(regexp_replace(sk.content, '\s+', ' ', 'g'), 60), ''), 'Note'),
           ''::text, null, null, sk.user_id, 0, null::uuid, null::uuid[]
    from public.pj_stickies sk
    where sk.dashboard_id = p_dashboard
      and coalesce(sk.content, '') <> ''

    union all
    select 'agent', ag.id, ag.name, coalesce(ag.avatar_emoji, '🤖'),
           null, null, null, 0, null::uuid,
           (
             select array_agg(distinct ia.issue_id)
             from public.pj_issue_agents ia
             join public.pj_issues i3 on i3.id = ia.issue_id
             join public.pj_projects p3 on p3.id = i3.pj_project_id
             where ia.agent_id = ag.id and p3.dashboard_id = p_dashboard
           )
    from agents ag

    union all
    select 'member', u.id,
           coalesce(nullif(p4.full_name, ''), split_part(u.email, '@', 1), 'Membre'),
           coalesce(u.email, ''), null, null, null, 0, null::uuid,
           (
             select array_agg(distinct ass.issue_id)
             from public.pj_issue_assignees ass
             join public.pj_issues i4 on i4.id = ass.issue_id
             join public.pj_projects p5 on p5.id = i4.pj_project_id
             where ass.user_id = u.id and p5.dashboard_id = p_dashboard
           )
    from auth.users u
    join public.workspace_members wm on wm.user_id = u.id
    left join public.profiles p4 on p4.id = u.id
    where wm.workspace_id = (
      select sd.workspace_id from public.service_dashboards sd where sd.id = p_dashboard
    )
  ) g(node_kind, node_id, label, sub_label, health, status, lead_id, percent, parent_id, link_ids)
  where p_kinds is null or g.node_kind = any(p_kinds);
$$;

comment on function public.pj_workgraph is
  'Le graphe entier d''un dashboard : initiatives, projets, epics, cycles, modules, pages, work items, notes, agents et membres. `parent_id` porte le rattachement principal, `link_ids` les autres — c''est ce qui en fait un réseau et non un arbre.';
