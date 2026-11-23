-- 0316 — Les agents embarqués (docs/harness-opencode/05).
--
-- Une troisième sorte d'agent, à côté des collaborateurs internes et des agents
-- publics : un agent conçu dans FounderOS, puis empaqueté avec sa machine (un
-- conteneur : le harnais OpenCode, ses outils, sa configuration, son système de
-- fichiers) pour tourner ailleurs. Il garde un lien avec FounderOS par une clé
-- d'API : les outils de la plateforme (connecteurs, livrables, mémoire,
-- recherche) passent par la passerelle /embedded/v1, ses runs remontent dans les
-- tables habituelles, et il se pilote d'ici (pause, reprise, rechargement).
--
--   internal_agents.deployment   platform (le backend fait tourner l'agent) ou
--                                embedded (son conteneur le fait tourner)
--   embedded_agent_configs       les réglages de l'empaquetage
--   embedded_agent_builds        les versions construites (manifeste figé, image)
--   embedded_agent_instances     les conteneurs qui tournent, vus par leur battement de cœur
--   embedded_agent_api_keys      les clés d'API (empreinte seulement, jamais la clé)
--   embedded_agent_commands      les ordres envoyés aux instances

alter table public.internal_agents
  add column if not exists deployment text not null default 'platform';
do $$ begin
  alter table public.internal_agents add constraint internal_agents_deployment_check check (deployment in ('platform', 'embedded'));
exception when duplicate_object then null; end $$;

create table if not exists public.embedded_agent_configs (
  agent_id            uuid primary key references public.internal_agents(id) on delete cascade,
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  project_id          uuid not null references public.projects(id) on delete cascade,
  service_dashboard_id uuid references public.service_dashboards(id) on delete set null,
  -- connected : tout en direct ; intermittent : file d'attente au retour du réseau ;
  -- isolated : outils locaux seulement, rien ne remonte en direct.
  connectivity        text not null default 'connected' check (connectivity in ('connected', 'intermittent', 'isolated')),
  -- founderos : le modèle passe par la passerelle (clés et crédits de la plateforme) ;
  -- direct : le point d'accès du client (adresse ici, clé dans l'environnement du conteneur).
  llm_route           text not null default 'founderos' check (llm_route in ('founderos', 'direct')),
  llm_base_url        text check (llm_base_url is null or llm_base_url ~* '^https?://'),
  llm_model           text,
  -- Ce qui remonte des conversations : tout, un résumé, ou seulement statuts et coûts.
  sync_level          text not null default 'full' check (sync_level in ('full', 'summary', 'metadata')),
  -- Les collections de ses pools copiées dans l'image, pour chercher sans réseau.
  knowledge_snapshot  boolean not null default true,
  -- La machine : ses ressources, ce qu'elle peut joindre, ce qu'on y installe, ce qu'on y dépose.
  cpus                numeric not null default 2 check (cpus > 0 and cpus <= 64),
  memory_mb           integer not null default 2048 check (memory_mb between 256 and 262144),
  disk_mb             integer not null default 4096 check (disk_mb between 512 and 1048576),
  egress              text[] not null default '{}',
  apt_packages        text[] not null default '{}',
  pip_packages        text[] not null default '{}',
  npm_packages        text[] not null default '{}',
  seed_files          jsonb not null default '[]'::jsonb,
  shell_enabled       boolean not null default true,
  runtime_version     text not null default '1',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.embedded_agent_builds (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  version       integer not null,
  manifest      jsonb not null,
  manifest_sha  text not null,
  -- exported : l'archive du conteneur a été produite ; built / failed : l'image locale.
  status        text not null default 'exported' check (status in ('exported', 'building', 'built', 'failed')),
  image_ref     text,
  log           text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (agent_id, version)
);

create table if not exists public.embedded_agent_instances (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  build_id      uuid references public.embedded_agent_builds(id) on delete set null,
  name          text not null,
  status        text not null default 'online' check (status in ('online', 'paused', 'stopped')),
  -- Un conteneur lancé par ce backend (Docker de l'hôte) : son nom ; sinon null.
  container_ref text,
  manifest_sha  text,
  version       integer,
  info          jsonb not null default '{}'::jsonb,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (agent_id, name)
);

create table if not exists public.embedded_agent_api_keys (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  label         text not null default 'clé',
  -- Les premiers caractères, pour reconnaître une clé ; jamais la clé elle-même.
  prefix        text not null,
  key_hash      text not null unique,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create table if not exists public.embedded_agent_commands (
  id            bigserial primary key,
  agent_id      uuid not null references public.internal_agents(id) on delete cascade,
  instance_id   uuid references public.embedded_agent_instances(id) on delete cascade,
  command       text not null check (command in ('run', 'pause', 'resume', 'stop', 'reload')),
  payload       jsonb not null default '{}'::jsonb,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  taken_at      timestamptz,
  done_at       timestamptz
);
create index if not exists embedded_agent_commands_pending on public.embedded_agent_commands (agent_id, created_at) where taken_at is null;

alter table public.internal_agent_runs
  add column if not exists instance_id uuid references public.embedded_agent_instances(id) on delete set null;

-- Les membres lisent ; tout ce qui écrit passe par le backend (clé de service).
alter table public.embedded_agent_configs enable row level security;
alter table public.embedded_agent_builds enable row level security;
alter table public.embedded_agent_instances enable row level security;
alter table public.embedded_agent_api_keys enable row level security;
alter table public.embedded_agent_commands enable row level security;
drop policy if exists "embedded configs: members read" on public.embedded_agent_configs;
create policy "embedded configs: members read" on public.embedded_agent_configs for select using (public.is_workspace_member(workspace_id));
drop policy if exists "embedded builds: members read" on public.embedded_agent_builds;
create policy "embedded builds: members read" on public.embedded_agent_builds for select using (public.is_workspace_member(workspace_id));
drop policy if exists "embedded instances: members read" on public.embedded_agent_instances;
create policy "embedded instances: members read" on public.embedded_agent_instances for select using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.embedded_agent_configs, public.embedded_agent_builds, public.embedded_agent_instances,
  public.embedded_agent_api_keys, public.embedded_agent_commands from anon, authenticated;
-- Les clés et les ordres ne se lisent que par le backend (la liste des clés passe par la fonction embedded-agents).
revoke select on public.embedded_agent_commands, public.embedded_agent_api_keys from anon, authenticated;
