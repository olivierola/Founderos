-- 0221_plane_projects.sql
-- Le suivi de travail, repris de Plane (AGPL, apps/api/plane/db/models) et
-- porté sur Postgres/Supabase.
--
-- Pourquoi un schéma dédié plutôt que d'étendre `module_projects` : ce dernier
-- décrit un projet par une ligne plate (nom, statut, dates). Tout ce qui fait
-- l'usage de Plane vit AILLEURS que dans cette ligne — un work item appartient
-- à un état lui-même défini par le projet, porte des labels, des assignés, des
-- relations, un rang de tri, une place dans un cycle et dans un module. Aucune
-- de ces choses ne se range dans une colonne `metadata jsonb` sans qu'on perde
-- le seul truc qui compte ici : pouvoir filtrer, grouper et ordonner dessus en
-- SQL. On garde donc `module_projects` pour ce qu'il fait, et on pose à côté le
-- modèle relationnel que l'usage réclame.
--
-- Préfixe `pj_` sur toutes les tables : `projects` est déjà le tenant founderos,
-- et un `states`/`labels`/`issues` nu dans public collisionnerait tôt ou tard.
--
-- Convention de portée : chaque table porte workspace_id (c'est lui qui porte la
-- RLS) même quand la clé parente suffirait. Une jointure de plus par policy sur
-- des tables aussi lues, c'est le genre de détail qui se paie sur chaque board.

-- ────────────────────────────────────────────────────────────────────────────
-- Le projet
-- ────────────────────────────────────────────────────────────────────────────
-- `identifier` est le préfixe des références (PROJ-42). Il est immuable dans
-- l'usage : c'est ce que les gens écrivent dans Slack et collent dans les
-- commits. On le contraint en majuscules courtes plutôt que de laisser un champ
-- libre qui finira en "Mon Projet " avec l'espace.
create table if not exists public.pj_projects (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  project_id     uuid not null references public.projects(id) on delete cascade,
  -- Le dashboard de service qui l'héberge. Nullable : un projet peut vivre au
  -- niveau du tenant, hors de tout service.
  dashboard_id   uuid references public.service_dashboards(id) on delete cascade,

  name           text not null,
  identifier     text not null check (identifier ~ '^[A-Z0-9]{1,12}$'),
  description    text,
  -- Repris tel quel de Plane : un emoji OU une icône, sérialisés pareil.
  logo_props     jsonb not null default '{}'::jsonb,
  cover_image    text,

  -- 0 = privé (membres du projet), 2 = ouvert à l'espace. Les valeurs sont
  -- celles de Plane pour que les exports restent lisibles des deux côtés.
  network        int not null default 2 check (network in (0, 2)),
  lead_id        uuid references auth.users(id) on delete set null,

  start_date     date,
  target_date    date,

  -- Modules activables, comme dans Plane : un projet qui n'utilise pas les
  -- cycles ne doit pas porter un onglet Cycles vide.
  cycle_view       boolean not null default true,
  module_view      boolean not null default true,
  issue_views_view boolean not null default true,
  page_view        boolean not null default true,
  intake_view      boolean not null default false,

  archived_at    timestamptz,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (project_id, identifier)
);
create index if not exists idx_pj_projects_dashboard on public.pj_projects(dashboard_id, archived_at);
create index if not exists idx_pj_projects_project on public.pj_projects(project_id);

-- Appartenance au projet. La RLS s'appuie sur workspace_members ; cette table
-- sert au produit (qui apparaît dans un sélecteur d'assigné, qui est admin du
-- projet), pas à la sécurité.
create table if not exists public.pj_project_members (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- 5 = invité, 15 = membre, 20 = admin (valeurs Plane).
  role           int not null default 15 check (role in (5, 15, 20)),
  sort_order     double precision not null default 65535,
  created_at     timestamptz not null default now(),
  unique (pj_project_id, user_id)
);
create index if not exists idx_pj_project_members on public.pj_project_members(pj_project_id);

-- ────────────────────────────────────────────────────────────────────────────
-- États, labels, estimations : ce que le projet définit, ce que les work items
-- consomment.
-- ────────────────────────────────────────────────────────────────────────────
-- `group` est la clé de tout le produit : c'est lui, pas le nom de l'état, qui
-- dit si un item compte comme terminé. Un projet peut appeler son état final
-- « Livré » ou « Shipped » ; le burndown, lui, lit le groupe.
create table if not exists public.pj_states (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text not null default '',
  color          text not null default '#6b7280',
  "group"        text not null default 'backlog'
                 check ("group" in ('backlog','unstarted','started','completed','cancelled')),
  sequence       double precision not null default 65535,
  -- L'état donné à un item créé sans état. Un seul par projet, garanti par un
  -- index partiel plus bas.
  is_default     boolean not null default false,
  -- L'état d'arrivée de l'intake. Idem : au plus un.
  is_triage      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (pj_project_id, name)
);
create index if not exists idx_pj_states_project on public.pj_states(pj_project_id, sequence);
create unique index if not exists idx_pj_states_one_default
  on public.pj_states(pj_project_id) where is_default;
create unique index if not exists idx_pj_states_one_triage
  on public.pj_states(pj_project_id) where is_triage;

create table if not exists public.pj_labels (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  parent_id      uuid references public.pj_labels(id) on delete set null,
  name           text not null,
  color          text not null default '#6b7280',
  sort_order     double precision not null default 65535,
  created_at     timestamptz not null default now(),
  unique (pj_project_id, name)
);
create index if not exists idx_pj_labels_project on public.pj_labels(pj_project_id, sort_order);

-- Une échelle d'estimation nommée. `type` dit ce qu'on additionne : des points,
-- des catégories (tailles de t-shirt, non sommables) ou du temps.
create table if not exists public.pj_estimates (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text not null default '',
  type           text not null default 'points' check (type in ('points','categories','time')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

create table if not exists public.pj_estimate_points (
  id             uuid primary key default gen_random_uuid(),
  estimate_id    uuid not null references public.pj_estimates(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  -- `key` porte l'ordre ET sert de valeur numérique quand type = points.
  key            int not null,
  value          text not null,
  sort_order     double precision not null default 65535,
  unique (estimate_id, key)
);

-- Types de work item (bug / story / tâche…). Optionnel dans l'usage : un projet
-- qui n'en définit aucun affiche des items sans type, comme Plane par défaut.
create table if not exists public.pj_issue_types (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text not null default '',
  logo_props     jsonb not null default '{}'::jsonb,
  is_active      boolean not null default true,
  is_default     boolean not null default false,
  sort_order     double precision not null default 65535,
  created_at     timestamptz not null default now(),
  unique (pj_project_id, name)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Le work item
-- ────────────────────────────────────────────────────────────────────────────
-- `sequence_id` est le numéro humain (PROJ-42), attribué par trigger et unique
-- par projet. Il ne se réutilise pas après suppression : une référence collée
-- dans une conversation il y a six mois ne doit jamais désigner un autre item.
--
-- `sort_order` est un float et pas un entier, exprès : le drag & drop d'un
-- kanban insère ENTRE deux cartes, et un float permet de le faire en écrivant
-- une seule ligne au lieu de renuméroter la colonne entière.
create table if not exists public.pj_issues (
  id                uuid primary key default gen_random_uuid(),
  pj_project_id     uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,

  sequence_id       int not null,
  name              text not null,
  -- L'éditeur riche écrit du HTML ; on garde en plus un texte plat, que la
  -- recherche interroge sans avoir à détricoter les balises à chaque requête.
  description_html  text not null default '',
  description_text  text not null default '',

  priority          text not null default 'none'
                    check (priority in ('urgent','high','medium','low','none')),
  state_id          uuid references public.pj_states(id) on delete set null,
  parent_id         uuid references public.pj_issues(id) on delete set null,
  estimate_point_id uuid references public.pj_estimate_points(id) on delete set null,
  type_id           uuid references public.pj_issue_types(id) on delete set null,

  start_date        date,
  target_date       date,
  completed_at      timestamptz,
  sort_order        double precision not null default 65535,

  -- Un brouillon n'apparaît nulle part sauf dans les brouillons de son auteur.
  is_draft          boolean not null default false,
  archived_at       timestamptz,

  created_by        uuid references auth.users(id),
  updated_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (pj_project_id, sequence_id)
);
create index if not exists idx_pj_issues_board
  on public.pj_issues(pj_project_id, state_id, sort_order) where archived_at is null and is_draft = false;
create index if not exists idx_pj_issues_parent on public.pj_issues(parent_id);
create index if not exists idx_pj_issues_dates on public.pj_issues(pj_project_id, target_date);
create index if not exists idx_pj_issues_search
  on public.pj_issues using gin (to_tsvector('simple', name || ' ' || description_text));

-- Le numéro humain. Une séquence Postgres par projet serait plus rapide mais
-- il en faudrait une par projet créé ; un max()+1 sous verrou de ligne projet
-- suffit très largement au débit réel et tient en une fonction.
create or replace function public.pj_assign_sequence_id()
returns trigger language plpgsql as $$
declare
  next_id int;
begin
  if new.sequence_id is not null and new.sequence_id > 0 then
    return new;
  end if;
  -- Le verrou sur la ligne projet sérialise les créations concurrentes du même
  -- projet — sans lui, deux insertions simultanées tirent le même numéro et
  -- l'une des deux casse sur la contrainte d'unicité.
  perform 1 from public.pj_projects where id = new.pj_project_id for update;
  select coalesce(max(sequence_id), 0) + 1 into next_id
    from public.pj_issues where pj_project_id = new.pj_project_id;
  new.sequence_id := next_id;
  return new;
end $$;

drop trigger if exists trg_pj_issues_sequence on public.pj_issues;
create trigger trg_pj_issues_sequence before insert on public.pj_issues
  for each row execute function public.pj_assign_sequence_id();

-- `completed_at` se déduit du groupe de l'état : le laisser à la charge du
-- client, c'est garantir qu'un jour une mise à jour passera à côté et qu'un
-- item terminé restera compté comme ouvert dans le burndown.
create or replace function public.pj_sync_completed_at()
returns trigger language plpgsql as $$
declare
  grp text;
begin
  select "group" into grp from public.pj_states where id = new.state_id;
  if grp = 'completed' then
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_pj_issues_completed on public.pj_issues;
create trigger trg_pj_issues_completed before insert or update of state_id on public.pj_issues
  for each row execute function public.pj_sync_completed_at();

create table if not exists public.pj_issue_assignees (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  pj_project_id uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (issue_id, user_id)
);
create index if not exists idx_pj_issue_assignees_user on public.pj_issue_assignees(user_id);
create index if not exists idx_pj_issue_assignees_issue on public.pj_issue_assignees(issue_id);

create table if not exists public.pj_issue_labels (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  label_id      uuid not null references public.pj_labels(id) on delete cascade,
  pj_project_id uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  unique (issue_id, label_id)
);
create index if not exists idx_pj_issue_labels_issue on public.pj_issue_labels(issue_id);

-- Les relations sont dirigées et posées PAR PAIRE par l'applicatif : poser
-- « A bloque B » écrit aussi « B est bloqué par A ». Les stocker à sens unique
-- obligerait chaque lecture d'un item à interroger la table deux fois.
create table if not exists public.pj_issue_relations (
  id             uuid primary key default gen_random_uuid(),
  issue_id       uuid not null references public.pj_issues(id) on delete cascade,
  related_id     uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  relation_type  text not null check (relation_type in
                   ('relates_to','duplicate','blocked_by','blocks',
                    'start_before','start_after','finish_before','finish_after')),
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  unique (issue_id, related_id, relation_type),
  check (issue_id <> related_id)
);
create index if not exists idx_pj_issue_relations on public.pj_issue_relations(issue_id);

create table if not exists public.pj_issue_comments (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  pj_project_id uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  actor_id      uuid references auth.users(id) on delete set null,
  comment_html  text not null default '',
  -- Un commentaire posté par un agent plutôt qu'une personne. On garde le nom
  -- affiché figé : l'agent peut être renommé, le fil doit rester lisible.
  agent_id      uuid,
  agent_name    text,
  edited_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_pj_issue_comments_issue on public.pj_issue_comments(issue_id, created_at);

-- Le journal. `field` nomme ce qui a changé, `old_value`/`new_value` le disent
-- en clair : c'est ce qui permet d'afficher « a changé la priorité de Basse à
-- Haute » sans avoir à rejouer l'historique.
create table if not exists public.pj_issue_activity (
  id            bigserial primary key,
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  pj_project_id uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  actor_id      uuid references auth.users(id) on delete set null,
  verb          text not null default 'updated' check (verb in ('created','updated','deleted')),
  field         text,
  old_value     text,
  new_value     text,
  -- Les identifiants derrière les libellés, pour pouvoir recliquer dessus.
  old_identifier uuid,
  new_identifier uuid,
  comment       text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists idx_pj_issue_activity_issue on public.pj_issue_activity(issue_id, created_at desc);

create table if not exists public.pj_issue_attachments (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  pj_project_id uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  storage_path  text not null,
  name          text not null,
  size_bytes    bigint not null default 0,
  mime_type     text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_pj_issue_attachments on public.pj_issue_attachments(issue_id);

-- Une seule table de réactions pour les items ET les commentaires : deux tables
-- identiques à un nom de clé près, c'est deux fois le même code de lecture.
create table if not exists public.pj_reactions (
  id            uuid primary key default gen_random_uuid(),
  target_type   text not null check (target_type in ('issue','comment')),
  target_id     uuid not null,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  reaction      text not null,
  created_at    timestamptz not null default now(),
  unique (target_type, target_id, user_id, reaction)
);
create index if not exists idx_pj_reactions_target on public.pj_reactions(target_type, target_id);

create table if not exists public.pj_issue_subscribers (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (issue_id, user_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Cycles (sprints) et modules (epics)
-- ────────────────────────────────────────────────────────────────────────────
-- Un item n'appartient qu'à UN cycle — c'est ce qui rend « le travail de cette
-- itération » dénombrable. Il peut en revanche appartenir à plusieurs modules :
-- une même tâche sert souvent deux chantiers.
create table if not exists public.pj_cycles (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text not null default '',
  start_date     date,
  end_date       date,
  owned_by       uuid references auth.users(id) on delete set null,
  sort_order     double precision not null default 65535,
  -- Le burndown d'un cycle terminé est figé à la clôture : le recalculer à la
  -- lecture donnerait une courbe qui bouge encore des mois après la fin.
  progress_snapshot jsonb not null default '{}'::jsonb,
  archived_at    timestamptz,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (start_date is null or end_date is null or start_date <= end_date)
);
create index if not exists idx_pj_cycles_project on public.pj_cycles(pj_project_id, start_date);

create table if not exists public.pj_cycle_issues (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid not null references public.pj_cycles(id) on delete cascade,
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  created_at    timestamptz not null default now(),
  -- Un item, un cycle : la contrainte est sur l'item, pas sur la paire.
  unique (issue_id)
);
create index if not exists idx_pj_cycle_issues_cycle on public.pj_cycle_issues(cycle_id);

create table if not exists public.pj_modules (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text not null default '',
  status         text not null default 'planned'
                 check (status in ('backlog','planned','in-progress','paused','completed','cancelled')),
  start_date     date,
  target_date    date,
  lead_id        uuid references auth.users(id) on delete set null,
  sort_order     double precision not null default 65535,
  archived_at    timestamptz,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_pj_modules_project on public.pj_modules(pj_project_id, sort_order);

create table if not exists public.pj_module_issues (
  id            uuid primary key default gen_random_uuid(),
  module_id     uuid not null references public.pj_modules(id) on delete cascade,
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (module_id, issue_id)
);
create index if not exists idx_pj_module_issues_module on public.pj_module_issues(module_id);
create index if not exists idx_pj_module_issues_issue on public.pj_module_issues(issue_id);

create table if not exists public.pj_module_members (
  id            uuid primary key default gen_random_uuid(),
  module_id     uuid not null references public.pj_modules(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  unique (module_id, user_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Vues sauvegardées, pages, intake, favoris
-- ────────────────────────────────────────────────────────────────────────────
-- Une vue = un jeu de filtres + un layout + les propriétés affichées. C'est le
-- même objet que ce que la barre de filtres manipule en mémoire, ce qui permet
-- de sauvegarder l'état courant sans le traduire.
create table if not exists public.pj_views (
  id             uuid primary key default gen_random_uuid(),
  -- Nullable : une vue peut porter sur tout l'espace plutôt que sur un projet.
  pj_project_id  uuid references public.pj_projects(id) on delete cascade,
  dashboard_id   uuid references public.service_dashboards(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  description    text not null default '',
  logo_props     jsonb not null default '{}'::jsonb,
  filters            jsonb not null default '{}'::jsonb,
  display_filters    jsonb not null default '{}'::jsonb,
  display_properties jsonb not null default '{}'::jsonb,
  -- 0 = privée (son auteur), 1 = partagée.
  access         int not null default 1 check (access in (0, 1)),
  owned_by       uuid references auth.users(id) on delete set null,
  sort_order     double precision not null default 65535,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_pj_views_project on public.pj_views(pj_project_id, sort_order);

create table if not exists public.pj_pages (
  id                uuid primary key default gen_random_uuid(),
  pj_project_id     uuid references public.pj_projects(id) on delete cascade,
  dashboard_id      uuid references public.service_dashboards(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  parent_id         uuid references public.pj_pages(id) on delete set null,
  name              text not null default '',
  description_html  text not null default '',
  color             text,
  logo_props        jsonb not null default '{}'::jsonb,
  access            int not null default 1 check (access in (0, 1)),
  owned_by          uuid references auth.users(id) on delete set null,
  is_locked         boolean not null default false,
  archived_at       timestamptz,
  view_props        jsonb not null default '{}'::jsonb,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_pj_pages_project on public.pj_pages(pj_project_id, updated_at desc);

create table if not exists public.pj_page_labels (
  id            uuid primary key default gen_random_uuid(),
  page_id       uuid not null references public.pj_pages(id) on delete cascade,
  label_id      uuid not null references public.pj_labels(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  unique (page_id, label_id)
);

-- L'intake : la file d'entrée. Un item y arrive sans état de travail et n'entre
-- dans le projet qu'une fois accepté — d'où un statut séparé de l'état.
create table if not exists public.pj_intake_issues (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  issue_id       uuid not null references public.pj_issues(id) on delete cascade,
  -- Valeurs Plane : -2 en attente, -1 rejeté, 0 mis en veille, 1 accepté,
  -- 2 doublon.
  status         int not null default -2 check (status in (-2, -1, 0, 1, 2)),
  snoozed_till   timestamptz,
  duplicate_to   uuid references public.pj_issues(id) on delete set null,
  source         text not null default 'in-app',
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (issue_id)
);
create index if not exists idx_pj_intake_project on public.pj_intake_issues(pj_project_id, status);

create table if not exists public.pj_favorites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  entity_type   text not null check (entity_type in ('project','cycle','module','view','page','issue')),
  entity_id     uuid not null,
  sort_order    double precision not null default 65535,
  created_at    timestamptz not null default now(),
  unique (user_id, entity_type, entity_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Amorçage d'un projet
-- ────────────────────────────────────────────────────────────────────────────
-- Les cinq états par défaut de Plane. Un projet livré sans état est un projet
-- où l'on ne peut rien créer : la première action de l'utilisateur ne doit pas
-- être d'aller configurer un référentiel.
create or replace function public.pj_seed_project_states()
returns trigger language plpgsql as $$
begin
  insert into public.pj_states (pj_project_id, workspace_id, name, color, "group", sequence, is_default)
  values
    (new.id, new.workspace_id, 'Backlog',     '#a3a3a3', 'backlog',   15000, false),
    (new.id, new.workspace_id, 'À faire',     '#3b82f6', 'unstarted', 25000, true),
    (new.id, new.workspace_id, 'En cours',    '#f59e0b', 'started',   35000, false),
    (new.id, new.workspace_id, 'Terminé',     '#16a34a', 'completed', 45000, false),
    (new.id, new.workspace_id, 'Annulé',      '#ef4444', 'cancelled', 55000, false)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists trg_pj_projects_seed on public.pj_projects;
create trigger trg_pj_projects_seed after insert on public.pj_projects
  for each row execute function public.pj_seed_project_states();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────
-- Une seule règle, appliquée partout : membre de l'espace = lecture et écriture.
-- Les rôles projet (pj_project_members.role) filtrent l'UI, pas la base — les
-- durcir ici demanderait une policy par table et par verbe, pour un produit qui
-- n'expose encore aucun invité externe.
do $$
declare
  t text;
begin
  foreach t in array array[
    'pj_projects','pj_project_members','pj_states','pj_labels','pj_estimates',
    'pj_estimate_points','pj_issue_types','pj_issues','pj_issue_assignees',
    'pj_issue_labels','pj_issue_relations','pj_issue_comments','pj_issue_activity',
    'pj_issue_attachments','pj_reactions','pj_issue_subscribers','pj_cycles',
    'pj_cycle_issues','pj_modules','pj_module_issues','pj_module_members',
    'pj_views','pj_pages','pj_page_labels','pj_intake_issues','pj_favorites'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "workspace members access %s" on public.%I', t, t);
    execute format($p$
      create policy "workspace members access %s" on public.%I for all
        using (exists (select 1 from public.workspace_members wm
                        where wm.workspace_id = %I.workspace_id and wm.user_id = auth.uid()))
        with check (exists (select 1 from public.workspace_members wm
                             where wm.workspace_id = %I.workspace_id and wm.user_id = auth.uid()))
    $p$, t, t, t, t);
  end loop;
end $$;

comment on table public.pj_projects is
  'Projet de suivi de travail (modèle Plane). Hébergé par un dashboard de service, ou par le tenant quand dashboard_id est nul.';
comment on column public.pj_issues.sort_order is
  'Rang de tri en float : le drag & drop insère entre deux cartes en écrivant une seule ligne, sans renuméroter la colonne.';
