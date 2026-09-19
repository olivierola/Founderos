-- 0226_plane_home.sql
-- La page d'accueil du suivi de travail : liens rapides et widgets réglables.
--
-- Deux tables, et la différence entre les deux est le seul point à retenir :
-- un lien rapide appartient à l'ÉQUIPE (le changelog, la doc interne, le
-- tableau de bord d'astreinte — tout le monde y va), tandis que la composition
-- de l'accueil appartient à la PERSONNE. Les ranger ensemble donnerait soit des
-- liens que chacun doit recréer, soit un accueil que le dernier qui l'a
-- réorganisé impose à tous.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Liens rapides
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pj_quick_links (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid not null references public.service_dashboards(id) on delete cascade,
  title         text not null,
  url           text not null,
  sort_order    double precision not null default 65535,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_pj_quick_links on public.pj_quick_links(dashboard_id, sort_order);

comment on table public.pj_quick_links is
  'Liens rapides du service : partagés par l''équipe, contrairement aux widgets d''accueil qui sont personnels.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Composition de l'accueil
-- ────────────────────────────────────────────────────────────────────────────
-- Une ligne par personne et par dashboard. `widgets` liste les blocs affichés
-- DANS L'ORDRE : stocker l'ordre dans le tableau plutôt que dans une colonne
-- de position évite une table de jointure pour cinq valeurs, et le réordonnancement
-- devient une seule écriture.
create table if not exists public.pj_home_prefs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid not null references public.service_dashboards(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  widgets       text[] not null default array['ai', 'quicklinks', 'recents', 'stickies', 'my_work'],
  updated_at    timestamptz not null default now(),
  unique (dashboard_id, user_id)
);

comment on column public.pj_home_prefs.widgets is
  'Les blocs affichés, dans l''ordre. Un tableau plutôt qu''une table de positions : cinq valeurs, une seule écriture pour les réordonner.';

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────
alter table public.pj_quick_links enable row level security;
drop policy if exists "workspace members access pj_quick_links" on public.pj_quick_links;
create policy "workspace members access pj_quick_links" on public.pj_quick_links for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = pj_quick_links.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                       where wm.workspace_id = pj_quick_links.workspace_id and wm.user_id = auth.uid()));

-- Les préférences sont personnelles : la règle est l'identité, pas
-- l'appartenance à l'espace.
alter table public.pj_home_prefs enable row level security;
drop policy if exists "own home prefs" on public.pj_home_prefs;
create policy "own home prefs" on public.pj_home_prefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
