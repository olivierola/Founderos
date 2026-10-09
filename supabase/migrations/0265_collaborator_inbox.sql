-- 0265_collaborator_inbox.sql
-- « À valider » : tout ce que les collaborateurs d'un service attendent d'un humain.
--
-- Ces moments existaient, mais dispersés, et plusieurs n'arrivaient nulle part :
--
--   · une autorisation demandée hors d'un chat (room, mission planifiée, échange
--     entre collaborateurs) répondait « approuve-la depuis le chat direct » — où
--     aucun bouton ne l'attendait ;
--   · une question posée pendant un workflow ou une procédure lancée à la main
--     n'avait ni conversation ni room : personne ne pouvait y répondre ;
--   · un livrable produit par une mission planifiée n'était vu que si l'on allait
--     le chercher ;
--   · une mission planifiée qui échouait ne le disait qu'à l'AI HQ, en agrégat.
--
-- pj_attention_queue (0248) couvre déjà les autorisations liées à des work items,
-- sur l'accueil du module Travail. Celle-ci couvre TOUS les collaborateurs du
-- service, quelle que soit l'origine de la demande.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Le statut « paused » des missions
-- ────────────────────────────────────────────────────────────────────────────
-- propose_mission, le réflexe d'initiative de fin de run (proactivity.ts) et
-- delegate_mission vers un service « sur demande » écrivent tous status='paused'
-- — une mission déposée au backlog, qui ne tourne pas tant qu'un humain ne l'a
-- pas lancée. La contrainte de 0025 ne connaissait que draft/active/archived :
-- les trois écritures échouaient (12 appels à propose_mission, 12 échecs au
-- 2026-10-07), et le canal d'initiative des collaborateurs n'a jamais rien livré.
--
-- Sans risque pour l'exécution : l'ordonnanceur ne lit que status='active'.
alter table public.internal_agent_missions
  drop constraint if exists internal_agent_missions_status_check;
alter table public.internal_agent_missions
  add constraint internal_agent_missions_status_check
  check (status in ('draft', 'active', 'paused', 'archived'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Ce que chacun a écarté de SA boîte
-- ────────────────────────────────────────────────────────────────────────────
-- Personnel, et seulement pour ce qui ne bloque personne : une question restée
-- sans objet, un livrable lu, un échec déjà compris. Une autorisation ne s'écarte
-- pas — elle se tranche. Une proposition non plus : l'écarter l'archive pour tout
-- le service, ce qui est une décision sur la mission elle-même.
create table if not exists public.sd_inbox_dismissals (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('question', 'deliverable', 'failed')),
  ref_id       uuid not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, kind, ref_id)
);

alter table public.sd_inbox_dismissals enable row level security;

drop policy if exists sd_inbox_dismissals_own on public.sd_inbox_dismissals;
create policy sd_inbox_dismissals_own on public.sd_inbox_dismissals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────────
-- 3. La boîte
-- ────────────────────────────────────────────────────────────────────────────
-- Pas de `security definer` : la fonction lit sous la RLS de l'appelant, donc
-- chacun ne voit que les demandes des collaborateurs auxquels il a accès.
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
    -- Les autorisations en attente, d'où qu'elles viennent.
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

    -- Les questions restées sans réponse. Une question est dépassée dès que la
    -- conversation, la mission ou la room a repris après elle.
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

    -- Les missions déposées au backlog en attendant qu'un humain les lance :
    -- les initiatives d'un collaborateur, et ce qu'un autre service lui délègue.
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

    -- Ce qu'une mission a produit sans personne devant : pas de conversation,
    -- pas de room. Ce qui est né dans un chat a déjà été vu là.
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

    -- Les missions planifiées dont la DERNIÈRE exécution a échoué : personne ne
    -- regardait, et la prochaine échouera sans doute pour la même raison.
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

comment on function public.sd_collaborator_inbox is
  'Ce que les collaborateurs d''un service attendent d''un humain : autorisations, questions sans réponse, missions proposées, livrables produits sans témoin, missions planifiées en échec.';
