-- 0282_sso_shared.sql
-- Le SSO d'entreprise pour TOUTES les organisations, pas seulement sur une
-- installation dédiée.
--
-- 0272 réservait le SSO à une installation dédiée : un fournisseur est global à
-- l'instance Supabase, et sur une instance partagée, une organisation aurait pu
-- déclarer un IdP qui revendique les adresses d'une autre — puis se connecter
-- sur leurs comptes. Deux modes désormais :
--
--   dédié    l'organisation « maison » de 0272 (enterprise_sso_settings),
--            inchangée : un seul client, l'exploitant contrôle l'instance ;
--   partagé  chaque organisation configure son SSO, pour les seuls domaines
--            e-mail qu'elle a VÉRIFIÉS (enregistrement DNS TXT). La base refuse
--            toute connexion SSO dont l'adresse n'est pas d'un domaine vérifié
--            par l'organisation du fournisseur.
--
-- Le mode se lit ici sans réglage : une ligne dans enterprise_sso_settings,
-- c'est l'installation dédiée ; sinon, le mode partagé (sso-admin le
-- confirme : SSO_MODE).
--
-- La page de connexion du mode partagé ne liste plus les fournisseurs (ce
-- serait la liste des clients) : la personne saisit son adresse, et
-- sso_discover() trouve le fournisseur de son domaine.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Les domaines d'une organisation
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.enterprise_sso_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  domain text not null check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and length(domain) <= 253),
  -- La valeur de l'enregistrement TXT _founderos-sso.<domaine>.
  verification_token text not null check (verification_token ~ '^founderos-sso=[A-Za-z0-9_-]{20,64}$'),
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  -- Les adresses de ce domaine se connectent par le SSO seulement (page de connexion).
  sso_only boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, domain)
);

-- Un domaine n'est vérifié que par UNE organisation.
create unique index if not exists enterprise_sso_domains_verified_uidx
  on public.enterprise_sso_domains (domain) where verified_at is not null;

alter table public.enterprise_sso_domains enable row level security;

drop policy if exists "enterprise_sso_domains: admins read" on public.enterprise_sso_domains;
create policy "enterprise_sso_domains: admins read"
on public.enterprise_sso_domains for select
using (public.workspace_role(workspace_id) in ('owner', 'admin'));
-- Aucune policy d'écriture : la vérification se fait par sso-admin (service role).

-- ────────────────────────────────────────────────────────────────────────────
-- 2. La garde : une connexion SSO n'est acceptée que pour un domaine vérifié
-- ────────────────────────────────────────────────────────────────────────────
-- Avant que l'Auth n'enregistre l'identité : une exception ici fait échouer la
-- connexion (au contraire de sso_sync_membership, qui ne bloque jamais). Seul
-- le mode partagé est concerné ; une identité d'un fournisseur inconnu de
-- FounderOS (Google, Apple…) passe.
create or replace function public.sso_identity_domain(p_identity_data jsonb)
returns text
language sql
immutable
as $$
  select lower(nullif(split_part(coalesce(p_identity_data ->> 'email', p_identity_data -> 'custom_claims' ->> 'email', ''), '@', 2), ''));
$$;

create or replace function public.sso_guard_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider public.enterprise_sso_providers;
  v_domain text;
begin
  if new.provider not like 'custom:%' and new.provider not like 'sso:%' then
    return new;
  end if;
  -- Installation dédiée : l'exploitant contrôle l'instance (0272).
  if exists (select 1 from public.enterprise_sso_settings) then
    return new;
  end if;
  select p.* into v_provider from public.enterprise_sso_providers p
   where p.auth_ref = new.provider or 'sso:' || p.auth_ref = new.provider
   limit 1;
  if not found then
    -- Un fournisseur de l'Auth que FounderOS ne connaît pas : rien ne le rattache
    -- à une organisation, donc rien ne garantit ses adresses.
    raise exception 'sso_unknown_provider: fournisseur SSO non déclaré dans FounderOS' using errcode = 'check_violation';
  end if;
  v_domain := public.sso_identity_domain(new.identity_data);
  if v_domain is null
     or not (v_domain = any (v_provider.domains))
     or not exists (
       select 1 from public.enterprise_sso_domains d
        where d.workspace_id = v_provider.workspace_id and d.domain = v_domain and d.verified_at is not null
     ) then
    raise exception 'sso_domain_not_verified: l''adresse % n''est pas d''un domaine vérifié pour ce fournisseur', coalesce(v_domain, '?')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.sso_guard_identity() from public, anon, authenticated;

do $$
begin
  drop trigger if exists before_auth_identity_sso_guard on auth.identities;
  create trigger before_auth_identity_sso_guard
  before insert or update on auth.identities
  for each row execute function public.sso_guard_identity();
exception when insufficient_privilege or undefined_table then
  raise warning 'before_auth_identity_sso_guard non créé : le SSO partagé restera fermé (sso-admin le vérifie).';
end;
$$;

-- sso-admin n'ouvre le mode partagé que si la garde est en place.
create or replace function public.sso_guard_installed()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth' and c.relname = 'identities' and t.tgname = 'before_auth_identity_sso_guard' and not t.tgisinternal
  );
$$;

revoke all on function public.sso_guard_installed() from public, anon, authenticated;
do $$
begin
  grant execute on function public.sso_guard_installed() to service_role;
exception when undefined_object then
  null; -- pas de rôle service_role (base de test)
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Pas d'organisation personnelle pour un compte SSO, dans les deux modes
-- ────────────────────────────────────────────────────────────────────────────
-- 0272 ne le faisait qu'en dédié. Un compte créé par le SSO d'une organisation
-- la rejoint (sso_sync_membership) : un « My workspace » vide en plus n'aurait
-- pas de sens.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
  workspace_slug text;
  v_provider text := coalesce(new.raw_app_meta_data ->> 'provider', '');
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;

  if (v_provider like 'custom:%' or v_provider like 'sso:%')
     and (
       exists (select 1 from public.enterprise_sso_settings)
       or exists (select 1 from public.enterprise_sso_providers p where p.auth_ref = v_provider or 'sso:' || p.auth_ref = v_provider)
     ) then
    return new;
  end if;

  workspace_slug := 'ws-' || substr(replace(new.id::text, '-', ''), 1, 8);

  insert into public.workspaces (name, slug, owner_id)
  values (coalesce(new.raw_user_meta_data->>'name', 'My workspace'), workspace_slug, new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. La page de connexion
-- ────────────────────────────────────────────────────────────────────────────
-- Dédié : les boutons de 0272. Partagé : aucun fournisseur listé, la découverte
-- par adresse (sso_discover).
create or replace function public.sso_login_options()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (select 1 from public.enterprise_sso_settings) then
    jsonb_build_object(
      'mode', 'dedicated',
      'discovery', false,
      'sso_only', coalesce((select s.sso_only from public.enterprise_sso_settings s), false),
      'providers', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', p.id, 'protocol', p.protocol, 'preset', p.preset,
                 'ref', p.auth_ref, 'name', p.name, 'domains', p.domains)
               order by p.created_at)
          from public.enterprise_sso_providers p
         where p.enabled
      ), '[]'::jsonb)
    )
  else
    jsonb_build_object(
      'mode', 'shared',
      'discovery', exists (select 1 from public.enterprise_sso_providers p where p.enabled),
      'sso_only', false,
      'providers', '[]'::jsonb
    )
  end;
$$;

grant execute on function public.sso_login_options() to anon, authenticated;

-- Le fournisseur d'une adresse : celui dont la liste de domaines contient le
-- domaine, et — en partagé — d'une organisation qui a vérifié ce domaine.
-- Ne dit rien de plus que ce qu'il faut pour rediriger.
create or replace function public.sso_discover(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with d as (
    select lower(nullif(split_part(trim(coalesce(p_email, '')), '@', 2), '')) as domain
  )
  select (
    select jsonb_build_object(
             'id', p.id, 'protocol', p.protocol, 'preset', p.preset, 'ref', p.auth_ref, 'name', p.name,
             'sso_only', coalesce(v.sso_only, false))
      from d
      join public.enterprise_sso_providers p on p.enabled and d.domain = any (p.domains)
      left join public.enterprise_sso_domains v
        on v.workspace_id = p.workspace_id and v.domain = d.domain and v.verified_at is not null
     where exists (select 1 from public.enterprise_sso_settings) or v.id is not null
     order by p.created_at
     limit 1
  );
$$;

grant execute on function public.sso_discover(text) to anon, authenticated;
