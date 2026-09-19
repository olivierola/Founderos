-- 0224_plane_teams_updates_graph.sql
-- Le dernier tiers de Plane : ce qui fait qu'un outil de suivi devient un outil
-- de PILOTAGE.
--
-- 0221-0223 savent dire ce qui est fait. Ce fichier ajoute de quoi dire si ça
-- va bien, ce qui n'est pas la même question. Un projet peut être à 80 % et
-- complètement à la dérive ; l'avancement le rate, la santé le dit.
--
-- Cinq apports : la santé et les points d'étape (status updates), les epics,
-- les teamspaces, les liens externes, et les règles de transition d'état.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Santé et points d'étape
-- ────────────────────────────────────────────────────────────────────────────
-- La santé est DÉCLARÉE, pas calculée — et c'est volontaire. Une règle
-- automatique (« en retard = à risque ») se trompe dans les deux sens : un
-- projet en avance peut être bloqué par un fournisseur, et un projet en retard
-- peut être parfaitement sous contrôle. Seul quelqu'un qui suit le dossier
-- peut trancher, d'où un champ qu'on pose à la main, avec sa date.
-- `create type` n'accepte pas `if not exists` : on le garde idempotent à la
-- main, sinon un rejeu de la migration échoue sur un type déjà présent.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pj_health') then
    create type pj_health as enum ('on_track', 'at_risk', 'off_track');
  end if;
end $$;

alter table public.pj_projects
  add column if not exists health pj_health,
  add column if not exists health_updated_at timestamptz;

alter table public.pj_initiatives
  add column if not exists health pj_health,
  add column if not exists health_updated_at timestamptz;

comment on column public.pj_projects.health is
  'Santé déclarée par une personne, jamais déduite : « en retard » et « à risque » sont deux choses différentes.';

/**
 * Les points d'étape. Chacun fige une santé À UNE DATE, avec le texte qui
 * l'explique — c'est ce qui permet de relire la trajectoire d'un chantier six
 * mois plus tard, là où un champ « santé » seul n'aurait gardé que la dernière
 * valeur.
 */
create table if not exists public.pj_status_updates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- Un update porte sur UN projet ou UNE initiative, jamais les deux.
  pj_project_id uuid references public.pj_projects(id) on delete cascade,
  initiative_id uuid references public.pj_initiatives(id) on delete cascade,
  health        pj_health not null default 'on_track',
  title         text not null default '',
  body          text not null default '',
  actor_id      uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (num_nonnulls(pj_project_id, initiative_id) = 1)
);
create index if not exists idx_pj_updates_project on public.pj_status_updates(pj_project_id, created_at desc);
create index if not exists idx_pj_updates_initiative on public.pj_status_updates(initiative_id, created_at desc);

/**
 * Le dernier point d'étape fixe la santé de son porteur. Sans ce report, on
 * aurait deux vérités — la pastille de la carte et le dernier update — qui
 * divergeraient dès le premier oubli.
 */
create or replace function public.pj_apply_status_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.pj_project_id is not null then
    update public.pj_projects
       set health = new.health, health_updated_at = new.created_at
     where id = new.pj_project_id;
  else
    update public.pj_initiatives
       set health = new.health, health_updated_at = new.created_at
     where id = new.initiative_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_pj_status_update on public.pj_status_updates;
create trigger trg_pj_status_update after insert on public.pj_status_updates
  for each row execute function public.pj_apply_status_update();

-- Réactions sur les points d'étape (les émojis de la capture). On réutilise la
-- table de 0221 en élargissant sa cible plutôt que d'en créer une troisième.
alter table public.pj_reactions drop constraint if exists pj_reactions_target_type_check;
alter table public.pj_reactions add constraint pj_reactions_target_type_check
  check (target_type in ('issue', 'comment', 'status_update'));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Epics
-- ────────────────────────────────────────────────────────────────────────────
-- Un epic est un work item d'un genre à part : il porte d'autres work items,
-- éventuellement d'AUTRES projets, et il peut être rattaché à une initiative.
-- On ne crée pas de table : c'est un `pj_issues` marqué, ce qui lui donne
-- gratuitement les états, labels, commentaires et le journal.
alter table public.pj_issues
  add column if not exists is_epic boolean not null default false;

create index if not exists idx_pj_issues_epic
  on public.pj_issues(pj_project_id) where is_epic;

comment on column public.pj_issues.is_epic is
  'Un epic est un work item, pas une entité à part : il hérite ainsi des états, labels, commentaires et du journal.';

-- Le rattachement d'un work item à un epic traverse les projets, ce que
-- `parent_id` ne permet pas de représenter proprement (un parent est du même
-- projet, et porte la numérotation).
create table if not exists public.pj_epic_issues (
  id            uuid primary key default gen_random_uuid(),
  epic_id       uuid not null references public.pj_issues(id) on delete cascade,
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (epic_id, issue_id),
  check (epic_id <> issue_id)
);
create index if not exists idx_pj_epic_issues on public.pj_epic_issues(epic_id);

create table if not exists public.pj_initiative_epics (
  id             uuid primary key default gen_random_uuid(),
  initiative_id  uuid not null references public.pj_initiatives(id) on delete cascade,
  epic_id        uuid not null references public.pj_issues(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  unique (initiative_id, epic_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Teamspaces
-- ────────────────────────────────────────────────────────────────────────────
-- Un teamspace est une ÉQUIPE avec les projets dont elle a la charge. Il ne
-- remplace pas le projet (qui est une unité de travail) : il répond à « qui
-- porte quoi », question que la liste des projets seule ne sait pas trancher
-- quand il y en a quarante.
create table if not exists public.pj_teamspaces (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  logo_props    jsonb not null default '{}'::jsonb,
  lead_id       uuid references auth.users(id) on delete set null,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.pj_teamspace_members (
  id            uuid primary key default gen_random_uuid(),
  teamspace_id  uuid not null references public.pj_teamspaces(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  unique (teamspace_id, user_id)
);

create table if not exists public.pj_teamspace_projects (
  id             uuid primary key default gen_random_uuid(),
  teamspace_id   uuid not null references public.pj_teamspaces(id) on delete cascade,
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  unique (teamspace_id, pj_project_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Liens externes
-- ────────────────────────────────────────────────────────────────────────────
-- La PR, le document, le ticket du client. `pj_issues.link_count` existait
-- depuis 0221 mais restait à zéro faute de table pour le remplir.
create table if not exists public.pj_links (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  issue_id      uuid references public.pj_issues(id) on delete cascade,
  initiative_id uuid references public.pj_initiatives(id) on delete cascade,
  url           text not null,
  title         text not null default '',
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  check (num_nonnulls(issue_id, initiative_id) = 1)
);
create index if not exists idx_pj_links_issue on public.pj_links(issue_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Règles de transition d'état
-- ────────────────────────────────────────────────────────────────────────────
-- Interdire certains passages (« on ne ferme pas sans relecture »). La règle
-- est posée en base et pas seulement dans l'UI : une contrainte qu'on peut
-- contourner par un appel direct n'est pas une contrainte, c'est une
-- suggestion.
create table if not exists public.pj_state_transitions (
  id             uuid primary key default gen_random_uuid(),
  pj_project_id  uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  from_state_id  uuid not null references public.pj_states(id) on delete cascade,
  to_state_id    uuid not null references public.pj_states(id) on delete cascade,
  unique (from_state_id, to_state_id)
);

alter table public.pj_projects
  add column if not exists enforce_transitions boolean not null default false;

create or replace function public.pj_check_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  enforced boolean;
begin
  if new.state_id is not distinct from old.state_id then return new; end if;
  if old.state_id is null then return new; end if;

  select enforce_transitions into enforced from public.pj_projects where id = new.pj_project_id;
  if not coalesce(enforced, false) then return new; end if;

  -- Un projet qui active la contrainte sans avoir déclaré la moindre règle
  -- bloquerait TOUT. On considère alors qu'aucune règle n'a encore été posée et
  -- on laisse passer : mieux vaut une contrainte inactive qu'un projet gelé.
  if not exists (select 1 from public.pj_state_transitions where pj_project_id = new.pj_project_id) then
    return new;
  end if;

  if not exists (
    select 1 from public.pj_state_transitions t
    where t.from_state_id = old.state_id and t.to_state_id = new.state_id
  ) then
    raise exception 'Transition interdite : % → %',
      pj_label_for('state', old.state_id), pj_label_for('state', new.state_id)
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_pj_issues_transition on public.pj_issues;
create trigger trg_pj_issues_transition before update of state_id on public.pj_issues
  for each row execute function public.pj_check_transition();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Le graphe de travail
-- ────────────────────────────────────────────────────────────────────────────
/**
 * Renvoie le graphe entier d'un dashboard — initiatives, projets, epics, et les
 * arêtes entre eux — en UNE requête.
 *
 * Le client pourrait le reconstituer à partir de quatre listes, mais il lui
 * manquerait ce qui coûte cher : le pourcentage d'avancement de chaque nœud,
 * qui suppose de compter les items de chaque projet. Le faire ici évite N+1
 * requêtes pour un écran dont l'intérêt est justement de tout montrer.
 */
create or replace function public.pj_workgraph(p_dashboard uuid)
returns table (
  node_kind text, node_id uuid, label text, sub_label text,
  health text, status text, lead_id uuid, percent int, parent_id uuid
) language sql stable as $$
  with proj as (
    select p.id, p.name, p.identifier, p.lead_id, p.health::text as health,
           count(i.*) filter (where i.archived_at is null and not i.is_draft) as total,
           count(i.*) filter (where s."group" = 'completed') as done
    from public.pj_projects p
    left join public.pj_issues i on i.pj_project_id = p.id
    left join public.pj_states s on s.id = i.state_id
    where p.dashboard_id = p_dashboard and p.archived_at is null
    group by p.id
  )
  select 'initiative', ini.id, ini.name, '', ini.health::text, ini.status, ini.lead_id,
         coalesce((select (ip.completed * 100 / nullif(ip.total, 0))::int
                   from public.pj_initiative_progress(ini.id) ip), 0),
         null::uuid
  from public.pj_initiatives ini
  where ini.dashboard_id = p_dashboard and ini.archived_at is null

  union all
  select 'project', proj.id, proj.name, proj.identifier, proj.health, null, proj.lead_id,
         coalesce((proj.done * 100 / nullif(proj.total, 0))::int, 0),
         (select ip.initiative_id from public.pj_initiative_projects ip
           where ip.pj_project_id = proj.id limit 1)
  from proj

  union all
  select 'epic', e.id, e.name, p.identifier || '-' || e.sequence_id, null, null, null,
         coalesce((
           select (count(*) filter (where st."group" = 'completed') * 100
                   / nullif(count(*), 0))::int
           from public.pj_epic_issues ei
           join public.pj_issues ci on ci.id = ei.issue_id
           left join public.pj_states st on st.id = ci.state_id
           where ei.epic_id = e.id
         ), 0),
         e.pj_project_id
  from public.pj_issues e
  join public.pj_projects p on p.id = e.pj_project_id
  where e.is_epic and p.dashboard_id = p_dashboard and e.archived_at is null;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Jetons d'API personnels
-- ────────────────────────────────────────────────────────────────────────────
-- On stocke un HACHAGE, jamais le jeton : une base lue par un tiers ne doit pas
-- lui livrer des clés utilisables. Le secret n'est montré qu'une fois, à la
-- création.
create table if not exists public.pj_api_tokens (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  label         text not null,
  token_hash    text not null,
  token_prefix  text not null,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_pj_tokens_user on public.pj_api_tokens(user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'pj_status_updates','pj_epic_issues','pj_initiative_epics','pj_teamspaces',
    'pj_teamspace_members','pj_teamspace_projects','pj_links','pj_state_transitions'
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

alter table public.pj_api_tokens enable row level security;
drop policy if exists "own api tokens" on public.pj_api_tokens;
create policy "own api tokens" on public.pj_api_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table public.pj_status_updates is
  'Points d''étape : chacun fige une santé À UNE DATE avec son explication, ce qu''un champ santé seul ne garde pas.';
comment on function public.pj_workgraph is
  'Le graphe entier d''un dashboard en une requête — les pourcentages inclus, qui sont la partie coûteuse.';
