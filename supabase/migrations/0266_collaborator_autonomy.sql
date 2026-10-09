-- 0266_collaborator_autonomy.sql
-- Le niveau d'autonomie d'un collaborateur, et la confiance qu'il gagne.
--
-- Jusqu'ici, rien ne disait ce qu'un collaborateur avait le droit de faire seul :
-- `autopilot` était figé à false dans le runtime, et seuls les templates portaient
-- un niveau (advisor/assisted/autopilot) traduit en `requires_approval` sur leurs
-- outils, sans plus jamais être relisible.
--
-- Quatre niveaux, appliqués par PolicyGuard (policyguard.ts), qui reste la seule
-- porte des actions sensibles :
--
--   · observer   — lit, analyse, rédige des livrables ; n'écrit JAMAIS dans les
--                  outils connectés (règle de code, sans jugement) ;
--   · propose    — chaque écriture passe par une validation humaine ;
--   · assisted   — le comportement d'avant (défaut) ;
--   · autonomous — dispensé de validation SOUS le plafond de l'équipe, et
--                  seulement quand Jev a noté le risque de l'action (usage
--                  `policy_guard` en mode on). Sans ce jugement, il demande
--                  comme en assisté : l'autonomie ne s'accorde pas à l'aveugle.
--
-- La confiance acquise (`agent_trust_grants`) est une autonomie limitée à UN type
-- d'action — « Gmail : envoyer un e-mail » — accordée après plusieurs validations
-- humaines sans refus. Mêmes garde-fous : jugement Jev requis, plafond de
-- l'équipe, jamais pour une action irréversible.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Le niveau
-- ────────────────────────────────────────────────────────────────────────────
alter table public.internal_agents
  add column if not exists autonomy_level text not null default 'assisted';

alter table public.internal_agents
  drop constraint if exists internal_agents_autonomy_level_check;
alter table public.internal_agents
  add constraint internal_agents_autonomy_level_check
  check (autonomy_level in ('observer', 'propose', 'assisted', 'autonomous'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Le type d'action, tel que PolicyGuard le voit
-- ────────────────────────────────────────────────────────────────────────────
-- outil:action, normalisés. MIROIR de `trustScope()` dans policyguard.ts : les
-- deux doivent rendre la même chaîne, sinon une confiance accordée ici ne serait
-- jamais reconnue au moment d'agir.
create or replace function public.agent_trust_scope(p_tool text, p_action text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(p_tool, '')), '[^a-z0-9]+', '_', 'g')
      || ':'
      || regexp_replace(lower(coalesce(p_action, '')), '[^a-z0-9]+', '_', 'g');
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. La confiance accordée
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.agent_trust_grants (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references public.internal_agents(id) on delete cascade,
  scope          text not null,
  tool           text not null,
  action         text not null,
  -- Combien de validations humaines l'avaient précédée : la preuve, gardée.
  approvals_seen int not null default 0,
  granted_by     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (agent_id, scope)
);

alter table public.agent_trust_grants enable row level security;

drop policy if exists agent_trust_grants_read on public.agent_trust_grants;
create policy agent_trust_grants_read on public.agent_trust_grants
  for select using (public.has_internal_agent_access(agent_id, auth.uid()));
drop policy if exists agent_trust_grants_insert on public.agent_trust_grants;
create policy agent_trust_grants_insert on public.agent_trust_grants
  for insert with check (public.has_internal_agent_access(agent_id, auth.uid()));
drop policy if exists agent_trust_grants_delete on public.agent_trust_grants;
create policy agent_trust_grants_delete on public.agent_trust_grants
  for delete using (public.has_internal_agent_access(agent_id, auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Les candidats : ce qu'un humain a validé plusieurs fois, sans jamais refuser
-- ────────────────────────────────────────────────────────────────────────────
-- Seules comptent les décisions HUMAINES (decided_by, ou une décision venue de
-- Slack/Teams) : les exécutions automatiques d'un « tout autoriser » laissent
-- aussi une ligne, sans personne derrière. Fenêtre de 60 jours, au moins trois
-- validations, aucun refus. Seuls les collaborateurs en « assisté » sont
-- concernés : en « proposer », la personne a choisi de tout voir ; en
-- « autonome », c'est déjà couvert.
--
-- Les webhooks et Vibe Code ne passent pas par PolicyGuard : une confiance sur
-- eux ne changerait rien, on ne la propose pas.
create or replace function public.agent_trust_candidates(p_dashboard uuid)
returns table (
  agent_id uuid,
  scope    text,
  tool     text,
  action   text,
  approved int,
  last_at  timestamptz
) language sql stable as $$
  with raw as (
    select ap.agent_id, ap.status, ap.decided_at,
           case ap.action_kind
             when 'composio_action'  then ap.payload->>'toolkit'
             when 'connector_action' then ap.payload->>'provider'
             when 'crm_write'        then 'crm'
             when 'tracker_write'    then 'tracker'
             when 'edge_function'    then ap.tool_name
           end as tool,
           case ap.action_kind
             when 'composio_action'  then ap.payload->>'tool_slug'
             when 'connector_action' then ap.payload->>'action'
             when 'crm_write'        then ap.payload->>'action'
             when 'tracker_write'    then ap.payload->>'action'
             when 'edge_function'    then ap.payload->>'slug'
           end as action
    from public.internal_agent_approvals ap
    join public.internal_agents a on a.id = ap.agent_id
    where a.service_dashboard_id = p_dashboard
      and a.autonomy_level = 'assisted'
      and coalesce(a.is_archived, false) = false
      and ap.action_kind in ('composio_action', 'connector_action', 'crm_write', 'tracker_write', 'edge_function')
      and ap.tool_name is distinct from 'vibe_code'
      and ap.status in ('approved', 'executed', 'failed', 'rejected')
      and (ap.decided_by is not null or ap.result ? 'decided_via')
      and ap.decided_at > now() - interval '60 days'
  ),
  decided as (
    select r.*, public.agent_trust_scope(r.tool, r.action) as scope
    from raw r
    where r.tool is not null and r.action is not null
  )
  select d.agent_id, d.scope,
         min(d.tool), min(d.action),
         count(*) filter (where d.status <> 'rejected')::int,
         max(d.decided_at)
  from decided d
  where not exists (
    select 1 from public.agent_trust_grants g
    where g.agent_id = d.agent_id and g.scope = d.scope
  )
  group by d.agent_id, d.scope
  having count(*) filter (where d.status <> 'rejected') >= 3
     and count(*) filter (where d.status = 'rejected') = 0;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. La boîte « À valider » propose la confiance
-- ────────────────────────────────────────────────────────────────────────────
alter table public.sd_inbox_dismissals
  drop constraint if exists sd_inbox_dismissals_kind_check;
alter table public.sd_inbox_dismissals
  add constraint sd_inbox_dismissals_kind_check
  check (kind in ('question', 'deliverable', 'failed', 'trust'));

-- Même fonction qu'en 0265, plus la famille « trust ». Son ref_id est dérivé de
-- (collaborateur, type d'action) : stable d'un appel à l'autre, donc écartable.
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
