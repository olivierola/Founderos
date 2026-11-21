-- 0306 — Rappels de l'accueil.
--
-- Un rappel personnel, posé depuis l'accueil d'un tableau de service :
-- « relancer le client jeudi », « relire le livrable de Vibe Coder ». Il
-- n'appartient qu'à celui qui l'écrit, comme la composition de l'accueil
-- (0226) ; les échéances partagées vivent sur les work items.
--
-- L'accueil y mêle, sans les stocker, les missions planifiées à venir et les
-- work items arrivant à échéance.

create table if not exists public.sd_home_reminders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dashboard_id uuid not null references public.service_dashboards(id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 300),
  due_at       timestamptz,
  done_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists sd_home_reminders_user_dash_idx
  on public.sd_home_reminders (user_id, dashboard_id, done_at, due_at);

alter table public.sd_home_reminders enable row level security;

drop policy if exists sd_home_reminders_own on public.sd_home_reminders;
create policy sd_home_reminders_own on public.sd_home_reminders
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
