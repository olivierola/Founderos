-- ════════════════════════════════════════════════════════════════════════════
-- Ressources de projet (« assets ») et matière de travail d'un work item
-- ════════════════════════════════════════════════════════════════════════════
-- Ce qui manquait : le MATÉRIAU. Un work item disait jusqu'ici ce qu'il faut
-- faire (nom, description, travail à faire) mais jamais SUR QUOI — le dépôt de
-- code, la maquette, le contrat, le jeu de données, la page du wiki. Chacun le
-- collait dans la description, en texte, où ni l'humain suivant ni l'agent ne
-- pouvaient le retrouver deux fois.
--
-- Deux tables, et pas une :
--   · pj_assets       — la bibliothèque DU PROJET. Une ressource y est décrite
--                       une fois et sert dix items ; c'est l'inverse d'une
--                       pièce jointe, qui appartient à un item et meurt avec.
--   · pj_issue_assets — le rattachement à un item, avec son rôle (matière à
--                       travailler, référence, ou production issue du travail).
--
-- La pièce jointe (pj_issue_attachments) reste : elle répond à « ce fichier-là,
-- pour cette discussion-là ». La ressource répond à « le dépôt du projet »,
-- qu'on ne réimporte pas à chaque tâche.

create table if not exists public.pj_assets (
  id            uuid primary key default gen_random_uuid(),
  pj_project_id uuid not null references public.pj_projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- Le genre commande l'affichage ET ce que l'agent peut en faire : un lien se
  -- visite, un extrait de code se lit sur place, un fichier se télécharge.
  kind          text not null default 'link'
                check (kind in ('link','file','code','doc','page','dataset','repo','design','api','other')),
  name          text not null,
  description   text not null default '',
  -- Un seul de ces quatre porteurs est rempli selon le genre ; la contrainte
  -- ne dit pas lequel, elle dit seulement qu'une ressource qui ne pointe nulle
  -- part et ne contient rien n'est pas une ressource.
  url           text,
  storage_path  text,
  content       text,
  page_id       uuid references public.pj_pages(id) on delete set null,
  language      text,
  mime_type     text,
  size_bytes    bigint not null default 0,
  tags          text[] not null default '{}',
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  constraint pj_assets_has_payload check (
    url is not null or storage_path is not null or content is not null or page_id is not null
  )
);
create index if not exists idx_pj_assets_project on public.pj_assets(pj_project_id, updated_at desc);
create index if not exists idx_pj_assets_kind on public.pj_assets(pj_project_id, kind);

create table if not exists public.pj_issue_assets (
  id           uuid primary key default gen_random_uuid(),
  issue_id     uuid not null references public.pj_issues(id) on delete cascade,
  asset_id     uuid not null references public.pj_assets(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- « input » est le défaut parce que c'est la question posée : sur quoi
  -- travaille-t-on. « output » sert au chemin inverse, quand un agent range ce
  -- qu'il a produit dans la bibliothèque du projet.
  role         text not null default 'input' check (role in ('input','reference','output')),
  note         text not null default '',
  added_by     uuid references auth.users(id) on delete set null,
  agent_id     uuid references public.internal_agents(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (issue_id, asset_id)
);
create index if not exists idx_pj_issue_assets_issue on public.pj_issue_assets(issue_id);
create index if not exists idx_pj_issue_assets_asset on public.pj_issue_assets(asset_id);

-- updated_at tenu en base : une ressource modifiée depuis un agent ou depuis
-- l'API ne passe pas par le formulaire qui le mettrait à jour côté client.
create or replace function public.pj_assets_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_pj_assets_touch on public.pj_assets;
create trigger trg_pj_assets_touch before update on public.pj_assets
  for each row execute function public.pj_assets_touch();

-- Le rattachement laisse une trace dans le journal de l'item. Sans elle, une
-- ressource apparaît ou disparaît d'une fiche sans que rien ne dise qui l'a
-- posée ni quand — et c'est justement la matière du travail.
create or replace function public.pj_issue_assets_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_issue   record;
  v_name    text;
begin
  select i.id, i.pj_project_id, i.workspace_id into v_issue
    from public.pj_issues i
   where i.id = coalesce(new.issue_id, old.issue_id);
  if not found then return coalesce(new, old); end if;

  select a.name into v_name from public.pj_assets a
   where a.id = coalesce(new.asset_id, old.asset_id);

  insert into public.pj_issue_activity (
    issue_id, pj_project_id, workspace_id, actor_id, verb, field,
    old_value, new_value, old_identifier, new_identifier
  ) values (
    v_issue.id, v_issue.pj_project_id, v_issue.workspace_id,
    coalesce(new.added_by, old.added_by),
    case when tg_op = 'INSERT' then 'created' else 'deleted' end,
    'resource',
    case when tg_op = 'DELETE' then v_name end,
    case when tg_op = 'INSERT' then v_name end,
    case when tg_op = 'DELETE' then old.asset_id end,
    case when tg_op = 'INSERT' then new.asset_id end
  );
  return coalesce(new, old);
end $$;

drop trigger if exists trg_pj_issue_assets_journal on public.pj_issue_assets;
create trigger trg_pj_issue_assets_journal
  after insert or delete on public.pj_issue_assets
  for each row execute function public.pj_issue_assets_journal();

-- Même règle que tout le module : membre de l'espace = lecture et écriture.
do $$
declare t text;
begin
  foreach t in array array['pj_assets','pj_issue_assets'] loop
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

comment on table public.pj_assets is
  'Bibliothèque de ressources d''un projet : dépôt, document, lien, extrait de code, jeu de données. Décrite une fois, rattachée à autant de work items qu''il faut.';
comment on table public.pj_issue_assets is
  'La matière d''un work item : les ressources sur lesquelles l''humain ou l''agent doit travailler (input), celles qui éclairent (reference), celles qui en sortent (output).';
