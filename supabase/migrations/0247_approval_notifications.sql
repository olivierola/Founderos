-- 0247_approval_notifications.sql
-- Prévenir quand un agent attend une autorisation sur un work item.
--
-- Une demande d'autorisation ne s'affichait que dans le chat de l'agent et dans
-- les rooms — là où l'on regarde quand on a soi-même lancé la machine. Pour un
-- agent planifié qui travaille seul, personne ne regarde : le run attendait,
-- l'ordonnanceur le déclarait mort au bout de trente minutes, et trois échecs
-- plus tard le disjoncteur (0244) coupait l'item. Rien, dans tout ce parcours,
-- ne passait devant les yeux d'un humain.
--
-- La fiche du work item montre désormais ces demandes. Mais il faut y être
-- déjà : la cloche, elle, vient chercher la personne.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Un type de notification de plus
-- ────────────────────────────────────────────────────────────────────────────
-- La contrainte est inline en 0222, donc nommée par Postgres
-- `pj_notifications_kind_check`. On la remplace en gardant tous les types
-- existants : en oublier un ferait échouer l'ALTER sur les lignes déjà là.
alter table public.pj_notifications
  drop constraint if exists pj_notifications_kind_check;

alter table public.pj_notifications
  add constraint pj_notifications_kind_check
  check (kind in ('assigned', 'mentioned', 'commented', 'state', 'subscribed', 'approval'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Le déclencheur
-- ────────────────────────────────────────────────────────────────────────────
-- Remonte le fil approbation → run → mission → work item. Une approbation qui
-- ne mène à aucun item (conversation, mission hors suivi) ne notifie rien ici :
-- elle a déjà sa place dans le chat, et la dupliquer dans la cloche du module
-- de travail n'aurait aucun lien à ouvrir.
--
-- DESTINATAIRES : les abonnés de l'item (créateur, assignés, commentateurs),
-- PLUS la personne qui a lancé la mission si elle n'en fait pas partie. C'est
-- souvent la première concernée — elle a confié le travail — et rien ne garantit
-- qu'elle suive l'item.
create or replace function public.pj_notify_approval_requested()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_issue      uuid;
  v_workspace  uuid;
  v_issue_name text;
  v_launcher   uuid;
  v_agent_name text;
  v_title      text;
begin
  if new.status <> 'pending' or new.run_id is null then
    return new;
  end if;

  select m.pj_issue_id, m.created_by
    into v_issue, v_launcher
  from public.internal_agent_runs r
  join public.internal_agent_missions m on m.id = r.mission_id
  where r.id = new.run_id;

  if v_issue is null then return new; end if;

  select i.name, i.workspace_id into v_issue_name, v_workspace
  from public.pj_issues i where i.id = v_issue;

  select a.name into v_agent_name from public.internal_agents a where a.id = new.agent_id;

  v_title := coalesce(v_agent_name, 'Un agent') || ' attend votre autorisation sur '
             || coalesce(v_issue_name, 'un work item');

  perform public.pj_notify_subscribers(v_issue, null, 'approval', v_title, coalesce(new.reason, ''));

  if v_launcher is not null and not exists (
    select 1 from public.pj_issue_subscribers s
    where s.issue_id = v_issue and s.user_id = v_launcher
  ) then
    insert into public.pj_notifications (workspace_id, issue_id, user_id, actor_id, kind, title, body)
    values (v_workspace, v_issue, v_launcher, null, 'approval', v_title, coalesce(new.reason, ''));
  end if;

  return new;
exception when others then
  -- Une notification ratée ne doit JAMAIS empêcher la demande d'autorisation
  -- d'exister : sans elle, l'agent ne peut même plus attendre qu'on tranche.
  -- Contrairement à 0242, rien d'autre n'est fait dans ce bloc qu'on
  -- regretterait de voir annulé — seules les notifications sautent.
  return new;
end $$;

drop trigger if exists trg_pj_notify_approval on public.internal_agent_approvals;
create trigger trg_pj_notify_approval
  after insert on public.internal_agent_approvals
  for each row execute function public.pj_notify_approval_requested();
