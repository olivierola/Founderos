-- 0279_mcp_server_guards.sql
-- Qui peut modifier un serveur MCP, et ce que deviennent ses secrets OAuth
-- quand sa destination change.
--
-- Jusqu'ici (0119), tout membre de l'espace, lecteur compris, pouvait modifier
-- n'importe quel serveur : son URL comme ses points de terminaison OAuth. Or
-- les jetons OAuth enregistrés (mcp_oauth_secrets) partent vers l'URL à chaque
-- appel, et le refresh token et le client secret vers le token_endpoint à
-- chaque rafraîchissement. Changer l'un ou l'autre suffisait à les recevoir.
--
-- 1. Les droits, alignés sur les outils internes (0267), sans casser les
--    parcours où un membre crée un serveur pour son agent :
--      lecture                     : tout membre ;
--      création                    : propriétaire, admin, membre (plus les lecteurs) ;
--      modification et suppression : propriétaire, admin, ou le membre qui a créé le serveur.
-- 2. Les secrets OAuth sont liés à leur destination, comme le jeton d'API (0278) :
--    origine de l'URL, relais, espace, mode, et les points de terminaison déjà
--    fixés (autorisation, jeton, enregistrement, ressource, client_id). Si l'un
--    change, les secrets sont effacés et la connexion est à refaire. Fixer un
--    point de terminaison qui ne l'était pas encore (première découverte) ne
--    compte pas : aucun jeton n'a encore été émis pour lui.

-- Le créateur, renseigné d'office : les écrans qui créent un serveur ne le
-- passent pas.
alter table public.mcp_servers alter column created_by set default auth.uid();

drop policy if exists "members manage mcp_servers" on public.mcp_servers;

drop policy if exists "mcp_servers: members read" on public.mcp_servers;
create policy "mcp_servers: members read"
on public.mcp_servers for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "mcp_servers: members create" on public.mcp_servers;
create policy "mcp_servers: members create"
on public.mcp_servers for insert
with check (
  public.workspace_role(workspace_id) in ('owner', 'admin')
  or (public.workspace_role(workspace_id) = 'member' and created_by = auth.uid())
);

drop policy if exists "mcp_servers: admins or creator update" on public.mcp_servers;
create policy "mcp_servers: admins or creator update"
on public.mcp_servers for update
using (
  public.workspace_role(workspace_id) in ('owner', 'admin')
  or (public.workspace_role(workspace_id) = 'member' and created_by = auth.uid())
)
with check (
  public.workspace_role(workspace_id) in ('owner', 'admin')
  or (public.workspace_role(workspace_id) = 'member' and created_by = auth.uid())
);

drop policy if exists "mcp_servers: admins or creator delete" on public.mcp_servers;
create policy "mcp_servers: admins or creator delete"
on public.mcp_servers for delete
using (
  public.workspace_role(workspace_id) in ('owner', 'admin')
  or (public.workspace_role(workspace_id) = 'member' and created_by = auth.uid())
);

create or replace function public.mcp_servers_oauth_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  origin_re constant text := '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+';
  k text;
  moved boolean;
begin
  if old.auth_mode is distinct from 'oauth'
     and not exists (select 1 from public.mcp_oauth_secrets where server_id = old.id) then
    return new;
  end if;

  moved := new.auth_mode is distinct from 'oauth'
    or new.relay_id is distinct from old.relay_id
    or new.workspace_id is distinct from old.workspace_id
    or lower(substring(new.url from origin_re)) is distinct from lower(substring(old.url from origin_re));

  if not moved then
    foreach k in array array['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'resource', 'client_id'] loop
      if nullif(old.oauth ->> k, '') is not null
         and nullif(old.oauth ->> k, '') is distinct from nullif(new.oauth ->> k, '') then
        moved := true;
        exit;
      end if;
    end loop;
  end if;

  if moved then
    delete from public.mcp_oauth_secrets where server_id = new.id;
    if found and new.auth_mode = 'oauth' then
      new.oauth := (coalesce(new.oauth, '{}'::jsonb) - 'connected_at') || jsonb_build_object('status', 'disconnected');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mcp_servers_oauth_guard on public.mcp_servers;
create trigger trg_mcp_servers_oauth_guard
  before update of url, relay_id, workspace_id, auth_mode, oauth on public.mcp_servers
  for each row execute function public.mcp_servers_oauth_guard();
