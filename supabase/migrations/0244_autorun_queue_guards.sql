-- 0244_autorun_queue_guards.sql
-- Deux garde-fous qui manquaient à la file de travail autonome (0242).
--
-- 1. UN ITEM ANNULÉ ÉTAIT RELANCÉ. La file ne regardait que `completed_at is
--    null`. Or `pj_sync_completed_at` (0221) ne pose `completed_at` que pour le
--    groupe « completed » : un item ANNULÉ garde `completed_at` à null. Annuler
--    un item armé ne l'arrêtait donc pas — l'agent s'y remettait toutes les
--    trente minutes, sur une tâche que quelqu'un venait justement d'abandonner.
--
-- 2. UN ÉCHEC SE REJOUAIT SANS FIN. Un run qui échoue laisse l'item ouvert ; le
--    délai passé, la file le relançait, qui échouait à nouveau, et ainsi de
--    suite. Sur une tâche que l'agent ne sait pas faire — un brief ambigu, un
--    outil manquant, un accès refusé — c'était une dépense sans plafond pour un
--    résultat certain.
--
--    Le disjoncteur : trois échecs consécutifs et l'item sort de la file. Il n'est
--    pas désarmé pour autant — `agent_autorun` reste vrai — parce qu'un échec se
--    corrige souvent en réécrivant le brief : dès qu'un run réussit, ou qu'on
--    relance à la main, le compteur repart. Trois et non un, parce qu'un échec
--    isolé est souvent passager (délai réseau, fournisseur saturé) et qu'une
--    tâche légitime ne doit pas s'arrêter au premier hoquet.

create or replace function public.pj_agent_autorun_queue(
  p_cooldown interval default interval '30 minutes',
  p_limit int default 5
)
returns table (
  issue_id      uuid,
  agent_id      uuid,
  pj_project_id uuid,
  workspace_id  uuid,
  project_id    uuid,
  issue_name    text,
  issue_ref     text,
  brief         text,
  description   text
) language sql stable as $$
  select distinct on (i.id)
         i.id, ia.agent_id, i.pj_project_id, i.workspace_id, p.project_id,
         i.name, p.identifier || '-' || i.sequence_id,
         i.agent_brief, i.description_text
  from public.pj_issues i
  join public.pj_projects p on p.id = i.pj_project_id
  join public.pj_issue_agents ia on ia.issue_id = i.id
  join public.pj_project_agents pa
    on pa.pj_project_id = i.pj_project_id
   and pa.agent_id = ia.agent_id
   and pa.role <> 'observer'
  join public.internal_agents a
    on a.id = ia.agent_id
   and a.is_archived = false
   and a.mission_enabled = true
  -- L'état COURANT de l'item. Jointure à gauche : un item sans état (rare, mais
  -- la colonne est nullable) reste éligible plutôt que de disparaître en silence.
  left join public.pj_states st on st.id = i.state_id
  where i.agent_autorun
    and i.completed_at is null
    and i.archived_at is null
    -- (1) Terminé OU annulé : dans les deux cas, il n'y a plus rien à faire.
    and coalesce(st."group", 'backlog') not in ('completed', 'cancelled')
    and nullif(btrim(i.agent_brief), '') is not null
    and (i.start_date is null or i.start_date <= current_date)
    and (i.agent_last_run_at is null or i.agent_last_run_at < now() - p_cooldown)
    and not exists (
      select 1
      from public.internal_agent_missions m
      join public.internal_agent_runs r on r.mission_id = m.id
      where m.pj_issue_id = i.id and r.status in ('queued', 'running')
    )
    -- (2) Le disjoncteur : les trois DERNIERS runs terminés de cet item ont tous
    -- échoué. « Terminés » seulement — un run annulé à la main n'est pas un
    -- échec de l'agent, et le compter ferait sauter le disjoncteur pour une
    -- décision humaine.
    and not (
      select count(*) = 3 and bool_and(last3.status = 'failed')
      from (
        select r.status
        from public.internal_agent_missions m
        join public.internal_agent_runs r on r.mission_id = m.id
        where m.pj_issue_id = i.id
          and r.status in ('succeeded', 'failed')
        order by r.created_at desc
        limit 3
      ) last3
    )
  order by i.id, ia.created_at asc
  limit p_limit;
$$;

comment on function public.pj_agent_autorun_queue is
  'Les work items qu''un agent assigné peut prendre en charge seul : armés, briefés, échus, ni terminés ni annulés, avec un agent autorisé en écriture, rien qui tourne déjà, et moins de trois échecs d''affilée.';
