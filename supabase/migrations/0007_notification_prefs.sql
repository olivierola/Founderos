-- FounderOS — notification preferences per user
alter table public.profiles
  add column if not exists notification_prefs jsonb default '{}'::jsonb;
