-- 0272_enterprise_sso.sql
-- SSO d'entreprise : les personnes se connectent avec le fournisseur d'identité
-- du client (Entra ID, Keycloak, ADFS, Okta…), et leurs groupes décident de leur
-- rôle dans l'organisation.
--
-- Les fournisseurs eux-mêmes vivent dans Supabase Auth, qui sait les ajouter à
-- chaud par son API admin : OIDC (`/admin/custom-providers`, identifiant
-- « custom:xxx ») et SAML 2.0 (`/admin/sso/providers`, un UUID). La fonction
-- edge sso-admin les y enregistre. Ici, on ne garde que ce que l'Auth ne sait
-- pas faire : à quelle organisation un fournisseur donne accès, et quel rôle
-- chaque groupe y reçoit.
--
-- Un fournisseur est GLOBAL à l'instance (une installation = un client) : il
-- est donc rattaché à une seule organisation, l'organisation « maison » de
-- l'installation, revendiquée par le premier fournisseur enregistré.
--
-- POURQUOI LE RÔLE SE CALCULE DANS UN TRIGGER SUR auth.identities
-- Les attributs SAML et les claims OIDC arrivent aussi dans user_metadata, mais
-- user_metadata est modifiable par l'utilisateur lui-même (auth.updateUser) :
-- s'y fier permettrait à n'importe qui de s'ajouter le groupe des admins.
-- identity_data, lui, n'est écrit que par l'Auth, à chaque connexion. Le
-- trigger le relit à chaque connexion SSO et aligne l'appartenance : un groupe
-- retiré dans l'IdP fait baisser le rôle (ou retire l'accès) à la connexion
-- suivante.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Réglages de l'instance (une seule ligne)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.enterprise_sso_settings (
  id boolean primary key default true check (id),
  home_workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- La page de connexion ne propose plus que le SSO. Affichage seulement : le
  -- refus côté serveur se règle dans l'Auth (GOTRUE_EXTERNAL_EMAIL_ENABLED=false).
  sso_only boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.enterprise_sso_settings enable row level security;

drop policy if exists "enterprise_sso_settings: admins read" on public.enterprise_sso_settings;
create policy "enterprise_sso_settings: admins read"
on public.enterprise_sso_settings for select
using (public.workspace_role(home_workspace_id) in ('owner', 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Les fournisseurs
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.enterprise_sso_providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  protocol text not null check (protocol in ('oidc', 'saml')),
  preset text not null default 'generic' check (preset in ('entra', 'keycloak', 'generic')),
  -- Côté Auth : « custom:xxx » pour OIDC, l'UUID du fournisseur pour SAML. Les
  -- identités portent `custom:xxx` ou `sso:<uuid>` dans auth.identities.provider.
  auth_ref text not null unique,
  -- Libellé du bouton de connexion.
  name text not null,
  -- SAML : domaines e-mail qui mènent à ce fournisseur (signInWithSSO).
  domains text[] not null default '{}',
  -- Paramètres NON secrets, pour l'affichage. Le secret client n'est stocké que
  -- dans l'Auth.
  issuer text,
  client_id text,
  metadata_url text,
  -- Où lire les groupes dans les données d'identité. Chemin pointé : `groups`,
  -- `roles` (rôles d'application Entra), `realm_access.roles` (Keycloak).
  groups_claim text not null default 'groups' check (groups_claim ~ '^[A-Za-z0-9_:/.-]{1,200}$'),
  -- SAML : l'attribut de l'assertion recopié sous `groups_claim`, et celui qui
  -- porte l'e-mail quand le NameID n'en est pas un.
  groups_attribute text,
  email_attribute text,
  -- Rôle donné à une personne authentifiée dont aucun groupe ne correspond.
  -- Null : pas d'accès sans groupe reconnu (le choix sûr).
  default_role text check (default_role in ('viewer', 'member')),
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists enterprise_sso_providers_workspace_idx
  on public.enterprise_sso_providers(workspace_id);

alter table public.enterprise_sso_providers enable row level security;

drop policy if exists "enterprise_sso_providers: admins read" on public.enterprise_sso_providers;
create policy "enterprise_sso_providers: admins read"
on public.enterprise_sso_providers for select
using (public.workspace_role(workspace_id) in ('owner', 'admin'));
-- Aucune policy d'écriture : un fournisseur n'existe que s'il existe aussi dans
-- l'Auth, donc il ne s'écrit que par sso-admin (service role).

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Groupe de l'IdP → rôle dans l'organisation
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.enterprise_sso_role_mappings (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.enterprise_sso_providers(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- La valeur telle que l'IdP l'envoie : l'object ID d'un groupe Entra, le nom
  -- d'un rôle d'application, un groupe Keycloak (« /sre »)…
  idp_value text not null check (length(idp_value) between 1 and 500),
  -- Jamais owner : la propriété d'une organisation ne se délègue pas à un IdP.
  role text not null check (role in ('admin', 'member', 'viewer')),
  -- Nom lisible : Entra n'envoie que des GUID.
  label text,
  created_at timestamptz not null default now(),
  unique (provider_id, idp_value)
);

alter table public.enterprise_sso_role_mappings enable row level security;

drop policy if exists "enterprise_sso_role_mappings: admins read" on public.enterprise_sso_role_mappings;
create policy "enterprise_sso_role_mappings: admins read"
on public.enterprise_sso_role_mappings for select
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- Écrites depuis l'interface. Le `with check` impose que le fournisseur visé
-- appartienne à la même organisation que la ligne.
drop policy if exists "enterprise_sso_role_mappings: admins write" on public.enterprise_sso_role_mappings;
create policy "enterprise_sso_role_mappings: admins write"
on public.enterprise_sso_role_mappings for all
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (
  public.workspace_role(workspace_id) in ('owner', 'admin')
  and exists (
    select 1 from public.enterprise_sso_providers p
     where p.id = provider_id and p.workspace_id = enterprise_sso_role_mappings.workspace_id
  )
);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Qui gère une appartenance
-- ────────────────────────────────────────────────────────────────────────────
-- 'sso' : créée et tenue à jour par le SSO. Null : donnée à la main (invitation,
-- créateur de l'organisation), et le SSO n'y touche jamais.
alter table public.workspace_members
  add column if not exists managed_by text check (managed_by in ('sso')),
  add column if not exists sso_synced_at timestamptz;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Journal des connexions SSO
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.enterprise_sso_logins (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id uuid references public.enterprise_sso_providers(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  -- Les valeurs lues dans le claim (bornées), pour comprendre un rôle inattendu.
  idp_values text[] not null default '{}',
  claim_found boolean not null default false,
  role_applied text,
  action text not null check (action in ('granted', 'updated', 'unchanged', 'revoked', 'denied', 'kept_manual')),
  created_at timestamptz not null default now()
);

create index if not exists enterprise_sso_logins_workspace_idx
  on public.enterprise_sso_logins(workspace_id, created_at desc);

alter table public.enterprise_sso_logins enable row level security;

drop policy if exists "enterprise_sso_logins: admins read" on public.enterprise_sso_logins;
create policy "enterprise_sso_logins: admins read"
on public.enterprise_sso_logins for select
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Alignement de l'appartenance à chaque connexion
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.sso_sync_membership()
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
  v_role text;
  v_member public.workspace_members;
  v_action text;
begin
  if new.provider not like 'custom:%' and new.provider not like 'sso:%' then
    return new;
  end if;

  -- Un défaut ici ne doit JAMAIS bloquer une connexion : l'erreur est journalisée
  -- et la connexion passe, sans rien accorder de plus.
  begin
    select p.* into v_provider
      from public.enterprise_sso_providers p
     where p.enabled
       and (p.auth_ref = new.provider or 'sso:' || p.auth_ref = new.provider)
     limit 1;
    if not found then
      return new;
    end if;

    -- Selon le protocole et la version de l'Auth, les claims non standard sont
    -- à la racine des données d'identité ou sous custom_claims.
    v_path := string_to_array(v_provider.groups_claim, '.');
    v_claim := coalesce(new.identity_data #> v_path, new.identity_data -> 'custom_claims' #> v_path);
    if jsonb_typeof(v_claim) = 'array' then
      v_values := array(select jsonb_array_elements_text(v_claim));
    elsif jsonb_typeof(v_claim) = 'string' then
      v_values := array[v_claim #>> '{}'];
    end if;

    -- Le rôle le plus fort parmi les groupes reconnus, sinon le rôle par défaut.
    select m.role into v_role
      from public.enterprise_sso_role_mappings m
     where m.provider_id = v_provider.id
       and m.idp_value = any(v_values)
     order by case m.role when 'admin' then 3 when 'member' then 2 else 1 end desc
     limit 1;
    v_role := coalesce(v_role, v_provider.default_role);

    select wm.* into v_member
      from public.workspace_members wm
     where wm.workspace_id = v_provider.workspace_id
       and wm.user_id = new.user_id;

    -- Une appartenance donnée à la main, ou devenue propriétaire, n'est plus
    -- l'affaire du SSO.
    if found and (v_member.managed_by is distinct from 'sso' or v_member.role = 'owner') then
      v_action := 'kept_manual';
    elsif v_role is null then
      if found then
        delete from public.workspace_members where id = v_member.id;
        v_action := 'revoked';
      else
        v_action := 'denied';
      end if;
    elsif found then
      update public.workspace_members
         set role = v_role, sso_synced_at = now()
       where id = v_member.id;
      v_action := case when v_member.role = v_role then 'unchanged' else 'updated' end;
    else
      insert into public.workspace_members (workspace_id, user_id, role, managed_by, sso_synced_at)
      values (v_provider.workspace_id, new.user_id, v_role, 'sso', now());
      v_action := 'granted';
    end if;

    insert into public.enterprise_sso_logins
      (workspace_id, provider_id, user_id, email, idp_values, claim_found, role_applied, action)
    values (
      v_provider.workspace_id, v_provider.id, new.user_id,
      new.identity_data ->> 'email',
      v_values[1:50], v_claim is not null,
      case when v_action in ('revoked', 'denied', 'kept_manual') then null else v_role end,
      v_action
    );
  exception when others then
    raise warning 'sso_sync_membership (%): %', new.provider, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.sso_sync_membership() from public, anon, authenticated;

-- Sur une installation dédiée, la migration a tous les droits sur le schéma
-- auth. Sur une instance hébergée qui les restreint, le SSO d'entreprise n'est
-- pas ouvert (SSO_ADMIN_ENABLED) : on le signale sans faire échouer la migration.
do $$
begin
  drop trigger if exists on_auth_identity_sso_sync on auth.identities;
  create trigger on_auth_identity_sso_sync
  after insert or update on auth.identities
  for each row execute function public.sso_sync_membership();
exception when insufficient_privilege then
  raise warning 'on_auth_identity_sso_sync non créé (droits insuffisants sur auth.identities) : les rôles SSO ne seront pas synchronisés.';
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Pas d'organisation personnelle pour un compte SSO
-- ────────────────────────────────────────────────────────────────────────────
-- Un compte créé par le SSO de l'entreprise rejoint l'organisation maison (via
-- le trigger ci-dessus), pas une « My workspace » vide à son nom. Si l'Auth ne
-- renseigne pas encore le fournisseur au moment de l'insertion, on retombe sur
-- l'ancien comportement : un espace personnel en trop, rien de plus.
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
     and exists (select 1 from public.enterprise_sso_settings) then
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
-- 8. Ce que la page de connexion a le droit de savoir
-- ────────────────────────────────────────────────────────────────────────────
-- Appelée sans session : rien que de quoi dessiner les boutons.
create or replace function public.sso_login_options()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'sso_only', coalesce((select s.sso_only from public.enterprise_sso_settings s), false),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'protocol', p.protocol, 'preset', p.preset,
               'ref', p.auth_ref, 'name', p.name, 'domains', p.domains)
             order by p.created_at)
        from public.enterprise_sso_providers p
       where p.enabled
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.sso_login_options() to anon, authenticated;
