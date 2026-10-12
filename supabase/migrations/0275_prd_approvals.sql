-- 0275_prd_approvals.sql
-- Approbation des actions en production (installation dédiée,
-- docs/openshift-implementation.md D6).
--
-- Un serveur MCP de PRD répond `approval_required` à une action d'écriture
-- (redémarrer un déploiement, poser un silence). FounderOS enregistre alors une
-- demande `mcp_tool`. Une AUTRE personne, détentrice du rôle Keycloak
-- ai-ops-prd-approver, la valide sous 15 minutes. FounderOS signe ensuite un
-- jeton d'approbation lié à l'action exacte, et rejoue l'appel avec.
--
-- Les règles sont tenues par l'endpoint internal-agent-approve. On les inscrit
-- aussi ici, pour qu'aucun chemin, même service role, ne les contourne :
-- la règle des quatre yeux, l'expiration et une demande non modifiable.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Rôles Keycloak connus de FounderOS
-- ────────────────────────────────────────────────────────────────────────────
-- Relevés dans chaque jeton d'accès Keycloak émis pour la personne : au retour
-- du SSO, puis à chaque rafraîchissement (_shared/idp-tokens.ts). Ils servent à
-- VOIR les demandes et à prévenir les approbateurs. La décision, elle, relit le
-- rôle dans un jeton frais : un rôle retiré dans Keycloak ne vaut plus, même si
-- cette table est en retard. La ligne survit à la déconnexion, contrairement au
-- jeton (0274) : un approbateur déconnecté reste un approbateur à prévenir.
create table if not exists public.user_idp_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  roles text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.user_idp_roles enable row level security;
revoke all on public.user_idp_roles from anon, authenticated;

create or replace function public.has_idp_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_idp_roles r
     where r.user_id = auth.uid()
       and p_role = any (r.roles)
  );
$$;

revoke all on function public.has_idp_role(text) from public;
grant execute on function public.has_idp_role(text) to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Demandes d'approbation : type mcp_tool, demandeur, échéance
-- ────────────────────────────────────────────────────────────────────────────
alter table public.internal_agent_approvals
  add column if not exists requested_by uuid references auth.users(id) on delete set null,
  add column if not exists expires_at timestamptz;

comment on column public.internal_agent_approvals.requested_by is
  'La personne pour qui l''agent agissait (mcp_tool). Elle ne peut pas approuver sa propre demande.';
comment on column public.internal_agent_approvals.expires_at is
  'Au-delà, la demande ne peut plus être approuvée (mcp_tool : 15 minutes).';

alter table public.internal_agent_approvals
  drop constraint if exists internal_agent_approvals_action_kind_check;
alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_action_kind_check check (
    action_kind in (
      'edge_function', 'webhook', 'connector_action', 'composio_action',
      'crm_write', 'tracker_write', 'custom_connector', 'mcp_tool'
    )
  );

alter table public.internal_agent_approvals
  drop constraint if exists internal_agent_approvals_status_check;
alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_status_check
  check (status in ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired'));

-- payload d'une demande mcp_tool :
--   { server_id, server_name, tool, args, params, params_hash, target_cluster,
--     audience, requester_sub, message }
alter table public.internal_agent_approvals
  drop constraint if exists internal_agent_approvals_mcp_tool_check;
alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_mcp_tool_check check (
    action_kind <> 'mcp_tool'
    or (
      expires_at is not null
      and coalesce(payload ->> 'server_id', '') <> ''
      and coalesce(payload ->> 'tool', '') ~ '^[a-z0-9_]{1,64}$'
      and coalesce(payload ->> 'params_hash', '') ~ '^[0-9a-f]{64}$'
      and coalesce(payload ->> 'target_cluster', '') ~ '^[a-z0-9-]{1,30}$'
      and coalesce(payload ->> 'requester_sub', '') <> ''
    )
  );

create index if not exists idx_internal_agent_approvals_mcp_pending
  on public.internal_agent_approvals (workspace_id, requested_at desc)
  where action_kind = 'mcp_tool' and status = 'pending';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Garde-fous en base
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_mcp_approval()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.action_kind <> 'mcp_tool' then
    return new;
  end if;

  -- L'action approuvée est celle qui a été demandée, et rien d'autre.
  if new.payload is distinct from old.payload
     or new.action_kind is distinct from old.action_kind
     or new.requested_by is distinct from old.requested_by
     or new.expires_at is distinct from old.expires_at
     or new.agent_id is distinct from old.agent_id
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'mcp_tool_immutable: une demande d''approbation PRD ne se modifie pas'
      using errcode = 'check_violation';
  end if;

  if old.status = 'pending' and new.status = 'approved' then
    if new.decided_by is null then
      raise exception 'mcp_tool_approver_required: une approbation PRD a un approbateur'
        using errcode = 'check_violation';
    end if;
    if new.decided_by = old.requested_by then
      raise exception 'mcp_tool_four_eyes: le demandeur ne peut pas approuver sa propre demande'
        using errcode = 'check_violation';
    end if;
    if old.expires_at <= now() then
      raise exception 'mcp_tool_expired: la demande a expiré'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Une demande ne repasse jamais en attente, et une décision ne se rejoue pas.
  if old.status <> 'pending' and new.status = 'pending' then
    raise exception 'mcp_tool_status: une demande décidée ne repasse pas en attente'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_mcp_approval on public.internal_agent_approvals;
create trigger trg_guard_mcp_approval
  before update on public.internal_agent_approvals
  for each row execute function public.guard_mcp_approval();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Les approbateurs voient les demandes PRD de leur espace
-- ────────────────────────────────────────────────────────────────────────────
-- En plus de la policy existante (accès à l'agent) : un approbateur n'est pas
-- forcément membre de l'agent qui demande.
drop policy if exists "PRD approvers read PRD approvals" on public.internal_agent_approvals;
create policy "PRD approvers read PRD approvals"
on public.internal_agent_approvals for select
using (
  action_kind = 'mcp_tool'
  and public.has_idp_role('ai-ops-prd-approver')
  and public.is_workspace_member(workspace_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Expiration
-- ────────────────────────────────────────────────────────────────────────────
-- La décision vérifie déjà l'échéance. Ce passage, chaque minute, sert à
-- l'affichage et à l'agent qui attend : une demande expirée le dit.
create or replace function public.expire_mcp_approvals()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.internal_agent_approvals
     set status = 'expired',
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object('expired_at', now())
   where action_kind = 'mcp_tool'
     and status = 'pending'
     and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.expire_mcp_approvals() from public;

do $$ begin perform cron.unschedule('expire-mcp-approvals'); exception when others then null; end $$;
do $$
begin
  perform cron.schedule('expire-mcp-approvals', '* * * * *', 'select public.expire_mcp_approvals();');
exception when invalid_schema_name or undefined_function then
  raise notice 'pg_cron absent : expire_mcp_approvals() n''est pas planifiée';
end $$;
