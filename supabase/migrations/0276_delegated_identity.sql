-- 0276_delegated_identity.sql
-- Identité déléguée pour tout fournisseur d'identité (docs/enterprise-generalisation.md, G1).
--
-- Un agent qui appelle un outil le fait au nom d'une personne : l'IdP de
-- l'entreprise émet un jeton court pour cet outil, qui porte la personne ET
-- l'agent. Jusqu'ici, seul Keycloak était prévu, réglé par variables
-- d'environnement (KEYCLOAK_*, AGENT_IDP_CLIENTS). La délégation se règle
-- désormais dans l'interface, sur le fournisseur SSO lui-même :
--
--   · token_exchange  RFC 8693 : Keycloak, Okta, Ping, Auth0…
--   · entra_obo       On-Behalf-Of d'Entra ID (jwt-bearer, requested_token_use)
--
-- Les variables d'environnement restent un repli : une installation déjà
-- réglée ainsi (SCIC) continue de fonctionner sans rien changer.
--
-- Les secrets (secret du client du portail, secrets des clients des agents)
-- sont chiffrés par le backend (AES-256-GCM, CREDENTIAL_ENCRYPTION_KEY) et ne
-- s'écrivent que par sso-admin : aucune policy d'écriture, aucune lecture des
-- colonnes chiffrées côté client.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. La délégation, sur le fournisseur
-- ────────────────────────────────────────────────────────────────────────────
alter table public.enterprise_sso_providers
  add column if not exists delegation text not null default 'none',
  -- Point de jeton de l'IdP, lu dans son document de découverte à l'enregistrement.
  add column if not exists token_endpoint text,
  -- Claim qui identifie la personne de façon stable : `sub` en général, `oid`
  -- chez Entra ID (dont le `sub` change d'une application à l'autre).
  add column if not exists subject_claim text not null default 'sub';

alter table public.enterprise_sso_providers drop constraint if exists enterprise_sso_providers_delegation_check;
alter table public.enterprise_sso_providers add constraint enterprise_sso_providers_delegation_check
  check (
    delegation in ('none', 'token_exchange', 'entra_obo')
    and subject_claim in ('sub', 'oid')
    and (
      delegation = 'none'
      -- Pas de {1,500} : Postgres borne les répétitions à 255.
      or (protocol = 'oidc' and length(coalesce(token_endpoint, '')) <= 500 and coalesce(token_endpoint, '') ~ '^https?://[^[:space:]]+$')
    )
  );

comment on column public.enterprise_sso_providers.delegation is
  'none, token_exchange (RFC 8693) ou entra_obo : comment l''IdP émet un jeton au nom d''une personne pour un outil.';

-- Le secret du client utilisé par Supabase Auth : il faut le même client pour
-- rafraîchir le jeton de la personne. L'Auth le garde pour elle ; on en garde
-- une copie chiffrée, seulement si la délégation est activée.
create table if not exists public.enterprise_sso_provider_secrets (
  provider_id uuid primary key references public.enterprise_sso_providers(id) on delete cascade,
  secret_enc text not null,
  iv text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.enterprise_sso_provider_secrets enable row level security;
revoke all on public.enterprise_sso_provider_secrets from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. L'identité de chaque agent auprès de l'IdP
-- ────────────────────────────────────────────────────────────────────────────
-- Un client de l'IdP par agent : ses propres limites (scopes, audiences
-- permises), qui s'ajoutent à celles de la personne.
create table if not exists public.agent_idp_identities (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.internal_agents(id) on delete cascade,
  provider_id uuid not null references public.enterprise_sso_providers(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id text not null check (client_id ~ '^[A-Za-z0-9._:/@-]{1,200}$'),
  secret_enc text not null,
  iv text not null,
  -- Entra ID : la portée du jeton de la personne adressé à l'agent, avant
  -- l'On-Behalf-Of (ex. api://<application de l'agent>/.default).
  user_scope text check (user_scope is null or (length(user_scope) <= 300 and user_scope ~ '^[A-Za-z0-9._:/ -]+$')),
  secret_hint text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, provider_id)
);

create index if not exists agent_idp_identities_workspace_idx on public.agent_idp_identities(workspace_id);

alter table public.agent_idp_identities enable row level security;

drop policy if exists "agent_idp_identities: admins read" on public.agent_idp_identities;
create policy "agent_idp_identities: admins read"
on public.agent_idp_identities for select
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

revoke all on public.agent_idp_identities from anon, authenticated;
-- Jamais les colonnes chiffrées.
grant select (id, agent_id, provider_id, workspace_id, client_id, user_scope, secret_hint, created_by, created_at, updated_at)
  on public.agent_idp_identities to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Un serveur MCP peut nommer le fournisseur qui délègue
-- ────────────────────────────────────────────────────────────────────────────
-- auth_config : { audience, cluster?, provider? } — provider = auth_ref du
-- fournisseur (« custom:entra »). Absent : le seul fournisseur qui délègue.
alter table public.mcp_servers drop constraint if exists mcp_servers_token_exchange_config_check;
alter table public.mcp_servers add constraint mcp_servers_token_exchange_config_check
  check (
    auth_mode <> 'token_exchange'
    or (
      coalesce(auth_config ->> 'audience', '') ~ '^[A-Za-z0-9._:/-]{1,200}$'
      and coalesce(auth_config ->> 'cluster', 'x') ~ '^[a-z0-9-]{1,30}$'
      and coalesce(auth_config ->> 'provider', 'custom:x') ~ '^custom:[a-z0-9][a-z0-9-]{0,40}$'
    )
  );
