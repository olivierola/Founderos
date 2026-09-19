-- 0229_plane_widget_catalogue.sql
-- Le catalogue complet des widgets de tableau de bord.
--
-- 0223 en déclarait six, choisis au jugé. Celui-ci porte les vingt-six réels,
-- et le regroupement en NEUF FAMILLES n'est pas décoratif : il dit ce que le
-- widget sait faire avant qu'on l'ait posé. Barres, lignes, aires et camemberts
-- sont des FORMES — on choisit la forme quand on sait déjà quelle donnée
-- tracer. Statistiques, work items, cycle et intake sont des SUJETS — on
-- choisit le sujet quand on sait ce qu'on veut savoir mais pas comment le voir.
--
-- Un catalogue qui ne proposerait que des formes obligerait chacun à
-- reconstruire « la répartition des work items par état » à la main ; un
-- catalogue qui ne proposerait que des sujets interdirait toute question qu'on
-- n'a pas prévue. Les deux entrées coexistent pour cette raison.

alter table public.pj_dashboard_widgets
  drop constraint if exists pj_dashboard_widgets_kind_check;

alter table public.pj_dashboard_widgets
  add constraint pj_dashboard_widgets_kind_check check (kind in (
    -- Formes : la donnée vient de `config`, la famille dit comment la tracer.
    'bar_basic', 'bar_stacked', 'bar_grouped',
    'line_basic', 'line_multi',
    'area_basic', 'area_stacked', 'area_comparison',
    'pie', 'donut_basic', 'donut_progress',
    'number',

    -- Sujets : la question est fixée, seuls ses paramètres se règlent.
    'stat_work_items', 'stat_smart_counter', 'stat_smart_gauge', 'stat_two_dimensional',
    'issues_table', 'issues_assigned', 'issues_progress',
    'cycle_progress', 'cycle_active_progress',
    'intake_ageing', 'intake_breakdown', 'intake_by_source',
    'intake_accepted_declined', 'intake_decision_time',

    -- Les six d'origine restent acceptés : des tableaux de bord les utilisent
    -- déjà, et les renommer casserait des pages en production pour un gain
    -- purement cosmétique.
    'count', 'distribution', 'progress', 'burndown', 'issue_list', 'overdue'
  ));

comment on column public.pj_dashboard_widgets.kind is
  'La famille du widget. Les formes (bar_*, line_*, area_*, pie/donut, number) tracent ce que `config` désigne ; les sujets (stat_*, issues_*, cycle_*, intake_*) portent une question déjà fixée.';

-- ────────────────────────────────────────────────────────────────────────────
-- Ce que les widgets Intake ont besoin de savoir
-- ────────────────────────────────────────────────────────────────────────────
/**
 * L'ancienneté et le sort des demandes d'intake.
 *
 * `decided_at` est approché par `updated_at` : la table ne garde pas la date de
 * décision à part, et l'ajouter demanderait de réécrire l'historique existant
 * avec une valeur inventée. `updated_at` la vaut pour toute demande qu'on n'a
 * pas rouverte, ce qui est le cas ordinaire — et le commentaire est là pour que
 * personne ne prenne cette colonne pour une mesure exacte.
 */
create or replace function public.pj_intake_stats(p_dashboard uuid)
returns table (
  intake_id uuid,
  pj_project_id uuid,
  project_name text,
  source text,
  status int,
  created_at timestamptz,
  decided_at timestamptz,
  /** Jours écoulés depuis l'arrivée, ou jusqu'à la décision. */
  age_days int
) language sql stable as $$
  select
    ii.id, ii.pj_project_id, p.name, ii.source, ii.status,
    ii.created_at,
    case when ii.status = -2 then null else ii.updated_at end,
    extract(day from
      coalesce(case when ii.status = -2 then null else ii.updated_at end, now()) - ii.created_at
    )::int
  from public.pj_intake_issues ii
  join public.pj_projects p on p.id = ii.pj_project_id
  where p.dashboard_id = p_dashboard
  order by ii.created_at desc;
$$;

comment on function public.pj_intake_stats is
  'Ancienneté et sort des demandes. `decided_at` approche la décision par updated_at : la table ne la stocke pas à part, et cette valeur la vaut pour toute demande non rouverte.';
