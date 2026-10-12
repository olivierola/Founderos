-- 0283_installation_settings.sql
-- G4 : les réglages de l'installation, sans secret, modifiables depuis
-- Administration → Installation (docs/enterprise-generalisation.md, G4).
--
-- Ce qui était en variables d'environnement (passerelle LLM et alias, hôtes
-- internes, émetteur des approbations…) peut se régler à l'écran. Le backend
-- Express (dossier backend/) les lit au démarrage puis chaque minute, et les
-- sert au code comme des variables d'environnement. L'environnement garde la
-- priorité : une installation pilotée par GitOps garde la main, et l'écran
-- montre ces réglages verrouillés.
--
-- Les secrets n'y entrent jamais (clés, secrets clients, webhooks) : ils restent
-- dans l'environnement ou Vault, et l'écran dit seulement s'ils sont présents.
-- La liste des réglages permis est tenue par le backend
-- (backend/src/shared/installation.ts) ; la base ne garde que des chaînes.

-- Un objet dont toutes les valeurs sont des chaînes.
create or replace function public.jsonb_is_string_map(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_each(p) e where jsonb_typeof(e.value) <> 'string');
$$;

create table if not exists public.installation_settings (
  id boolean primary key default true check (id),
  -- L'organisation dont les owners et admins administrent l'installation
  -- (en plus de INSTALLATION_ADMINS). Revendiquée sur une instance neuve.
  owner_workspace_id uuid references public.workspaces(id) on delete set null,
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint installation_settings_shape check (public.jsonb_is_string_map(settings))
);

-- Qui a changé quoi : un réglage d'installation peut détourner des appels
-- (l'adresse de la passerelle LLM, par exemple).
create table if not exists public.installation_settings_history (
  id bigserial primary key,
  key text not null check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  old_value text,
  new_value text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists installation_settings_history_at on public.installation_settings_history (changed_at desc);

-- Lus et écrits par le backend seul (rôle de service).
alter table public.installation_settings enable row level security;
alter table public.installation_settings_history enable row level security;
revoke all on public.installation_settings, public.installation_settings_history from anon, authenticated;
