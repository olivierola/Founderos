-- 0268_collaborator_triggers.sql
-- « Quand… alors » : un collaborateur qui se met au travail sur un événement.
--
-- Jusqu'ici un collaborateur ne démarrait que sur un message ou une horloge. Les
-- workflows, eux, savaient déjà écouter une application connectée (0198) :
-- abonnement Composio, journal de livraison qui déduplique, filtre évalué AVANT
-- de lancer quoi que ce soit. On réutilise tout cela en ajoutant une seconde
-- cible au même registre : un collaborateur, avec la consigne de ce qu'il doit
-- faire. Chaque déclencheur porte sa mission (une seule, réutilisée à chaque
-- événement), et chaque événement lance une exécution de cette mission avec
-- l'événement joint.
--
-- Et des événements INTERNES, qu'aucun webhook n'apporte : un enregistrement CRM
-- créé, un work item créé, une demande client ouverte. Un déclencheur de base les
-- dépose dans une file (seulement si quelqu'un les écoute), et l'ordonnanceur la
-- vide chaque minute par le même routage que les événements Composio.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Une exécution peut naître d'un événement, et le porte
-- ────────────────────────────────────────────────────────────────────────────
alter table public.internal_agent_runs
  drop constraint if exists internal_agent_runs_triggered_via_check;
alter table public.internal_agent_runs
  add constraint internal_agent_runs_triggered_via_check
  check (triggered_via in ('manual', 'schedule', 'api', 'chat', 'event'));

alter table public.internal_agent_runs
  add column if not exists trigger_payload jsonb;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Le registre des abonnements accepte un collaborateur comme cible
-- ────────────────────────────────────────────────────────────────────────────
alter table public.agent_workflow_triggers
  alter column workflow_id drop not null;
alter table public.agent_workflow_triggers
  add column if not exists agent_id uuid references public.internal_agents(id) on delete cascade,
  add column if not exists mission_id uuid references public.internal_agent_missions(id) on delete set null,
  -- « Quand un client écrit au support » : ce que la personne a voulu dire.
  add column if not exists label text,
  -- Un orage d'événements (un canal Slack bavard) ne doit pas vider un forfait :
  -- au-delà, les livraisons de l'heure sont journalisées « skipped ».
  add column if not exists hourly_cap int not null default 20 check (hourly_cap between 1 and 500);

alter table public.agent_workflow_triggers
  drop constraint if exists agent_workflow_triggers_target_check;
alter table public.agent_workflow_triggers
  add constraint agent_workflow_triggers_target_check
  check ((workflow_id is null) <> (agent_id is null));

create index if not exists idx_wf_triggers_agent on public.agent_workflow_triggers(agent_id) where agent_id is not null;

alter table public.workflow_event_deliveries
  alter column workflow_id drop not null;
alter table public.workflow_event_deliveries
  add column if not exists agent_id uuid references public.internal_agents(id) on delete cascade,
  add column if not exists agent_run_id uuid references public.internal_agent_runs(id) on delete set null;
create index if not exists idx_wf_deliveries_agent
  on public.workflow_event_deliveries(agent_id, received_at desc) where agent_id is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Les événements internes
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.collab_event_queue (
  id                bigserial primary key,
  workspace_id      uuid not null,
  project_id        uuid not null,
  event_slug        text not null,
  external_event_id text not null,
  payload           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  processed_at      timestamptz,
  result            jsonb
);
create index if not exists idx_collab_event_queue_pending
  on public.collab_event_queue(created_at) where processed_at is null;
-- Service seulement : la file ne se lit ni ne s'écrit depuis le navigateur.
alter table public.collab_event_queue enable row level security;

-- Ne dépose un événement que si un déclencheur actif l'écoute dans ce projet :
-- sinon la file grossirait de chaque fiche CRM créée, pour personne.
create or replace function public.enqueue_founderos_event(
  p_workspace uuid, p_project uuid, p_slug text, p_ref text, p_payload jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_workspace is null or p_project is null then return; end if;
  if not exists (
    select 1 from public.agent_workflow_triggers t
    where t.provider = 'founderos' and t.event_slug = p_slug
      and t.project_id = p_project and t.status = 'active'
  ) then
    return;
  end if;
  insert into public.collab_event_queue (workspace_id, project_id, event_slug, external_event_id, payload)
  values (p_workspace, p_project, p_slug, p_ref, coalesce(p_payload, '{}'::jsonb));
end;
$$;

-- Les trois déclencheurs de base ne doivent JAMAIS faire échouer l'écriture
-- qu'ils observent : une fiche CRM refusée parce que la file l'est serait pire
-- que l'événement perdu.
create or replace function public.trg_founderos_crm_record_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.enqueue_founderos_event(
      new.workspace_id, new.project_id, 'CRM_RECORD_CREATED', new.id::text,
      jsonb_build_object(
        'record_id', new.id,
        'objet', (select coalesce(o.label, o.slug) from public.crm_objects o where o.id = new.object_id),
        'donnees', new.data
      )
    );
  exception when others then null;
  end;
  return new;
end;
$$;

drop trigger if exists founderos_crm_record_created on public.crm_records;
create trigger founderos_crm_record_created
  after insert on public.crm_records
  for each row execute function public.trg_founderos_crm_record_created();

create or replace function public.trg_founderos_work_item_created()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_ident   text;
begin
  begin
    if new.is_draft then return new; end if;
    select p.project_id, p.identifier into v_project, v_ident
    from public.pj_projects p where p.id = new.pj_project_id;
    perform public.enqueue_founderos_event(
      new.workspace_id, v_project, 'WORK_ITEM_CREATED', new.id::text,
      jsonb_build_object(
        'issue_id', new.id,
        'reference', coalesce(v_ident, 'ITEM') || '-' || new.sequence_id,
        'titre', new.name,
        'description', left(coalesce(new.description_text, ''), 2000),
        'priorite', new.priority
      )
    );
  exception when others then null;
  end;
  return new;
end;
$$;

drop trigger if exists founderos_work_item_created on public.pj_issues;
create trigger founderos_work_item_created
  after insert on public.pj_issues
  for each row execute function public.trg_founderos_work_item_created();

create or replace function public.trg_founderos_support_ticket_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.enqueue_founderos_event(
      new.workspace_id, new.project_id, 'SUPPORT_TICKET_CREATED', new.id::text,
      jsonb_build_object(
        'ticket_id', new.id,
        'intention', coalesce(new.intent_label, new.intent),
        'urgence', new.urgency,
        'besoin_humain', new.needs_human,
        'premier_message', left(coalesce(new.first_message, ''), 2000),
        'source', new.source
      )
    );
  exception when others then null;
  end;
  return new;
end;
$$;

drop trigger if exists founderos_support_ticket_created on public.resolve_tickets;
create trigger founderos_support_ticket_created
  after insert on public.resolve_tickets
  for each row execute function public.trg_founderos_support_ticket_created();
