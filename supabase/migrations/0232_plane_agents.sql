-- 0232_plane_agents.sql
-- Les agents deviennent des assignés du suivi de travail.
--
-- Jusqu'ici le module ne connaissait que des personnes. C'est une limite de
-- fond pour un produit dont la promesse est une force de travail mixte : on
-- pouvait demander à un agent de faire quelque chose depuis un chat, mais rien
-- ne reliait ce travail au board — ni ce qu'il portait, ni ce qu'il avait
-- livré, ni où il en était.
--
-- Le parti pris est simple : un agent s'assigne EXACTEMENT comme une personne,
-- dans une table jumelle de `pj_issue_assignees`. Deux tables et non une
-- colonne polymorphe, parce qu'un agent et un membre ne se contraignent pas
-- pareil — l'un référence `internal_agents`, l'autre `auth.users`, et une clé
-- étrangère qui pointerait tantôt sur l'un tantôt sur l'autre ne serait plus
-- une clé étrangère du tout.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Assignation
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.pj_issue_agents (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- Qui a confié le travail. Un agent peut s'assigner lui-même (il vaut alors
  -- null) et la distinction compte : « personne ne lui a demandé » n'est pas
  -- « quelqu'un le lui a demandé ».
  assigned_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (issue_id, agent_id)
);

create index if not exists idx_pj_issue_agents_issue on public.pj_issue_agents(issue_id);
create index if not exists idx_pj_issue_agents_agent on public.pj_issue_agents(agent_id, created_at desc);

comment on table public.pj_issue_agents is
  'Les agents assignés à un work item, en parallèle de pj_issue_assignees pour les personnes. Un work item peut porter les deux : c''est même le cas normal — un agent prépare, une personne valide.';

-- Le PÉRIMÈTRE d'un agent : les projets sur lesquels il a le droit d'agir.
--
-- Sans elle, un agent doté de l'outil de suivi verrait tous les projets du
-- service. C'est rarement voulu, et jamais sûr : un agent de support n'a pas à
-- réordonner le backlog de l'infrastructure. Une table vide pour un agent
-- signifie « aucun projet », pas « tous » — le défaut le plus fermé.
create table if not exists public.pj_project_agents (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  agent_id       uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  -- 'contributor' agit, 'observer' lit seulement. Un agent qui rédige des
  -- comptes rendus n'a pas besoin d'écrire dans le board.
  role           text not null default 'contributor'
                   check (role in ('contributor', 'observer')),
  created_at     timestamptz not null default now(),
  unique (pj_project_id, agent_id)
);

create index if not exists idx_pj_project_agents_project on public.pj_project_agents(pj_project_id);
create index if not exists idx_pj_project_agents_agent on public.pj_project_agents(agent_id);

comment on table public.pj_project_agents is
  'Le périmètre d''un agent dans le suivi : les projets où il peut agir. Absent de la table = aucun accès, jamais « tous les projets ».';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Traçabilité
-- ────────────────────────────────────────────────────────────────────────────
-- Une écriture faite par un agent doit se distinguer d'une écriture faite par
-- une personne, sinon le journal d'activité devient inexploitable : on lit
-- « état passé à Terminé » sans savoir si quelqu'un l'a décidé ou si un agent
-- l'a déduit. La colonne est sur le JOURNAL et sur les commentaires, là où la
-- question se pose.

alter table public.pj_issue_activity
  add column if not exists agent_id uuid references public.internal_agents(id) on delete set null;

alter table public.pj_issue_comments
  add column if not exists agent_id uuid references public.internal_agents(id) on delete set null;

comment on column public.pj_issue_activity.agent_id is
  'L''agent auteur de la ligne, quand ce n''en est pas une personne. `actor_id` reste null dans ce cas.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['pj_issue_agents', 'pj_project_agents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "workspace members access %s" on public.%I', t, t);
    execute format($p$
      create policy "workspace members access %1$s" on public.%1$I
        for all using (
          exists (
            select 1 from public.workspace_members wm
            where wm.workspace_id = %1$I.workspace_id and wm.user_id = auth.uid()
          )
        )
        with check (
          exists (
            select 1 from public.workspace_members wm
            where wm.workspace_id = %1$I.workspace_id and wm.user_id = auth.uid()
          )
        )
    $p$, t);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Le graphe apprend les liaisons
-- ────────────────────────────────────────────────────────────────────────────
-- Le Workgraph ne portait qu'un parent par nœud, ce qui suffit à une hiérarchie
-- mais pas à un réseau : un agent travaille sur cinq work items, une personne
-- en porte douze. D'où une colonne supplémentaire, `link_ids`, qui liste les
-- rattachements AUTRES que le parent. Le front en tire des arêtes en plus,
-- sans que rien de l'existant change.

-- On AJOUTE une colonne au retour (link_ids), et `create or replace` refuse
-- de changer un type de retour : « cannot change return type of existing
-- function ». Les deux signatures connues sont donc supprimées d'abord.
-- ── Pourquoi un TYPE et non un `returns table` ─────────────────────────────
--
-- `returns table (…, status text, …)` déclare des PARAMÈTRES DE SORTIE. Leurs
-- noms restent visibles dans tout le corps de la fonction, où ils entrent en
-- concurrence avec les colonnes des tables interrogées : `internal_agents`,
-- `pj_initiatives` et `pj_modules` portent toutes une colonne `status`, et
-- Postgres refuse alors de trancher — « column reference status is ambiguous ».
-- Qualifier les références (`a.status`) ne suffit pas : le conflit se joue à la
-- résolution du nom, pas à celle de la table.
--
-- Un type composite n'a pas de paramètres : il décrit une FORME. Le corps de la
-- fonction redevient une requête ordinaire, où `status` ne désigne plus qu'une
-- colonne. Le client, lui, ne voit aucune différence — PostgREST expose les
-- champs du composite comme des colonnes, exactement comme avant.
drop function if exists public.pj_workgraph(uuid, text[], int);
drop function if exists public.pj_workgraph(uuid);

drop type if exists public.pj_workgraph_node;

create type public.pj_workgraph_node as (
  node_kind text,
  node_id   uuid,
  label     text,
  sub_label text,
  health    text,
  status    text,
  lead_id   uuid,
  percent   int,
  parent_id uuid,
  link_ids  uuid[]
);

create or replace function public.pj_workgraph(
  p_dashboard uuid,
  p_kinds text[] default null,
  p_issue_limit int default 300
)
returns setof public.pj_workgraph_node
language sql stable as $$
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

    -- Un work item porte désormais ses liaisons : son cycle et ses modules
    -- s'ajoutent au parent. C'est ce qui transforme l'arbre en réseau, et donc
    -- ce qui rend le graphe utile — voir qu'un ticket appartient au cycle en
    -- retard ET au module qu'on s'apprêtait à livrer.
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
    select 'sticky', st.id,
           coalesce(nullif(left(regexp_replace(st.content, '\s+', ' ', 'g'), 60), ''), 'Note'),
           ''::text, null, null, st.user_id, 0, null::uuid, null::uuid[]
    from public.pj_stickies st
    where st.dashboard_id = p_dashboard
      and coalesce(st.content, '') <> ''

    -- ── Les agents ────────────────────────────────────────────────────────
    -- Un agent se rattache aux work items qu'il porte. Aucun parent : il
    -- n'appartient à rien, il TRAVAILLE sur des choses — et c'est justement ce
    -- que le graphe doit montrer.
    union all
    select 'agent', ag.id, ag.name, coalesce(ag.avatar_emoji, '🤖'), null, null::text, null,
           0, null::uuid,
           (
             select array_agg(distinct ia.issue_id)
             from public.pj_issue_agents ia
             join public.pj_issues i3 on i3.id = ia.issue_id
             join public.pj_projects p3 on p3.id = i3.pj_project_id
             where ia.agent_id = ag.id and p3.dashboard_id = p_dashboard
           )
    from public.internal_agents ag
    where ag.service_dashboard_id = p_dashboard

    -- ── Les personnes ─────────────────────────────────────────────────────
    -- Mêmes règles que les agents : c'est ce qui permet de lire d'un coup qui
    -- — humain ou machine — porte quoi, et où les deux se croisent.
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
  'Le graphe entier d''un dashboard : initiatives, projets, epics, cycles, modules, pages, work items, notes, AGENTS et MEMBRES. `parent_id` porte le rattachement principal, `link_ids` les autres (cycle et modules d''un item, work items d''un agent ou d''une personne) — c''est ce qui en fait un réseau et non un arbre.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Approbations
-- ────────────────────────────────────────────────────────────────────────────
-- Une écriture d'agent dans le suivi passe par la même file d'approbation que
-- les autres actions sortantes. Un type à part, et non `crm_write` réutilisé :
-- l'exécuteur dispatche sur ce champ, et le libellé montré à la personne qui
-- approuve doit dire de quoi il s'agit — « CRM · update » devant un changement
-- d'état de work item serait faux et ferait approuver à l'aveugle.
alter table public.internal_agent_approvals
  drop constraint if exists internal_agent_approvals_action_kind_check;
alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_action_kind_check check (
    action_kind in (
      'edge_function', 'webhook', 'connector_action', 'composio_action',
      'crm_write', 'tracker_write'
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Ce qu'un agent a sur les bras
-- ────────────────────────────────────────────────────────────────────────────
-- L'équivalent de `pj_my_work` pour un agent. Il sert des deux côtés : à
-- l'agent, qui commence son tour en demandant ce qui lui est confié ; et à
-- l'interface, qui affiche la charge d'un agent sur sa fiche.
create or replace function public.pj_agent_work(p_agent uuid)
returns table (
  issue_id uuid, name text, sequence_id int, identifier text,
  pj_project_id uuid, project_name text,
  state_name text, state_group text, state_color text,
  priority text, target_date date, completed_at timestamptz,
  assigned_at timestamptz
) language sql stable as $$
  select i.id, i.name, i.sequence_id, p.identifier,
         i.pj_project_id, p.name,
         s.name, s."group"::text, s.color,
         i.priority::text, i.target_date, i.completed_at,
         ia.created_at
  from public.pj_issue_agents ia
  join public.pj_issues i on i.id = ia.issue_id
  join public.pj_projects p on p.id = i.pj_project_id
  left join public.pj_states s on s.id = i.state_id
  where ia.agent_id = p_agent
    and i.archived_at is null
    and not i.is_draft
  -- Les non terminés d'abord, puis par échéance : c'est l'ordre dans lequel un
  -- agent doit attaquer sa file, et le lui laisser deviner reviendrait à lui
  -- faire trier une liste à chaque tour.
  order by (i.completed_at is not null), i.target_date nulls last, ia.created_at;
$$;

comment on function public.pj_agent_work is
  'La file de travail d''un agent : ce qui lui est assigné, non terminé d''abord, par échéance.';
