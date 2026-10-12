-- 0277_unified_connections.sql
-- Connexions unifiées (docs/enterprise-generalisation.md, G2).
--
-- Les outils internes déclarés dans l'interface (0267) et les serveurs MCP
-- partagent désormais :
--   · l'identité déléguée (G1) : un outil interne peut être appelé au nom de
--     la personne ET de l'agent (`delegated`), ou avec un contexte utilisateur
--     signé par FounderOS (`signed_context`) ;
--   · le transport par relais : un serveur MCP derrière le pare-feu du client
--     devient joignable depuis le cloud, par le relais qu'il a déployé ;
--   · un environnement (développement, recette, production), que les
--     politiques d'approbation de G3 liront.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Outils internes : identité déléguée et contexte signé, environnement
-- ────────────────────────────────────────────────────────────────────────────
alter table public.custom_connectors drop constraint if exists custom_connectors_auth_scheme_check;
alter table public.custom_connectors add constraint custom_connectors_auth_scheme_check check (auth_scheme in (
  'none', 'bearer', 'api_key', 'basic', 'headers',
  'oauth2_client_credentials', 'oauth2_authorization_code', 'session_login', 'mtls',
  'delegated', 'signed_context'
));

-- delegated : auth_config.audience requis (le client de l'outil auprès de
-- l'IdP, ou api://… chez Entra ID) ; provider facultatif (auth_ref).
alter table public.custom_connectors drop constraint if exists custom_connectors_delegated_config_check;
alter table public.custom_connectors add constraint custom_connectors_delegated_config_check check (
  auth_scheme not in ('delegated', 'signed_context')
  or (
    coalesce(auth_config ->> 'audience', '') ~ '^[A-Za-z0-9._:/-]{1,200}$'
    and coalesce(auth_config ->> 'provider', 'custom:x') ~ '^custom:[a-z0-9][a-z0-9-]{0,40}$'
  )
);

alter table public.custom_connectors
  add column if not exists environment text;
alter table public.custom_connectors drop constraint if exists custom_connectors_environment_check;
alter table public.custom_connectors add constraint custom_connectors_environment_check
  check (environment is null or environment in ('development', 'staging', 'production'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Serveurs MCP : relais, contexte signé, environnement
-- ────────────────────────────────────────────────────────────────────────────
alter table public.mcp_servers
  add column if not exists relay_id uuid references public.connector_relays(id) on delete set null,
  add column if not exists environment text;
alter table public.mcp_servers drop constraint if exists mcp_servers_environment_check;
alter table public.mcp_servers add constraint mcp_servers_environment_check
  check (environment is null or environment in ('development', 'staging', 'production'));

alter table public.mcp_servers drop constraint if exists mcp_servers_auth_mode_check;
alter table public.mcp_servers add constraint mcp_servers_auth_mode_check
  check (auth_mode in ('none', 'header', 'oauth', 'token_exchange', 'signed_context'));

-- token_exchange et signed_context : la même configuration (audience, cluster, fournisseur).
alter table public.mcp_servers drop constraint if exists mcp_servers_token_exchange_config_check;
alter table public.mcp_servers add constraint mcp_servers_token_exchange_config_check
  check (
    auth_mode not in ('token_exchange', 'signed_context')
    or (
      coalesce(auth_config ->> 'audience', '') ~ '^[A-Za-z0-9._:/-]{1,200}$'
      and coalesce(auth_config ->> 'cluster', 'x') ~ '^[a-z0-9-]{1,30}$'
      and coalesce(auth_config ->> 'provider', 'custom:x') ~ '^custom:[a-z0-9][a-z0-9-]{0,40}$'
    )
  );

-- Un serveur et son relais appartiennent au même espace.
create or replace function public.mcp_servers_relay_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.relay_id is not null and not exists (
    select 1 from public.connector_relays r where r.id = new.relay_id and r.workspace_id = new.workspace_id
  ) then
    raise exception 'mcp_relay_workspace: le relais appartient à un autre espace' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_mcp_servers_relay_guard on public.mcp_servers;
create trigger trg_mcp_servers_relay_guard
  before insert or update of relay_id, workspace_id on public.mcp_servers
  for each row execute function public.mcp_servers_relay_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. File du relais : secrets propres à une tâche, chiffrés
-- ────────────────────────────────────────────────────────────────────────────
-- Un jeton délégué (ou un contexte signé) vaut quelques minutes et pour une
-- seule tâche : il n'appartient à aucun profil d'identifiants. Il est mis en
-- file CHIFFRÉ, la requête n'en porte qu'un marqueur {{secret:__x}}, et il est
-- déchiffré au moment où le relais réclame la tâche, puis effacé.
alter table public.connector_relay_jobs
  add column if not exists job_secrets_enc text,
  add column if not exists job_secrets_iv text,
  -- Tâche émise pour un serveur MCP (et non un outil interne).
  add column if not exists mcp_server_id uuid references public.mcp_servers(id) on delete cascade;
