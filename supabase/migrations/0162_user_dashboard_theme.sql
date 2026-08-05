-- 0162_user_dashboard_theme.sql
-- The service dashboard's skin becomes a PERSONAL preference.
--
-- It was stored in service_dashboards.settings.theme (0158), i.e. shared by
-- every member of the service: picking "Midnight" repainted the dashboard for
-- the whole team. A theme is a comfort setting, not a team decision.
--
-- settings.theme stays readable as the service's default, so dashboards that
-- already carry one keep their look for anyone who has never chosen; the row
-- below wins as soon as a person picks for themselves.

create table if not exists public.user_dashboard_prefs (
  user_id      uuid not null references auth.users(id) on delete cascade,
  dashboard_id uuid not null references public.service_dashboards(id) on delete cascade,
  theme        text,
  updated_at   timestamptz not null default now(),
  primary key (user_id, dashboard_id)
);

alter table public.user_dashboard_prefs enable row level security;

-- Strictly own rows: nobody reads or writes anyone else's preferences.
drop policy if exists "own dashboard prefs" on public.user_dashboard_prefs;
create policy "own dashboard prefs" on public.user_dashboard_prefs for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
