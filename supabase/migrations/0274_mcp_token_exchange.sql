-- 0274_mcp_token_exchange.sql
-- Appel des serveurs MCP au nom de l'utilisateur ET de l'agent (installation
-- dédiée, docs/openshift-implementation.md D2–D3).
--
-- Chaque appel de tool porte un jeton d'appel émis par Keycloak par échange de
-- jeton (RFC 8693) : l'utilisateur en `sub`, l'agent en `azp`, une seule
-- audience (le serveur MCP visé), 5 minutes. Pour l'obtenir, FounderOS doit
-- présenter un jeton Keycloak de l'utilisateur — or la connexion passe par
-- Supabase Auth, qui ne le garde pas. On conserve donc, chiffré, le jeton de
-- rafraîchissement remis au retour du SSO, le temps de la session SSO.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Jetons Keycloak des utilisateurs
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.user_idp_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Fournisseur dans Supabase Auth (« custom:keycloak »).
  provider text not null,
  -- Jeton de rafraîchissement, AES-256-GCM (CREDENTIAL_ENCRYPTION_KEY). Remplacé
  -- à chaque rafraîchissement : Keycloak en fait tourner un nouveau à chaque fois.
  refresh_enc text not null,
  iv text not null,
  -- Empreinte du dernier jeton REMIS PAR LE NAVIGATEUR : une session restaurée
  -- qui le renverrait ne doit pas écraser un jeton plus récent déjà tourné.
  source_hash text,
  -- `sub` Keycloak vérifié au dépôt : le jeton appartient bien à cette personne.
  idp_subject text not null,
  updated_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  primary key (user_id, provider)
);

alter table public.user_idp_tokens enable row level security;
-- Aucune policy : seul le backend (service role) lit et écrit. Le jeton ne
-- repart jamais vers un navigateur.
revoke all on public.user_idp_tokens from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Serveurs MCP authentifiés par échange de jeton
-- ────────────────────────────────────────────────────────────────────────────
-- auth_config : { "audience": "mcp-prd", "cluster": "prd" }
--   audience  client Keycloak du serveur, demandé à l'échange ;
--   cluster   cluster qui l'héberge, pour la pré-décision OPA.
alter table public.mcp_servers
  add column if not exists auth_config jsonb not null default '{}'::jsonb;

alter table public.mcp_servers drop constraint if exists mcp_servers_auth_mode_check;
alter table public.mcp_servers add constraint mcp_servers_auth_mode_check
  check (auth_mode in ('none', 'header', 'oauth', 'token_exchange'));

alter table public.mcp_servers drop constraint if exists mcp_servers_token_exchange_config_check;
alter table public.mcp_servers add constraint mcp_servers_token_exchange_config_check
  check (
    auth_mode <> 'token_exchange'
    or (
      coalesce(auth_config ->> 'audience', '') ~ '^[A-Za-z0-9._:-]{1,100}$'
      and coalesce(auth_config ->> 'cluster', 'x') ~ '^[a-z0-9-]{1,30}$'
    )
  );
