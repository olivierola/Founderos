-- 0227_plane_analytics.sql
-- Les agrégats des onglets d'Analytics, calculés en base.
--
-- Pourquoi ici et pas dans une fonction edge : le projet est au plafond de 100
-- fonctions déployées. Mais c'est aussi le bon endroit indépendamment de cette
-- contrainte — un onglet d'analytics compte des lignes, et compter des lignes
-- là où elles sont évite de les faire toutes traverser le réseau pour n'en
-- garder qu'un nombre.
--
-- L'écran chargeait jusque-là six requêtes PAR PROJET (work items, cycles,
-- modules, pages, vues, intake). Sur un service de quinze projets, c'est
-- quatre-vingt-dix allers-retours pour afficher huit chiffres.

/**
 * Le récapitulatif d'un dashboard, une ligne par projet.
 *
 * Renvoyer le détail par projet plutôt qu'un total permet aux six onglets de
 * partager la MÊME requête : l'onglet Overview somme les colonnes, les autres
 * les affichent ligne à ligne. Une fonction par onglet aurait multiplié les
 * variantes d'un même comptage, avec le risque classique que deux d'entre elles
 * finissent par ne plus dire la même chose.
 */
create or replace function public.pj_analytics(p_dashboard uuid)
returns table (
  pj_project_id uuid,
  project_name  text,
  identifier    text,
  logo_props    jsonb,
  health        text,
  lead_id       uuid,
  members       bigint,
  issues        bigint,
  epics         bigint,
  completed     bigint,
  overdue       bigint,
  cycles        bigint,
  modules       bigint,
  pages         bigint,
  views         bigint,
  intake        bigint
) language sql stable as $$
  select
    p.id, p.name, p.identifier, p.logo_props, p.health::text, p.lead_id,
    (select count(*) from public.pj_project_members m where m.pj_project_id = p.id),
    -- Les epics sont comptés à part : ce sont des work items marqués, et les
    -- laisser dans le total ferait compter deux fois le travail qu'ils portent.
    (select count(*) from public.pj_issues i
      where i.pj_project_id = p.id and i.archived_at is null
        and not i.is_draft and not i.is_epic),
    (select count(*) from public.pj_issues i
      where i.pj_project_id = p.id and i.archived_at is null and i.is_epic),
    (select count(*) from public.pj_issues i
      join public.pj_states s on s.id = i.state_id
      where i.pj_project_id = p.id and i.archived_at is null
        and not i.is_epic and s."group" = 'completed'),
    (select count(*) from public.pj_issues i
      where i.pj_project_id = p.id and i.archived_at is null and not i.is_epic
        and i.target_date < current_date and i.completed_at is null),
    (select count(*) from public.pj_cycles c where c.pj_project_id = p.id and c.archived_at is null),
    (select count(*) from public.pj_modules m where m.pj_project_id = p.id and m.archived_at is null),
    (select count(*) from public.pj_pages pg where pg.pj_project_id = p.id and pg.archived_at is null),
    (select count(*) from public.pj_views v where v.pj_project_id = p.id),
    (select count(*) from public.pj_intake_issues ii where ii.pj_project_id = p.id)
  from public.pj_projects p
  where p.dashboard_id = p_dashboard and p.archived_at is null
  order by p.name;
$$;

/**
 * Les cycles du dashboard avec leur avancement, pour l'onglet Cycles.
 *
 * L'avancement est calculé ici et non côté client parce qu'il demande de
 * joindre les items de chaque cycle à leurs états : le faire dans le navigateur
 * supposerait de charger tous les work items de tous les projets pour n'en
 * tirer qu'un pourcentage par cycle.
 */
create or replace function public.pj_analytics_cycles(p_dashboard uuid)
returns table (
  cycle_id uuid, name text, project_name text, project_logo jsonb,
  lead_id uuid, start_date date, end_date date,
  total bigint, completed bigint, percent int, phase text
) language sql stable as $$
  select
    c.id, c.name, p.name, p.logo_props, c.owned_by, c.start_date, c.end_date,
    counts.total, counts.done,
    coalesce((counts.done * 100 / nullif(counts.total, 0))::int, 0),
    case
      when c.start_date is null or c.end_date is null then 'draft'
      when current_date < c.start_date then 'upcoming'
      when current_date > c.end_date then 'completed'
      else 'current'
    end
  from public.pj_cycles c
  join public.pj_projects p on p.id = c.pj_project_id
  cross join lateral (
    select
      count(*) filter (where i.id is not null) as total,
      count(*) filter (where s."group" = 'completed') as done
    from public.pj_cycle_issues ci
    join public.pj_issues i on i.id = ci.issue_id and i.archived_at is null
    left join public.pj_states s on s.id = i.state_id
    where ci.cycle_id = c.id
  ) counts
  where p.dashboard_id = p_dashboard and c.archived_at is null
  order by c.start_date desc nulls last;
$$;

/** Même chose pour les modules, dont le statut est déclaré et non déduit des
 *  dates — d'où la colonne `status` reprise telle quelle. */
create or replace function public.pj_analytics_modules(p_dashboard uuid)
returns table (
  module_id uuid, name text, project_name text, project_logo jsonb,
  lead_id uuid, start_date date, target_date date,
  total bigint, completed bigint, percent int, status text
) language sql stable as $$
  select
    m.id, m.name, p.name, p.logo_props, m.lead_id, m.start_date, m.target_date,
    counts.total, counts.done,
    coalesce((counts.done * 100 / nullif(counts.total, 0))::int, 0),
    m.status
  from public.pj_modules m
  join public.pj_projects p on p.id = m.pj_project_id
  cross join lateral (
    select
      count(*) filter (where i.id is not null) as total,
      count(*) filter (where s."group" = 'completed') as done
    from public.pj_module_issues mi
    join public.pj_issues i on i.id = mi.issue_id and i.archived_at is null
    left join public.pj_states s on s.id = i.state_id
    where mi.module_id = m.id
  ) counts
  where p.dashboard_id = p_dashboard and m.archived_at is null
  order by m.sort_order;
$$;

/**
 * La charge par personne, pour l'onglet Membres.
 *
 * Les non-assignés sortent en ligne à part (`user_id` nul) plutôt que d'être
 * omis : sur un service qui va mal, c'est souvent la ligne la plus grosse, et
 * la masquer donnerait un tableau où tout paraît réparti.
 */
create or replace function public.pj_analytics_members(p_dashboard uuid)
returns table (user_id uuid, assigned bigint, completed bigint, overdue bigint)
language sql stable as $$
  with scoped as (
    select i.id, i.target_date, i.completed_at, s."group" as grp
    from public.pj_issues i
    join public.pj_projects p on p.id = i.pj_project_id
    left join public.pj_states s on s.id = i.state_id
    where p.dashboard_id = p_dashboard
      and i.archived_at is null and not i.is_draft and not i.is_epic
  )
  select
    a.user_id,
    count(*),
    count(*) filter (where sc.grp = 'completed'),
    count(*) filter (where sc.target_date < current_date and sc.completed_at is null)
  from scoped sc
  left join public.pj_issue_assignees a on a.issue_id = sc.id
  group by a.user_id
  order by count(*) desc;
$$;

comment on function public.pj_analytics is
  'Récapitulatif par projet : une seule requête partagée par les six onglets, là où le client en faisait six par projet.';
