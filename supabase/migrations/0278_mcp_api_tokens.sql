-- 0278_mcp_api_tokens.sql
-- Jeton d'API d'un serveur MCP : le mode d'authentification par défaut des
-- serveurs internes (docs/enterprise-generalisation.md, « Modèle simplifié »).
--
-- À l'installation, l'exploitant génère un jeton sur le serveur MCP (qui n'en
-- garde que l'empreinte) et le colle dans FounderOS. FounderOS le garde
-- CHIFFRÉ, dans une table que seul le backend lit, et le présente à chaque
-- appel d'un agent, avec la personne et l'agent pour l'audit.

alter table public.mcp_servers drop constraint if exists mcp_servers_auth_mode_check;
alter table public.mcp_servers add constraint mcp_servers_auth_mode_check
  check (auth_mode in ('none', 'header', 'oauth', 'token_exchange', 'signed_context', 'api_token'));

-- De quoi reconnaître le jeton enregistré sans le lire : « mcpt_ab12cd34…x9Qz ».
alter table public.mcp_servers
  add column if not exists token_hint text check (token_hint is null or length(token_hint) <= 40);

-- api_token : l'audience est facultative (elle ne sert qu'aux approbations,
-- c'est le MCP_AUDIENCE du serveur), le cluster aussi.
alter table public.mcp_servers drop constraint if exists mcp_servers_api_token_config_check;
alter table public.mcp_servers add constraint mcp_servers_api_token_config_check
  check (
    auth_mode <> 'api_token'
    or (
      coalesce(auth_config ->> 'audience', 'x') ~ '^[A-Za-z0-9._:/-]{1,200}$'
      and coalesce(auth_config ->> 'cluster', 'x') ~ '^[a-z0-9-]{1,30}$'
    )
  );

create table if not exists public.mcp_server_secrets (
  server_id uuid primary key references public.mcp_servers(id) on delete cascade,
  token_enc text not null,
  token_iv text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.mcp_server_secrets enable row level security;
-- Aucune policy : le jeton ne se lit ni ne s'écrit depuis un navigateur.
revoke all on public.mcp_server_secrets from anon, authenticated;

-- Le jeton est lié à sa destination. Le jeton part vers l'URL de la ligne, et
-- tout membre de l'espace peut modifier cette ligne (0119) : sans ce garde, il
-- suffirait de remplacer l'URL par la sienne pour recevoir le jeton au prochain
-- appel d'un agent. Si l'origine de l'URL (schéma, hôte, port), le relais,
-- l'espace ou le mode changent, le jeton enregistré est effacé : il faut le
-- ressaisir, donc le détenir. Un changement de chemin seul est permis (même
-- serveur ; mcp-gateway corrige lui-même /sse ↔ /mcp).
create or replace function public.mcp_servers_api_token_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  origin_re constant text := '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+';
begin
  if new.auth_mode is distinct from 'api_token'
     or new.relay_id is distinct from old.relay_id
     or new.workspace_id is distinct from old.workspace_id
     or lower(substring(new.url from origin_re)) is distinct from lower(substring(old.url from origin_re))
  then
    delete from public.mcp_server_secrets where server_id = new.id;
    new.token_hint := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mcp_servers_api_token_guard on public.mcp_servers;
create trigger trg_mcp_servers_api_token_guard
  before update of url, relay_id, workspace_id, auth_mode on public.mcp_servers
  for each row execute function public.mcp_servers_api_token_guard();
