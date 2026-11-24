-- 0319 — Le parcours d'arrivée d'un utilisateur, et la vue de l'équipe sur ses utilisateurs.
--
-- À la première connexion, une personne répond à quelques questions sur elle :
-- son profil, son métier, son secteur, la taille de son équipe, comment elle
-- nous a connus, ce qu'elle attend et ce qu'elle veut faire du produit. Chaque
-- question propose des réponses et accepte une réponse libre.
--
--   user_onboarding_profiles   ses réponses (colonnes pour filtrer, `answers` pour le brut)
--   platform_staff             les comptes de l'équipe qui opère la plateforme
--   is_platform_staff()        vrai pour un membre de l'équipe
--   platform_user_overview()   la liste des utilisateurs et de leurs réponses, pour l'équipe seulement
--
-- Les réponses servent à personnaliser ce que la personne voit (premier agent
-- proposé, raccourcis de l'accueil) ; la vue d'équipe ne lit que ce qui est ici
-- et l'adresse du compte.

create table if not exists public.user_onboarding_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  first_name        text,
  -- Une valeur proposée (founder, developer…) ou une réponse libre.
  persona           text,
  job_title         text,
  industry          text,
  company_size      text,
  discovery_source  text,
  discovery_detail  text,
  goals             text[] not null default '{}',
  use_cases         text[] not null default '{}',
  ai_experience     text,
  expectations      text,
  -- Toutes les réponses telles que saisies, question par question.
  answers           jsonb not null default '{}'::jsonb,
  step              integer not null default 0,
  completed_at      timestamptz,
  skipped_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.user_onboarding_profiles enable row level security;

drop policy if exists "user_onboarding_profiles_select_own" on public.user_onboarding_profiles;
create policy "user_onboarding_profiles_select_own" on public.user_onboarding_profiles
  for select using (user_id = auth.uid());
drop policy if exists "user_onboarding_profiles_insert_own" on public.user_onboarding_profiles;
create policy "user_onboarding_profiles_insert_own" on public.user_onboarding_profiles
  for insert with check (user_id = auth.uid());
drop policy if exists "user_onboarding_profiles_update_own" on public.user_onboarding_profiles;
create policy "user_onboarding_profiles_update_own" on public.user_onboarding_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists idx_user_onboarding_profiles_completed
  on public.user_onboarding_profiles(completed_at desc);

-- ── L'équipe de la plateforme ────────────────────────────────────────────────
-- Un compte y entre par une ligne écrite à la main (ou par un membre déjà en
-- place, via platform_staff_grant). Personne ne s'y ajoute seul.
create table if not exists public.platform_staff (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  added_by  uuid references auth.users(id) on delete set null,
  added_at  timestamptz not null default now()
);

alter table public.platform_staff enable row level security;
drop policy if exists "platform_staff_select_self" on public.platform_staff;
create policy "platform_staff_select_self" on public.platform_staff
  for select using (user_id = auth.uid());

create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_staff s where s.user_id = auth.uid())
      or exists (select 1 from auth.users u where u.id = auth.uid() and coalesce(u.is_super_admin, false));
$$;

grant execute on function public.is_platform_staff() to authenticated;

-- Un membre de l'équipe peut en ajouter un autre, par son adresse.
create or replace function public.platform_staff_grant(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_platform_staff() then
    raise exception 'réservé à l''équipe de la plateforme' using errcode = '42501';
  end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_id is null then return false; end if;
  insert into public.platform_staff (user_id, added_by) values (v_id, auth.uid())
    on conflict (user_id) do nothing;
  return true;
end;
$$;

grant execute on function public.platform_staff_grant(text) to authenticated;

-- La vue de l'équipe : chaque compte, ses réponses, et ce qu'il a déjà créé.
create or replace function public.platform_user_overview()
returns table (
  user_id           uuid,
  email             text,
  signed_up_at      timestamptz,
  last_sign_in_at   timestamptz,
  first_name        text,
  persona           text,
  job_title         text,
  industry          text,
  company_size      text,
  discovery_source  text,
  discovery_detail  text,
  goals             text[],
  use_cases         text[],
  ai_experience     text,
  expectations      text,
  answers           jsonb,
  completed_at      timestamptz,
  skipped_at        timestamptz,
  workspaces        bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_staff() then
    raise exception 'réservé à l''équipe de la plateforme' using errcode = '42501';
  end if;
  return query
    select
      u.id, u.email::text, u.created_at, u.last_sign_in_at,
      p.first_name, p.persona, p.job_title, p.industry, p.company_size,
      p.discovery_source, p.discovery_detail,
      coalesce(p.goals, '{}'), coalesce(p.use_cases, '{}'),
      p.ai_experience, p.expectations, coalesce(p.answers, '{}'::jsonb),
      p.completed_at, p.skipped_at,
      (select count(*) from public.workspace_members m where m.user_id = u.id)
    from auth.users u
    left join public.user_onboarding_profiles p on p.user_id = u.id
    order by u.created_at desc nulls last;
end;
$$;

grant execute on function public.platform_user_overview() to authenticated;
