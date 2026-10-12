-- 0285_mcp_token_push.sql
-- Jeton tournant des serveurs MCP : le serveur change son jeton à chaque
-- période et l'envoie lui-même à FounderOS (connector-action, mode mcp.token_push),
-- en présentant comme preuve le jeton que FounderOS détient déjà.
--
-- Pour retrouver la ligne sans déchiffrer tous les jetons : l'empreinte
-- SHA-256 du jeton enregistré. Un jeton de 256 bits ne se retrouve pas depuis
-- son empreinte. Les lignes d'avant cette migration reçoivent la leur à la
-- première livraison (le backend déchiffre et calcule).

alter table public.mcp_server_secrets
  add column if not exists token_sha256 text
    check (token_sha256 is null or token_sha256 ~ '^[0-9a-f]{64}$');

create index if not exists mcp_server_secrets_token_sha256_idx
  on public.mcp_server_secrets (token_sha256);

-- Ce que l'écran montre : quand le jeton a été reçu, et comment (saisi, ou
-- livré par le serveur).
alter table public.mcp_servers
  add column if not exists token_received_at timestamptz,
  add column if not exists token_origin text
    check (token_origin is null or token_origin in ('manual', 'push'));

-- La garde de 0278, qui efface le jeton quand la destination change, efface
-- aussi ces deux colonnes.
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
    new.token_received_at := null;
    new.token_origin := null;
  end if;
  return new;
end;
$$;
