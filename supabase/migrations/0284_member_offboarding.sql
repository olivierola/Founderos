-- 0284_member_offboarding.sql
-- Version allégée de G6 (provisioning) : ce qu'un départ doit couper tout de
-- suite, sans annuaire SCIM (docs/enterprise-generalisation.md, G6).
--
-- Le SSO règle l'entrée et le rôle À LA CONNEXION. Trois trous restaient :
--   1. un membre retiré (par un admin, ou par le SSO faute de groupe reconnu)
--      gardait ses demandes d'approbation en attente, ses jetons IdP conservés
--      pour les agents (0274), ses rôles et groupes relevés (0275, 0281), et ses
--      sessions s'il n'appartenait plus à aucune organisation ;
--   2. une voix donnée avant son départ comptait encore dans un quorum (0281) ;
--   3. pour une approbation validée par FounderOS (et non relue dans un jeton
--      frais de l'IdP), les groupes dataient de la dernière connexion.
-- Les sessions elles-mêmes sont bornées dans l'Auth (supabase/config.toml,
-- [auth.sessions]) : un départ dans l'IdP prend effet en quelques heures.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Le journal des départs
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.member_offboarding_log (
  id bigserial primary key,
  workspace_id uuid not null,
  user_id uuid not null,
  role text,
  managed_by text,
  approvals_withdrawn integer not null default 0,
  idp_tokens_deleted integer not null default 0,
  idp_roles_cleared integer not null default 0,
  sessions_revoked integer not null default 0,
  at timestamptz not null default now()
);

create index if not exists member_offboarding_log_ws on public.member_offboarding_log (workspace_id, at desc);

alter table public.member_offboarding_log enable row level security;
revoke all on public.member_offboarding_log from anon, authenticated;
grant select on public.member_offboarding_log to authenticated;

drop policy if exists "member_offboarding_log: admins read" on public.member_offboarding_log;
create policy "member_offboarding_log: admins read"
on public.member_offboarding_log for select
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Ce qu'un départ coupe
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.member_offboard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refs text[];
  v_approvals integer := 0;
  v_tokens integer := 0;
  v_roles integer := 0;
  v_sessions integer := 0;
begin
  if old.user_id is null or old.workspace_id is null then
    return old;
  end if;

  -- Ses demandes en attente dans cette organisation : retirées, plus personne
  -- ne peut les approuver au nom de quelqu'un qui est parti.
  update public.internal_agent_approvals
     set status = 'rejected', decided_at = now(),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object('withdrawn', 'demandeur retiré de l''organisation')
   where workspace_id = old.workspace_id and requested_by = old.user_id and status = 'pending';
  get diagnostics v_approvals = row_count;

  -- Les fournisseurs SSO de cette organisation : leurs jetons conservés pour la
  -- délégation (0274), les rôles et groupes relevés (0275, 0281).
  select coalesce(array_agg(p.auth_ref), '{}') into v_refs
    from public.enterprise_sso_providers p where p.workspace_id = old.workspace_id;
  if array_length(v_refs, 1) > 0 then
    delete from public.user_idp_tokens where user_id = old.user_id and provider = any (v_refs);
    get diagnostics v_tokens = row_count;
    delete from public.user_idp_roles
     where user_id = old.user_id
       and (provider = any (v_refs) or provider = any (array(select 'sso-groups:' || r from unnest(v_refs) r)));
    get diagnostics v_roles = row_count;
  end if;

  -- Plus aucune organisation : plus aucune session. (Membre d'autres
  -- organisations : la RLS lui ferme déjà celle-ci, ses sessions restent.)
  if not exists (select 1 from public.workspace_members m where m.user_id = old.user_id) then
    begin
      delete from auth.sessions where user_id = old.user_id;
      get diagnostics v_sessions = row_count;
    exception when insufficient_privilege or undefined_table then
      v_sessions := 0; -- Auth hébergée qui n'ouvre pas son schéma : les bornes de session s'en chargent
    end;
  end if;

  insert into public.member_offboarding_log
    (workspace_id, user_id, role, managed_by, approvals_withdrawn, idp_tokens_deleted, idp_roles_cleared, sessions_revoked)
  values (old.workspace_id, old.user_id, old.role, old.managed_by, v_approvals, v_tokens, v_roles, v_sessions);
  return old;
end;
$$;

revoke all on function public.member_offboard() from public, anon, authenticated;

drop trigger if exists trg_member_offboard on public.workspace_members;
create trigger trg_member_offboard
  after delete on public.workspace_members
  for each row execute function public.member_offboard();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Une voix ne compte que si son auteur est encore membre
-- ────────────────────────────────────────────────────────────────────────────
-- Même garde que 0281 ; seul le compte des voix change.
create or replace function public.guard_quorum_approval()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  if tg_op = 'INSERT' then
    if new.quorum is not null and new.status <> 'pending' then
      raise exception 'approval_quorum_insert: une demande soumise à une règle naît en attente' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.quorum is null then
    if new.quorum is not null then
      raise exception 'approval_quorum_immutable: une règle ne s''ajoute pas après coup' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.payload is distinct from old.payload
     or new.action_kind is distinct from old.action_kind
     or new.requested_by is distinct from old.requested_by
     or new.expires_at is distinct from old.expires_at
     or new.agent_id is distinct from old.agent_id
     or new.workspace_id is distinct from old.workspace_id
     or new.quorum is distinct from old.quorum
     or new.approver_rule is distinct from old.approver_rule
     or new.policy_name is distinct from old.policy_name
     or new.environment is distinct from old.environment
     or (new.policy_id is distinct from old.policy_id and new.policy_id is not null) then
    raise exception 'approval_quorum_immutable: une demande soumise à une règle ne se modifie pas' using errcode = 'check_violation';
  end if;

  if old.status = 'pending' and new.status = 'approved' then
    if new.decided_by is null or new.decided_by = old.requested_by then
      raise exception 'approval_quorum_four_eyes: l''approbation finale revient à un autre approbateur que le demandeur' using errcode = 'check_violation';
    end if;
    if old.expires_at <= now() then
      raise exception 'approval_quorum_expired: la demande a expiré' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.internal_agent_approval_votes v where v.approval_id = old.id and v.user_id = new.decided_by) then
      raise exception 'approval_quorum_voter: l''approbation finale revient à un votant' using errcode = 'check_violation';
    end if;
    -- Seules les voix de membres actuels de l'organisation (0284).
    select count(*) into n from public.internal_agent_approval_votes v
     where v.approval_id = old.id and v.user_id is distinct from old.requested_by
       and exists (select 1 from public.workspace_members m where m.workspace_id = old.workspace_id and m.user_id = v.user_id);
    if n < old.quorum then
      raise exception 'approval_quorum_missing: % approbation(s) sur % requises', n, old.quorum using errcode = 'check_violation';
    end if;
  end if;

  if old.status <> 'pending' and new.status = 'pending' then
    raise exception 'approval_quorum_status: une demande décidée ne repasse pas en attente' using errcode = 'check_violation';
  end if;
  if old.status = 'pending' and new.status in ('executed', 'failed') then
    raise exception 'approval_quorum_status: une demande s''approuve avant de s''exécuter' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Connexion SSO récente exigée pour voter (réglable par règle)
-- ────────────────────────────────────────────────────────────────────────────
-- Les groupes d'un approbateur sont relus à chaque connexion SSO. Pour une
-- approbation validée par FounderOS, une règle peut exiger une connexion de
-- moins de N minutes : ses groupes sont alors à jour, et un départ dans l'IdP
-- l'empêche de voter. Copié sur la demande dans approver_rule.fresh_login_minutes.
alter table public.approval_policies
  add column if not exists fresh_login_minutes integer check (fresh_login_minutes is null or fresh_login_minutes between 1 and 10080);
