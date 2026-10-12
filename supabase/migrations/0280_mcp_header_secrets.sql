-- 0280_mcp_header_secrets.sql
-- Les en-têtes d'un serveur MCP (« Authorization: Bearer … », une clé d'API)
-- ne se lisent plus depuis un navigateur.
--
-- Jusqu'ici, ils vivaient en clair dans mcp_servers.headers, que tout membre de
-- l'espace lit (0119, 0279), lecteurs compris ; l'écran de modification les
-- affichait. Désormais :
--   - les valeurs vont dans mcp_server_headers, sans policy, que seul le backend
--     lit. Il les chiffre (AES-GCM, CREDENTIAL_ENCRYPTION_KEY) à la première
--     lecture ; headers_plain n'est qu'un état de passage, la base ne
--     connaissant pas la clé ;
--   - mcp_servers.headers reste vide. Le déclencheur y déplace toute valeur
--     écrite, par n'importe quel chemin (écran, ancienne version, SQL) ;
--   - mcp_servers.header_hints garde de quoi les reconnaître :
--     { "Authorization": "Bearer …x9Qz" } ;
--   - comme le jeton d'API (0278) et les secrets OAuth (0279), les en-têtes sont
--     liés à leur destination : si l'origine de l'URL, le relais ou l'espace
--     changent, ils sont effacés et doivent être ressaisis.

create table if not exists public.mcp_server_headers (
  -- Différée : le déclencheur écrit ici avant que la ligne du serveur existe (insertion).
  server_id uuid primary key references public.mcp_servers(id) on delete cascade deferrable initially deferred,
  headers_plain jsonb,
  headers_enc text,
  headers_iv text,
  updated_at timestamptz not null default now(),
  constraint mcp_server_headers_value_check
    check (headers_plain is not null or (headers_enc is not null and headers_iv is not null))
);

alter table public.mcp_server_headers enable row level security;
-- Aucune policy : rien ne se lit ni ne s'écrit depuis un navigateur.
revoke all on public.mcp_server_headers from anon, authenticated;

alter table public.mcp_servers add column if not exists header_hints jsonb not null default '{}'::jsonb;

-- « Bearer …x9Qz », « …x9Qz », « Bearer •••• » ou « •••• ». Les 4 derniers
-- caractères ne se montrent que d'un secret d'au moins 12 caractères, schéma
-- d'authentification mis à part. Même règle que headerHint() dans
-- _shared/mcp-headers.ts.
create or replace function public.mcp_header_hint(v text)
returns text
language sql
immutable
as $$
  select case
    when v ~* '^(bearer|basic|token|bot) .+$' then
      split_part(v, ' ', 1) || ' ' || case
        when length(substr(v, length(split_part(v, ' ', 1)) + 2)) >= 12 then '…' || right(v, 4)
        else '••••'
      end
    when length(v) >= 12 then '…' || right(v, 4)
    else '••••'
  end;
$$;

-- Les en-têtes déjà enregistrés passent dans la table protégée.
insert into public.mcp_server_headers (server_id, headers_plain)
select id, headers from public.mcp_servers
 where headers is not null and headers <> '{}'::jsonb
on conflict (server_id) do nothing;

update public.mcp_servers s
   set header_hints = coalesce((select jsonb_object_agg(key, public.mcp_header_hint(value)) from jsonb_each_text(s.headers)), '{}'::jsonb),
       headers = '{}'::jsonb
 where headers is not null and headers <> '{}'::jsonb;

create or replace function public.mcp_servers_headers_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  origin_re constant text := '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+';
begin
  -- Autre destination : les en-têtes enregistrés ne la suivent pas.
  if tg_op = 'UPDATE' and (
       new.relay_id is distinct from old.relay_id
       or new.workspace_id is distinct from old.workspace_id
       or lower(substring(new.url from origin_re)) is distinct from lower(substring(old.url from origin_re))
     ) then
    delete from public.mcp_server_headers where server_id = new.id;
    new.header_hints := '{}'::jsonb;
  end if;

  -- Des valeurs écrites dans la colonne : elles remplacent les en-têtes
  -- enregistrés, et la colonne redevient vide. « {} » ne vaut pas effacement
  -- (les anciens écrans renvoient la colonne telle qu'ils l'ont lue).
  if new.headers is not null and new.headers <> '{}'::jsonb then
    if jsonb_typeof(new.headers) <> 'object' then
      raise exception 'mcp_servers.headers : un objet { nom: valeur } est attendu';
    end if;
    insert into public.mcp_server_headers (server_id, headers_plain)
    values (new.id, new.headers)
    on conflict (server_id) do update
      set headers_plain = excluded.headers_plain, headers_enc = null, headers_iv = null, updated_at = now();
    new.header_hints := coalesce((select jsonb_object_agg(key, public.mcp_header_hint(value)) from jsonb_each_text(new.headers)), '{}'::jsonb);
    new.headers := '{}'::jsonb;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mcp_servers_headers_guard on public.mcp_servers;
create trigger trg_mcp_servers_headers_guard
  before insert or update of headers, url, relay_id, workspace_id on public.mcp_servers
  for each row execute function public.mcp_servers_headers_guard();
