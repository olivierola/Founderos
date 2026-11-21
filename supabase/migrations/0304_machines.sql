-- 0304 — Les MACHINES, ressources à part entière.
--
-- 0296 donnait une machine à une ÉQUIPE : une seule machine (celle de la
-- plateforme, app_config.team_machine_url), où chaque équipe avait son dossier.
-- Désormais un espace de travail tient un PARC : la machine de la plateforme,
-- un conteneur Docker sur un poste, une VM chez un hébergeur… Chacune se
-- déclare ici, et s'ATTRIBUE à une équipe ou à un agent seul.
--
-- L'attribution reste la ligne de team_machines (0296) : c'est elle qui porte
-- le dossier de l'équipe sur la machine, ses agents, ses dossiers protégés.
-- On y ajoute la machine choisie, et la portée : une équipe, ou un agent seul
-- (une « équipe d'un », dont l'id est `agent-<uuid>` et que l'interface
-- n'affiche pas comme une équipe).
--
-- Le jeton d'une machine (sa clé HMAC) n'est jamais dans cette table : il est
-- chiffré dans team_machine_secrets (kind 'machine'), comme les autres secrets.
-- Une machine sans jeton propre utilise TEAM_MACHINE_TOKEN.

create table if not exists public.machines (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- Le service où elle a été déclarée (son parc s'affiche là). Null : tout l'espace.
  dashboard_id  uuid references public.service_dashboards(id) on delete set null,
  name          text not null check (length(name) between 1 and 80),
  description   text,
  -- docker : un conteneur team-machine sur un poste ; vm, cloud : ailleurs.
  kind          text not null default 'docker' check (kind in ('docker', 'vm', 'cloud', 'platform')),
  -- Null : la machine de la plateforme (app_config.team_machine_url, puis
  -- TEAM_MACHINE_URL). Sinon une adresse publique, contrôlée contre le SSRF
  -- par la fonction qui l'écrit.
  url           text check (url is null or url ~* '^https?://[a-z0-9.\-]+(:[0-9]{1,5})?(/.*)?$'),
  status        text not null default 'active' check (status in ('active', 'paused')),
  allow_system_packages boolean not null default false,
  -- Le dernier relevé : version, charge, mémoire, disque (machine.info).
  info          jsonb not null default '{}'::jsonb,
  last_seen_at  timestamptz,
  last_error    text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_machines_workspace on public.machines (workspace_id);

alter table public.team_machines
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists scope text not null default 'team',
  add column if not exists agent_id uuid references public.internal_agents(id) on delete cascade;

do $$ begin
  alter table public.team_machines add constraint team_machines_scope_check
    check (scope in ('team', 'agent') and (scope = 'team' or agent_id is not null));
exception when duplicate_object then null; end $$;

create index if not exists idx_team_machines_machine on public.team_machines (machine_id);
-- Un agent n'a qu'une machine à lui.
create unique index if not exists uq_team_machines_agent on public.team_machines (agent_id) where scope = 'agent';

-- Le jeton propre d'une machine, chiffré comme les autres secrets.
alter table public.team_machine_secrets drop constraint if exists team_machine_secrets_kind_check;
alter table public.team_machine_secrets add constraint team_machine_secrets_kind_check
  check (kind in ('agent', 'folder', 'machine'));

alter table public.machines enable row level security;
drop policy if exists "machines: members read" on public.machines;
create policy "machines: members read" on public.machines for select
using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.machines from anon, authenticated;

comment on table public.machines is
  'Le parc de machines d''un espace (0304) : chacune s''attribue à une équipe ou à un agent par team_machines. Le jeton est dans team_machine_secrets.';
comment on column public.team_machines.scope is
  'team : la machine d''une équipe (team_id = id de l''équipe) ; agent : celle d''un agent seul (team_id = agent-<uuid>).';
