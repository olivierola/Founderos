-- 0269_collaborator_goals.sql
-- Objectifs permanents : un collaborateur qui veille sur un résultat, pas sur
-- une tâche.
--
-- « Garder plus de 20 leads qualifiés dans le pipeline. » Ce n'est pas une
-- mission qui finit : c'est un résultat à tenir. La couche Entreprise (0212)
-- savait déjà le dire — company_objectives porte la métrique, la cible, le sens,
-- la valeur mesurée et le collaborateur porteur — mais personne ne le
-- surveillait : une mesure n'arrivait que si quelqu'un pensait à la demander.
--
-- Trois ajouts :
--   1. une VEILLE sur l'objectif : une cadence et une consigne, portées par une
--      mission planifiée du collaborateur porteur ; à chaque passage il mesure
--      avec ses outils, enregistre la mesure, et agit (dans les limites de son
--      autonomie) ou propose des missions si l'objectif n'est pas tenu ;
--   2. l'ÉCART est calculé par le code au moment où la mesure est enregistrée
--      (outil company_objectives, action measure) : status passe à 'at_risk',
--      et revient à 'active' quand l'objectif est de nouveau tenu. Jev ne
--      compare pas des nombres ; le code, si ;
--   3. la boîte « À valider » montre un objectif en écart — une seule fois par
--      mesure : écarté, il revient à la mesure suivante s'il est toujours en
--      écart.

alter table public.company_objectives
  add column if not exists watch_cadence text
    check (watch_cadence is null or watch_cadence in ('hourly', 'daily', 'weekly')),
  add column if not exists watch_mission_id uuid references public.internal_agent_missions(id) on delete set null,
  -- Comment mesurer, et quoi faire en cas d'écart : écrit par la personne.
  add column if not exists watch_instructions text;

alter table public.sd_inbox_dismissals
  drop constraint if exists sd_inbox_dismissals_kind_check;
alter table public.sd_inbox_dismissals
  add constraint sd_inbox_dismissals_kind_check
  check (kind in ('question', 'deliverable', 'failed', 'trust', 'goal'));

-- Même fonction qu'en 0266, plus la famille « goal ».
create or replace function public.sd_collaborator_inbox(p_dashboard uuid)
returns table (
  kind               text,
  ref_id             uuid,
  agent_id           uuid,
  agent_name         text,
  agent_avatar_url   text,
  agent_avatar_style text,
  agent_accent       text,
  title              text,
  body               text,
  meta               jsonb,
  conversation_id    uuid,
  run_id             uuid,
  mission_id         uuid,
  room_id            uuid,
  since              timestamptz
) language sql stable as $$
  with agents as (
    select a.id, a.name, a.avatar_url, a.avatar_style, a.accent_color
    from public.internal_agents a
    where a.service_dashboard_id = p_dashboard
      and coalesce(a.is_archived, false) = false
  ),
  items as (
    select 'approval'::text as kind, ap.id as ref_id, ap.agent_id,
           ap.tool_name as title, ap.reason as body,
           jsonb_build_object('action_kind', ap.action_kind, 'payload', ap.payload) as meta,
           ap.conversation_id, ap.run_id, ap.mission_id,
           (select m.room_id from public.service_room_messages m where m.run_id = ap.run_id limit 1) as room_id,
           ap.requested_at as since
    from public.internal_agent_approvals ap
    join agents a on a.id = ap.agent_id
    where ap.status = 'pending'

    union all

    select 'question', r.id, r.agent_id,
           r.pending_question->>'question', null,
           jsonb_build_object(
             'options', coalesce(r.pending_question->'options', '[]'::jsonb),
             'triggered_via', r.triggered_via
           ),
           r.conversation_id, r.id, r.mission_id,
           (select m.room_id from public.service_room_messages m where m.run_id = r.id limit 1),
           coalesce(r.finished_at, r.created_at)
    from public.internal_agent_runs r
    join agents a on a.id = r.agent_id
    where r.status = 'awaiting_input'
      and r.pending_question is not null
      and coalesce(r.finished_at, r.created_at) > now() - interval '30 days'
      and not (r.conversation_id is not null and exists (
        select 1 from public.internal_agent_runs r2
        where r2.conversation_id = r.conversation_id and r2.created_at > r.created_at
      ))
      and not (r.conversation_id is not null and exists (
        select 1 from public.internal_agent_messages um
        where um.conversation_id = r.conversation_id and um.role = 'user'
          and um.created_at > coalesce(r.finished_at, r.created_at)
      ))
      and not (r.mission_id is not null and exists (
        select 1 from public.internal_agent_runs r2
        where r2.mission_id = r.mission_id and r2.created_at > r.created_at
      ))
      and not exists (
        select 1
        from public.service_room_messages qm
        join public.service_room_messages um
          on um.room_id = qm.room_id and um.author_kind = 'user' and um.created_at > qm.created_at
        where qm.run_id = r.id
      )

    union all

    select 'proposal', m.id, m.agent_id,
           m.title, m.brief,
           jsonb_build_object(
             'proposed_by', m.delegated_by_agent,
             'proposed_by_name', pa.name,
             'self', m.delegated_by_agent = m.agent_id
           ),
           null::uuid, null::uuid, m.id, null::uuid,
           m.created_at
    from public.internal_agent_missions m
    join agents a on a.id = m.agent_id
    left join public.internal_agents pa on pa.id = m.delegated_by_agent
    where m.status = 'paused'
      and m.board_column = 'backlog'
      and m.delegated_by_agent is not null

    union all

    select 'deliverable', d.id, d.agent_id,
           d.name, d.summary,
           jsonb_build_object('kind', d.kind, 'triggered_via', r.triggered_via),
           null::uuid, d.run_id, d.mission_id, null::uuid,
           d.created_at
    from public.internal_agent_deliverables d
    join agents a on a.id = d.agent_id
    join public.internal_agent_runs r on r.id = d.run_id
    where d.created_at > now() - interval '7 days'
      and r.conversation_id is null
      and r.mission_id is not null
      and coalesce(r.is_ephemeral, false) = false
      and not exists (select 1 from public.service_room_messages m where m.run_id = r.id)

    union all

    select 'failed', last_run.id, m.agent_id,
           m.title, last_run.error_message,
           jsonb_build_object('triggered_via', last_run.triggered_via),
           null::uuid, last_run.id, m.id, null::uuid,
           coalesce(last_run.finished_at, last_run.created_at)
    from public.internal_agent_missions m
    join agents a on a.id = m.agent_id
    join lateral (
      select r.id, r.status, r.error_message, r.triggered_via, r.finished_at, r.created_at
      from public.internal_agent_runs r
      where r.mission_id = m.id and r.status in ('succeeded', 'failed')
      order by r.created_at desc
      limit 1
    ) last_run on true
    where m.status = 'active'
      and last_run.status = 'failed'
      and last_run.triggered_via = 'schedule'
      and coalesce(last_run.finished_at, last_run.created_at) > now() - interval '7 days'

    union all

    -- La confiance que le collaborateur a méritée.
    select 'trust', md5(c.agent_id::text || ':' || c.scope)::uuid, c.agent_id,
           c.scope, null,
           jsonb_build_object('tool', c.tool, 'action', c.action, 'scope', c.scope, 'approved', c.approved),
           null::uuid, null::uuid, null::uuid, null::uuid,
           c.last_at
    from public.agent_trust_candidates(p_dashboard) c

    union all

    -- Un objectif porté par un collaborateur du service, en écart à sa dernière
    -- mesure. Le ref_id change à chaque mesure : écarté, il revient si la
    -- suivante est toujours en écart.
    select 'goal', md5(o.id::text || ':' || coalesce(o.measured_at::text, ''))::uuid, o.owner_agent_id,
           o.title, o.measured_note,
           jsonb_build_object(
             'objective_id', o.id, 'metric', o.metric, 'unit', o.unit,
             'current', o.current_value, 'target', o.target_value, 'direction', o.direction,
             'measured_by', o.measured_by, 'watched', o.watch_cadence is not null
           ),
           null::uuid, null::uuid, o.watch_mission_id, null::uuid,
           coalesce(o.measured_at, o.updated_at)
    from public.company_objectives o
    join agents a on a.id = o.owner_agent_id
    where o.status = 'at_risk'
  )
  select i.kind, i.ref_id, i.agent_id,
         a.name, a.avatar_url, a.avatar_style, a.accent_color,
         i.title, i.body, i.meta,
         i.conversation_id, i.run_id, i.mission_id, i.room_id, i.since
  from items i
  join agents a on a.id = i.agent_id
  where not exists (
    select 1 from public.sd_inbox_dismissals x
    where x.user_id = auth.uid() and x.kind = i.kind and x.ref_id = i.ref_id
  )
  order by i.since desc;
$$;
