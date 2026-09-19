-- 0248_attention_queue.sql
-- Ce qui, dans tout un service, attend une décision humaine.
--
-- Le travail partagé avec des agents a un point de friction précis : les moments
-- où la machine ne peut plus avancer seule. Ces moments existaient, mais
-- dispersés — une autorisation sur la fiche d'un item, un disjoncteur sur la
-- fiche d'un autre. Pour savoir s'il y avait quelque chose à faire, il fallait
-- ouvrir les items un par un, c'est-à-dire savoir d'avance lesquels regarder.
--
-- Cette fonction les rassemble. Deux familles :
--
--   · 'approval' — un agent a demandé une autorisation sur un work item, et
--     attend. Chaque minute rapproche son run du délai au bout duquel il est
--     déclaré mort ;
--   · 'stalled' — un item armé a échoué trois fois de suite, et l'ordonnanceur a
--     cessé de le relancer (0244). Il ne se passera plus rien sans quelqu'un.
--
-- Pas de `security definer` : la fonction s'exécute avec les droits de
-- l'appelant, donc sous la RLS de `internal_agent_approvals`. Chacun voit
-- exactement les demandes qu'il a le droit de trancher — ni celles d'agents
-- auxquels il n'a pas accès, ni moins.

create or replace function public.pj_attention_queue(p_dashboard uuid)
returns table (
  kind          text,
  ref_id        uuid,
  issue_id      uuid,
  pj_project_id uuid,
  issue_ref     text,
  issue_name    text,
  agent_id      uuid,
  agent_name    text,
  detail        text,
  reason        text,
  since         timestamptz
) language sql stable as $$
  -- Les autorisations en attente, remontées approbation → run → mission → item.
  select 'approval'::text,
         ap.id,
         i.id, i.pj_project_id,
         p.identifier || '-' || i.sequence_id, i.name,
         ap.agent_id, a.name,
         coalesce(ap.payload->>'action', ap.tool_name),
         ap.reason,
         ap.requested_at
  from public.internal_agent_approvals ap
  join public.internal_agent_runs r on r.id = ap.run_id
  join public.internal_agent_missions m on m.id = r.mission_id
  join public.pj_issues i on i.id = m.pj_issue_id
  join public.pj_projects p on p.id = i.pj_project_id
  left join public.internal_agents a on a.id = ap.agent_id
  where ap.status = 'pending'
    and p.dashboard_id = p_dashboard
    and i.archived_at is null

  union all

  -- Les items armés que le disjoncteur a mis en pause. Même règle qu'en 0244 :
  -- les trois derniers runs TERMINÉS ont tous échoué.
  select 'stalled'::text,
         i.id,
         i.id, i.pj_project_id,
         p.identifier || '-' || i.sequence_id, i.name,
         last_run.agent_id, a.name,
         last_run.error_message,
         null::text,
         last_run.created_at
  from public.pj_issues i
  join public.pj_projects p on p.id = i.pj_project_id
  join lateral (
    select r.agent_id, r.error_message, r.created_at
    from public.internal_agent_missions m
    join public.internal_agent_runs r on r.mission_id = m.id
    where m.pj_issue_id = i.id and r.status in ('succeeded', 'failed')
    order by r.created_at desc
    limit 1
  ) last_run on true
  left join public.internal_agents a on a.id = last_run.agent_id
  where p.dashboard_id = p_dashboard
    and i.agent_autorun
    and i.completed_at is null
    and i.archived_at is null
    and (
      select count(*) = 3 and bool_and(last3.status = 'failed')
      from (
        select r.status
        from public.internal_agent_missions m
        join public.internal_agent_runs r on r.mission_id = m.id
        where m.pj_issue_id = i.id and r.status in ('succeeded', 'failed')
        order by r.created_at desc
        limit 3
      ) last3
    )

  -- Le plus ancien d'abord : c'est celui qui attend depuis le plus longtemps,
  -- et, pour une autorisation, celui dont le run est le plus près d'expirer.
  order by 11 asc;
$$;

comment on function public.pj_attention_queue is
  'Ce qui attend une décision humaine dans un service : autorisations d''agents en attente sur des work items, et items armés mis en pause après trois échecs.';
