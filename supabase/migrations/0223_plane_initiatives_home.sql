-- 0223_plane_initiatives_home.sql
-- Ce que 0221/0222 n'avaient pas porté : les objets qui vivent AU-DESSUS d'un
-- projet, et ceux qui appartiennent à une personne plutôt qu'à une équipe.
--
-- La distinction structure tout ce fichier. Un work item appartient à un
-- projet ; une initiative, elle, en traverse plusieurs, et un sticky
-- n'appartient qu'à celui qui l'a écrit. Les ranger dans les tables de 0221
-- aurait obligé à rendre `pj_project_id` nullable partout — c'est-à-dire à
-- perdre la garantie qui fait tenir le modèle.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Initiatives : le niveau au-dessus du projet
-- ────────────────────────────────────────────────────────────────────────────
-- Une initiative regroupe des PROJETS, là où un module regroupe des work items.
-- C'est l'objet du « pourquoi » — un objectif trimestriel, un chantier
-- transverse — et son avancement se déduit de celui des projets qu'elle porte,
-- jamais d'un pourcentage saisi à la main qui serait faux dès le lendemain.
create table if not exists public.pj_initiatives (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  logo_props    jsonb not null default '{}'::jsonb,
  status        text not null default 'active'
                check (status in ('planned','active','paused','completed','cancelled')),
  lead_id       uuid references auth.users(id) on delete set null,
  start_date    date,
  target_date   date,
  sort_order    double precision not null default 65535,
  archived_at   timestamptz,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_pj_initiatives_dash on public.pj_initiatives(dashboard_id, sort_order);

create table if not exists public.pj_initiative_projects (
  id             uuid primary key default gen_random_uuid(),
  initiative_id  uuid not null references public.pj_initiatives(id) on delete cascade,
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  unique (initiative_id, pj_project_id)
);

-- Une initiative peut aussi épingler des work items précis, sans embarquer tout
-- leur projet : c'est ce qui permet de suivre « les trois tickets qui bloquent »
-- sans dupliquer un projet entier dans l'initiative.
create table if not exists public.pj_initiative_issues (
  id             uuid primary key default gen_random_uuid(),
  initiative_id  uuid not null references public.pj_initiatives(id) on delete cascade,
  issue_id       uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  unique (initiative_id, issue_id)
);

/**
 * L'avancement d'une initiative : les items de ses projets PLUS ceux qu'elle
 * épingle, dédoublonnés. Sans le `union` sur les identifiants, un item à la
 * fois épinglé et membre d'un projet rattaché serait compté deux fois, et le
 * pourcentage dépasserait allègrement les 100.
 */
create or replace function public.pj_initiative_progress(p_initiative uuid)
returns table (total bigint, completed bigint, started bigint, overdue bigint, projects bigint)
language sql stable as $$
  with ids as (
    select i.id, i.target_date, i.completed_at, i.state_id
    from public.pj_issues i
    where i.archived_at is null and i.is_draft = false
      and (
        i.pj_project_id in (select pj_project_id from public.pj_initiative_projects where initiative_id = p_initiative)
        or i.id in (select issue_id from public.pj_initiative_issues where initiative_id = p_initiative)
      )
  )
  select
    count(*),
    count(*) filter (where s."group" = 'completed'),
    count(*) filter (where s."group" = 'started'),
    count(*) filter (where ids.target_date < current_date and ids.completed_at is null),
    (select count(*) from public.pj_initiative_projects where initiative_id = p_initiative)
  from ids left join public.pj_states s on s.id = ids.state_id;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Stickies : les notes personnelles
-- ────────────────────────────────────────────────────────────────────────────
-- Elles n'appartiennent qu'à leur auteur et ne sont partagées avec personne.
-- C'est le bloc-notes qu'on garde à côté du board — utile précisément parce que
-- rien de ce qu'on y met n'engage l'équipe.
create table if not exists public.pj_stickies (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  content       text not null default '',
  color         text not null default '#eda100',
  sort_order    double precision not null default 65535,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_pj_stickies_user on public.pj_stickies(user_id, sort_order);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Dashboards composables
-- ────────────────────────────────────────────────────────────────────────────
-- Un tableau de bord est une grille de widgets, chacun décrivant une question
-- (« combien d'items par état, sur ce projet ») plutôt qu'un résultat. Stocker
-- la question et non la réponse est ce qui permet au widget de rester juste
-- sans qu'aucun travail de fond ne le rafraîchisse.
create table if not exists public.pj_dashboards (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  owned_by      uuid references auth.users(id) on delete set null,
  access        int not null default 1 check (access in (0, 1)),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.pj_dashboard_widgets (
  id              uuid primary key default gen_random_uuid(),
  pj_dashboard_id uuid not null references public.pj_dashboards(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  kind            text not null check (kind in
                    ('count','distribution','progress','burndown','issue_list','overdue')),
  title           text not null default '',
  -- La question : le projet visé, la dimension, les filtres. Un jsonb parce que
  -- chaque type de widget a ses propres paramètres, et qu'une colonne par
  -- paramètre donnerait une table à trente colonnes vides.
  config          jsonb not null default '{}'::jsonb,
  -- Place dans la grille (react-grid-layout côté client).
  x               int not null default 0,
  y               int not null default 0,
  w               int not null default 4,
  h               int not null default 4,
  created_at      timestamptz not null default now()
);
create index if not exists idx_pj_widgets_dash on public.pj_dashboard_widgets(pj_dashboard_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Visites récentes
-- ────────────────────────────────────────────────────────────────────────────
-- Ce qui alimente le « Reprendre où vous en étiez » de l'accueil. On garde une
-- ligne par personne et par objet, mise à jour, plutôt qu'un historique : la
-- question posée est « qu'est-ce que j'ai ouvert récemment », pas « combien de
-- fois ».
create table if not exists public.pj_recent_visits (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  entity_type   text not null check (entity_type in ('project','issue','cycle','module','page','initiative')),
  entity_id     uuid not null,
  visited_at    timestamptz not null default now(),
  unique (user_id, entity_type, entity_id)
);
create index if not exists idx_pj_recent_user on public.pj_recent_visits(user_id, visited_at desc);

create or replace function public.pj_touch_visit(
  p_workspace uuid, p_dashboard uuid, p_type text, p_entity uuid
) returns void language sql security invoker as $$
  insert into public.pj_recent_visits (workspace_id, dashboard_id, user_id, entity_type, entity_id)
  values (p_workspace, p_dashboard, auth.uid(), p_type, p_entity)
  on conflict (user_id, entity_type, entity_id)
  do update set visited_at = now(), dashboard_id = excluded.dashboard_id;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Types de work item : de quoi les afficher
-- ────────────────────────────────────────────────────────────────────────────
-- 0221 avait la table mais rien pour la rendre : sans couleur ni icône, un type
-- ne se distingue pas d'un label, et la colonne de gauche d'une liste reste
-- muette.
alter table public.pj_issue_types
  add column if not exists color text not null default '#6b7280',
  add column if not exists icon text not null default 'Circle';

/**
 * Les quatre types de Plane, posés à la création d'un projet. Un projet livré
 * sans type oblige à passer par les réglages avant de pouvoir qualifier quoi
 * que ce soit — et personne ne le fait, donc personne n'utilise les types.
 */
create or replace function public.pj_seed_issue_types()
returns trigger language plpgsql as $$
begin
  insert into public.pj_issue_types (pj_project_id, workspace_id, name, color, icon, is_default, sort_order)
  values
    (new.id, new.workspace_id, 'Tâche',      '#2a78d6', 'CheckSquare', true,  1000),
    (new.id, new.workspace_id, 'Bug',        '#e34948', 'Bug',         false, 2000),
    (new.id, new.workspace_id, 'Amélioration','#1baf7a', 'Sparkle',    false, 3000),
    (new.id, new.workspace_id, 'Epic',       '#4a3aa7', 'Stack',       false, 4000)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists trg_pj_projects_seed_types on public.pj_projects;
create trigger trg_pj_projects_seed_types after insert on public.pj_projects
  for each row execute function public.pj_seed_issue_types();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. « Votre travail » : la vue personnelle, tous projets confondus
-- ────────────────────────────────────────────────────────────────────────────
/**
 * Ce qui m'est assigné dans tout le dashboard, avec de quoi l'afficher sans
 * une requête par projet. La fonction existe précisément parce que cette
 * question traverse les projets : la poser côté client obligerait à charger
 * tous les projets, puis tous leurs items, pour n'en garder qu'une poignée.
 */
create or replace function public.pj_my_work(p_dashboard uuid)
returns table (
  issue_id uuid, pj_project_id uuid, project_name text, identifier text,
  sequence_id int, name text, priority text, state_name text, state_group text,
  state_color text, target_date date, completed_at timestamptz
) language sql stable as $$
  select
    i.id, i.pj_project_id, p.name, p.identifier, i.sequence_id, i.name,
    i.priority, s.name, s."group", s.color, i.target_date, i.completed_at
  from public.pj_issue_assignees a
  join public.pj_issues i on i.id = a.issue_id
  join public.pj_projects p on p.id = i.pj_project_id
  left join public.pj_states s on s.id = i.state_id
  where a.user_id = auth.uid()
    and p.dashboard_id = p_dashboard
    and i.archived_at is null
    and i.is_draft = false
  order by
    -- En retard d'abord, puis par échéance, puis par priorité. C'est l'ordre
    -- dans lequel on veut voir sa propre liste : ce qui a déjà glissé, puis ce
    -- qui va glisser.
    (i.target_date < current_date and i.completed_at is null) desc,
    i.target_date nulls last,
    case i.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2
                    when 'low' then 3 else 4 end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────
-- Même règle que 0221 pour ce qui appartient à l'équipe…
do $$
declare t text;
begin
  foreach t in array array[
    'pj_initiatives','pj_initiative_projects','pj_initiative_issues',
    'pj_dashboards','pj_dashboard_widgets'
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

-- …et une règle plus stricte pour ce qui appartient à UNE personne. Un sticky
-- lisible par l'espace ne serait plus un bloc-notes.
do $$
declare t text;
begin
  foreach t in array array['pj_stickies','pj_recent_visits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows %s" on public.%I', t, t);
    execute format(
      'create policy "own rows %s" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t, t);
  end loop;
end $$;

comment on table public.pj_initiatives is
  'Regroupe des PROJETS (là où un module regroupe des work items). Son avancement se déduit, il ne se saisit pas.';
comment on table public.pj_stickies is
  'Bloc-notes personnel : visible de son seul auteur, ce qui est exactement ce qui le rend utile.';
