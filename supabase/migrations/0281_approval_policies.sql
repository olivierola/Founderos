-- 0281_approval_policies.sql
-- G3 : les approbations deviennent des règles que chaque entreprise écrit
-- (docs/enterprise-generalisation.md, G3).
--
-- PolicyGuard (policyguard_policies) décide déjà S'IL faut une approbation :
-- niveau de risque, grille par équipe, autopilote. Une règle d'approbation dit
-- QUI approuve, COMBIEN de personnes et en COMBIEN de temps, pour une portée :
-- type de connexion, connexion, environnement, risque, opérations.
--   - Serveur MCP : le serveur décide lui-même de demander (OPA, catalogue) ;
--     la règle fixe les approbateurs, le quorum et l'échéance.
--   - Outil interne (0267) : FounderOS exécute l'appel, la règle peut donc aussi
--     IMPOSER l'approbation pour sa portée (jamais la retirer).
-- Sans règle : le comportement d'avant (MCP : rôle IdP ai-ops-prd-approver,
-- 1 approbateur, 15 minutes ; outil interne : la décision d'un éditeur de l'agent).
--
-- Une demande soumise à une règle en garde une COPIE (approbateurs, quorum,
-- échéance) : changer la règle ensuite ne change pas une demande en cours.
-- Chaque approbation est un vote (internal_agent_approval_votes). La base
-- refuse le passage à « approuvée » tant que le quorum n'est pas atteint, et
-- la règle des quatre yeux vaut pour chaque vote.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Les règles
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.approval_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  enabled boolean not null default true,
  -- La plus petite passe d'abord ; à priorité égale, la plus précise.
  priority integer not null default 100 check (priority between 0 and 1000),
  -- Portée. NULL ou liste vide : tout.
  connection_kind text check (connection_kind in ('mcp', 'custom_connector')),
  connection_id uuid,
  environment text check (environment in ('development', 'staging', 'production')),
  min_risk text not null default 'write' check (min_risk in ('write', 'destructive')),
  operations text[] not null default '{}',
  -- Approbateurs : un rôle FounderOS dans l'espace, OU un rôle ou groupe de l'IdP.
  approver_roles text[] not null default '{}',
  approver_idp_roles text[] not null default '{}',
  quorum smallint not null default 1 check (quorum between 1 and 5),
  ttl_minutes integer not null default 15 check (ttl_minutes between 1 and 1440),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approval_policies_connection_check check (connection_id is null or connection_kind is not null),
  constraint approval_policies_approvers_check check (cardinality(approver_roles) + cardinality(approver_idp_roles) > 0),
  constraint approval_policies_roles_check check (approver_roles <@ array['owner', 'admin', 'member']::text[]),
  constraint approval_policies_idp_roles_check check (
    cardinality(approver_idp_roles) <= 20
    and array_position(approver_idp_roles, '') is null
    and length(array_to_string(approver_idp_roles, '')) <= 2000
  ),
  constraint approval_policies_operations_check check (
    cardinality(operations) <= 50
    and array_to_string(operations, ' ') !~ '[^A-Za-z0-9_.:/ -]'
    and array_position(operations, '') is null
  )
);

create index if not exists idx_approval_policies_workspace on public.approval_policies (workspace_id) where enabled;

alter table public.approval_policies enable row level security;

drop policy if exists "approval_policies: members read" on public.approval_policies;
create policy "approval_policies: members read"
on public.approval_policies for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "approval_policies: admins write" on public.approval_policies;
create policy "approval_policies: admins write"
on public.approval_policies for all
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. La copie de la règle sur la demande
-- ────────────────────────────────────────────────────────────────────────────
alter table public.internal_agent_approvals
  add column if not exists policy_id uuid references public.approval_policies(id) on delete set null,
  add column if not exists policy_name text,
  add column if not exists quorum smallint check (quorum is null or quorum between 1 and 5),
  add column if not exists approver_rule jsonb,
  add column if not exists environment text check (environment is null or environment in ('development', 'staging', 'production'));

comment on column public.internal_agent_approvals.quorum is
  'Nombre d''approbateurs distincts requis (G3). NULL : la décision unique d''avant.';
comment on column public.internal_agent_approvals.approver_rule is
  'Copie des approbateurs de la règle : { "roles": [...], "idp_roles": [...] }.';

alter table public.internal_agent_approvals drop constraint if exists internal_agent_approvals_quorum_check;
alter table public.internal_agent_approvals add constraint internal_agent_approvals_quorum_check check (
  quorum is null
  or (
    expires_at is not null
    and jsonb_typeof(approver_rule -> 'roles') = 'array'
    and jsonb_typeof(approver_rule -> 'idp_roles') = 'array'
    and jsonb_array_length(approver_rule -> 'roles') + jsonb_array_length(approver_rule -> 'idp_roles') > 0
  )
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Les votes
-- ────────────────────────────────────────────────────────────────────────────
-- Écrits par l'endpoint d'approbation seul (rôle de service), après avoir
-- vérifié que la personne est un approbateur de la règle, dans un jeton frais.
create table if not exists public.internal_agent_approval_votes (
  approval_id uuid not null references public.internal_agent_approvals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- L'identité de l'approbateur telle que le serveur MCP la verra (IdP ou FounderOS).
  idp_sub text not null check (length(idp_sub) between 1 and 300),
  created_at timestamptz not null default now(),
  primary key (approval_id, user_id),
  -- Deux comptes FounderOS ne valent pas deux voix s'ils sont une même personne pour l'IdP.
  unique (approval_id, idp_sub)
);

alter table public.internal_agent_approval_votes enable row level security;
revoke insert, update, delete on public.internal_agent_approval_votes from anon, authenticated;

-- Visibles de qui voit la demande (la RLS de la sous-requête est celle de la personne).
drop policy if exists "approval votes: read with the approval" on public.internal_agent_approval_votes;
create policy "approval votes: read with the approval"
on public.internal_agent_approval_votes for select
using (exists (select 1 from public.internal_agent_approvals a where a.id = approval_id));

create or replace function public.guard_approval_vote()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  a public.internal_agent_approvals;
begin
  if tg_op = 'UPDATE' then
    raise exception 'approval_vote_immutable: un vote ne se modifie pas' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    -- Seule la suppression de la demande (cascade) emporte ses votes.
    if exists (select 1 from public.internal_agent_approvals where id = old.approval_id) then
      raise exception 'approval_vote_immutable: un vote ne se retire pas' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  select * into a from public.internal_agent_approvals where id = new.approval_id;
  if not found or a.quorum is null then
    raise exception 'approval_vote_no_quorum: cette demande ne se décide pas par votes' using errcode = 'check_violation';
  end if;
  if a.status <> 'pending' then
    raise exception 'approval_vote_closed: la demande n''est plus en attente' using errcode = 'check_violation';
  end if;
  if a.expires_at <= now() then
    raise exception 'approval_vote_expired: la demande a expiré' using errcode = 'check_violation';
  end if;
  if new.user_id = a.requested_by then
    raise exception 'approval_vote_four_eyes: le demandeur ne vote pas sur sa propre demande' using errcode = 'check_violation';
  end if;
  if new.idp_sub = coalesce(a.payload ->> 'requester_sub', '') then
    raise exception 'approval_vote_four_eyes: cette identité est celle du demandeur' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_approval_vote on public.internal_agent_approval_votes;
create trigger trg_guard_approval_vote
  before insert or update or delete on public.internal_agent_approval_votes
  for each row execute function public.guard_approval_vote();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Garde des demandes soumises à une règle
-- ────────────────────────────────────────────────────────────────────────────
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

  -- La copie de la règle et l'action sont celles de la demande, et rien d'autre.
  -- (policy_id peut passer à NULL : la règle a été supprimée, la copie reste.)
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
    select count(*) into n from public.internal_agent_approval_votes v
     where v.approval_id = old.id and v.user_id is distinct from old.requested_by;
    if n < old.quorum then
      raise exception 'approval_quorum_missing: % approbation(s) sur % requises', n, old.quorum using errcode = 'check_violation';
    end if;
  end if;

  if old.status <> 'pending' and new.status = 'pending' then
    raise exception 'approval_quorum_status: une demande décidée ne repasse pas en attente' using errcode = 'check_violation';
  end if;
  -- Exécutée ou échouée : seulement après l'approbation (le chemin ci-dessus).
  if old.status = 'pending' and new.status in ('executed', 'failed') then
    raise exception 'approval_quorum_status: une demande s''approuve avant de s''exécuter' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_quorum_approval on public.internal_agent_approvals;
create trigger trg_guard_quorum_approval
  before insert or update on public.internal_agent_approvals
  for each row execute function public.guard_quorum_approval();

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Qui voit une demande soumise à une règle : ses approbateurs
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.can_review_approval(p_workspace uuid, p_rule jsonb)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_workspace_member(p_workspace)
     and (
       coalesce(public.workspace_role(p_workspace), '') in (select jsonb_array_elements_text(coalesce(p_rule -> 'roles', '[]'::jsonb)))
       or exists (
         select 1 from public.user_idp_roles r
          where r.user_id = auth.uid()
            and r.roles && array(select jsonb_array_elements_text(coalesce(p_rule -> 'idp_roles', '[]'::jsonb)))
       )
     );
$$;

revoke all on function public.can_review_approval(uuid, jsonb) from public;
grant execute on function public.can_review_approval(uuid, jsonb) to authenticated;

drop policy if exists "Approvers read policy approvals" on public.internal_agent_approvals;
create policy "Approvers read policy approvals"
on public.internal_agent_approvals for select
using (quorum is not null and public.can_review_approval(workspace_id, approver_rule));

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Les groupes SSO, relevés à chaque connexion
-- ────────────────────────────────────────────────────────────────────────────
-- Une règle peut nommer un groupe de l'IdP (« Ops »). Le SSO de l'interface lit
-- déjà les groupes à chaque connexion (0272) pour en déduire le rôle FounderOS ;
-- on les garde aussi dans user_idp_roles, sous une clé à part, pour la RLS
-- ci-dessus et pour l'identité des approbateurs.
create or replace function public.sso_record_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider public.enterprise_sso_providers;
  v_path text[];
  v_claim jsonb;
  v_values text[] := '{}';
begin
  if new.provider not like 'custom:%' and new.provider not like 'sso:%' then
    return new;
  end if;
  begin
    select p.* into v_provider from public.enterprise_sso_providers p
     where p.enabled and (p.auth_ref = new.provider or 'sso:' || p.auth_ref = new.provider)
     limit 1;
    if not found then
      return new;
    end if;
    v_path := string_to_array(v_provider.groups_claim, '.');
    v_claim := coalesce(new.identity_data #> v_path, new.identity_data -> 'custom_claims' #> v_path);
    if jsonb_typeof(v_claim) = 'array' then
      v_values := array(select jsonb_array_elements_text(v_claim));
    elsif jsonb_typeof(v_claim) = 'string' then
      v_values := array[v_claim #>> '{}'];
    end if;
    insert into public.user_idp_roles (user_id, provider, roles, updated_at)
    values (new.user_id, 'sso-groups:' || v_provider.auth_ref, coalesce(v_values[1:100], '{}'), now())
    on conflict (user_id, provider) do update set roles = excluded.roles, updated_at = now();
  exception when others then
    raise warning 'sso_record_groups (%): %', new.provider, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.sso_record_groups() from public, anon, authenticated;

do $$
begin
  drop trigger if exists on_auth_identity_sso_groups on auth.identities;
  create trigger on_auth_identity_sso_groups
  after insert or update on auth.identities
  for each row execute function public.sso_record_groups();
exception when insufficient_privilege or undefined_table then
  raise warning 'on_auth_identity_sso_groups non créé : les groupes SSO ne seront pas relevés pour les approbations.';
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Expiration
-- ────────────────────────────────────────────────────────────────────────────
-- Même tâche planifiée (0275), étendue aux demandes soumises à une règle.
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
   where (action_kind = 'mcp_tool' or quorum is not null)
     and status = 'pending'
     and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.expire_mcp_approvals() from public;
