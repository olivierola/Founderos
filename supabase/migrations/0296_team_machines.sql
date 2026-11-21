-- 0296 — Une MACHINE pour chaque équipe d'agents.
--
-- Une équipe (service_dashboards.settings.teams) reçoit un vrai poste Linux,
-- partagé : la machine d'équipe (team-machine/, un conteneur). Ses agents y
-- créent des dossiers et des fichiers, lancent des commandes, testent, font
-- tourner des serveurs. L'isolement est celui du noyau, pas une convention :
--
--   · chaque agent y est un UTILISATEUR Linux — son dossier perso (0700) n'est
--     lisible que par lui ;
--   · l'équipe entière partage un dossier « commun » ;
--   · un DOSSIER PROTÉGÉ est un groupe Linux dont ne font partie, le temps d'un
--     processus, que les agents qui présentent son SECRET. La machine garde
--     l'empreinte du secret, la plateforme le secret chiffré ; il n'est
--     déchiffré que pour un agent MEMBRE du dossier, et n'apparaît jamais dans
--     le contexte d'un modèle : un agent qui voit un secret peut le répéter, et
--     c'est précisément l'agent qu'on voulait tenir dehors qui l'entendrait.
--
-- Les tables ci-dessous sont l'annuaire côté plateforme : qui a une machine,
-- qui y est qui, quels dossiers protégés, qui en est membre, et le journal.
-- Les secrets ont leur table à part, sans aucune politique : service role
-- seulement. Toutes les écritures passent par la fonction team-machine et par
-- les outils des agents (service role) : un membre lit, il n'écrit pas ici.

-- ── La machine d'une équipe ──────────────────────────────────────────────────
create table if not exists public.team_machines (
  -- L'id de l'équipe dans service_dashboards.settings.teams (texte : les
  -- équipes vivent dans un jsonb, il n'y a pas de clé étrangère possible).
  team_id       text primary key,
  dashboard_id  uuid not null references public.service_dashboards(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- Le nom de son dossier sur la machine : /teams/<team_key>. Fixé à
  -- l'activation — renommer l'équipe ne déplace pas ses fichiers.
  team_key      text not null check (team_key ~ '^[a-z][a-z0-9-]{1,26}$'),
  status        text not null default 'active' check (status in ('active', 'paused')),
  -- Les agents peuvent demander des paquets apt (installés pour toute la
  -- machine) — encore faut-il que la machine l'autorise (MACHINE_ALLOW_APT).
  allow_system_packages boolean not null default false,
  -- Une autre machine que celle du service (app_config.team_machine_url) :
  -- réservé aux owners/admins, écrit par la fonction seulement.
  url           text check (url is null or url ~* '^https?://[a-z0-9.\-]+(:[0-9]{1,5})?(/.*)?$'),
  machine_path  text,
  last_seen_at  timestamptz,
  last_error    text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_team_machines_dashboard on public.team_machines (dashboard_id);

-- ── Qui est qui sur la machine ───────────────────────────────────────────────
create table if not exists public.team_machine_agents (
  team_id       text not null references public.team_machines(team_id) on delete cascade,
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  unix_user     text not null,
  home_path     text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  primary key (team_id, agent_id)
);

-- ── Les dossiers protégés ────────────────────────────────────────────────────
create table if not exists public.team_machine_folders (
  id            uuid primary key default gen_random_uuid(),
  team_id       text not null references public.team_machines(team_id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null check (name ~ '^[a-z0-9][a-z0-9._-]{0,47}$'),
  path          text,
  -- Pourquoi il existe : montré aux membres, et aux humains.
  purpose       text,
  -- « archived » : retiré hors d'atteinte des agents sur la machine, rien d'effacé.
  status        text not null default 'active' check (status in ('active', 'archived')),
  created_by_agent uuid references public.internal_agents(id) on delete set null,
  created_by_user  uuid references auth.users(id) on delete set null,
  secret_rotated_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_team_machine_folders_name
  on public.team_machine_folders (team_id, name) where status = 'active';

create table if not exists public.team_machine_folder_members (
  folder_id     uuid not null references public.team_machine_folders(id) on delete cascade,
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  -- Le propriétaire gère les membres et le secret ; un humain peut tout.
  role          text not null default 'member' check (role in ('owner', 'member')),
  added_by_agent uuid references public.internal_agents(id) on delete set null,
  added_by_user  uuid references auth.users(id) on delete set null,
  added_at      timestamptz not null default now(),
  primary key (folder_id, agent_id)
);
create index if not exists idx_team_machine_folder_members_agent on public.team_machine_folder_members (agent_id);

-- ── Les secrets (chiffrés, AES-GCM, CREDENTIAL_ENCRYPTION_KEY) ───────────────
-- kind 'agent'  : ref_id = '<team_id>:<agent_id>' — l'identité de l'agent sur la machine ;
-- kind 'folder' : ref_id = l'id du dossier protégé.
create table if not exists public.team_machine_secrets (
  kind          text not null check (kind in ('agent', 'folder')),
  ref_id        text not null,
  ciphertext    text not null,
  iv            text not null,
  version       int  not null default 1,
  updated_at    timestamptz not null default now(),
  primary key (kind, ref_id)
);

-- ── Le journal ───────────────────────────────────────────────────────────────
create table if not exists public.team_machine_audit (
  id            bigint generated always as identity primary key,
  team_id       text not null,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  agent_id      uuid references public.internal_agents(id) on delete set null,
  user_id       uuid references auth.users(id) on delete set null,
  -- enable, pause, resume, folder_create, member_add, member_remove, leave,
  -- rotate, archive, agent_reset, access_refused…
  action        text not null,
  folder_id     uuid,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_team_machine_audit_team on public.team_machine_audit (team_id, created_at desc);

-- ── Accès ────────────────────────────────────────────────────────────────────
alter table public.team_machines enable row level security;
alter table public.team_machine_agents enable row level security;
alter table public.team_machine_folders enable row level security;
alter table public.team_machine_folder_members enable row level security;
alter table public.team_machine_secrets enable row level security;
alter table public.team_machine_audit enable row level security;

drop policy if exists "team_machines: members read" on public.team_machines;
create policy "team_machines: members read" on public.team_machines for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "team_machine_agents: members read" on public.team_machine_agents;
create policy "team_machine_agents: members read" on public.team_machine_agents for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "team_machine_folders: members read" on public.team_machine_folders;
create policy "team_machine_folders: members read" on public.team_machine_folders for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "team_machine_folder_members: members read" on public.team_machine_folder_members;
create policy "team_machine_folder_members: members read" on public.team_machine_folder_members for select
using (exists (
  select 1 from public.team_machine_folders f
  where f.id = team_machine_folder_members.folder_id and public.is_workspace_member(f.workspace_id)
));

drop policy if exists "team_machine_audit: members read" on public.team_machine_audit;
create policy "team_machine_audit: members read" on public.team_machine_audit for select
using (public.is_workspace_member(workspace_id));

-- Lecture seule pour les comptes ; les secrets, pas même en lecture.
revoke insert, update, delete on public.team_machines from anon, authenticated;
revoke insert, update, delete on public.team_machine_agents from anon, authenticated;
revoke insert, update, delete on public.team_machine_folders from anon, authenticated;
revoke insert, update, delete on public.team_machine_folder_members from anon, authenticated;
revoke insert, update, delete on public.team_machine_audit from anon, authenticated;
revoke all on public.team_machine_secrets from anon, authenticated;

comment on table public.team_machines is
  'Machine d''équipe (0296) : un poste Linux partagé par les agents d''une équipe, un utilisateur par agent.';
comment on table public.team_machine_secrets is
  'Secrets chiffrés des identités d''agents et des dossiers protégés de la machine d''équipe. Service role seulement — jamais montrés à un modèle.';
