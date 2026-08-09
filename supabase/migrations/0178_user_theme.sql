-- 0178_user_theme.sql
-- The multi-theme switcher stops being a service-dashboard feature: a person
-- picks one skin and the whole app wears it — AI Workforce, Outils IA, Admin.
--
-- It lives on the profile because that is already the per-user row, with the
-- right policies (own row: select / update / insert, 0001). `user_dashboard_prefs`
-- (0162) stays as the per-service OVERRIDE for someone who wants one service to
-- look different from the rest.
--
-- Null means "never chosen" — the client then follows the OS light/dark
-- preference, as it did before.

alter table public.profiles
  add column if not exists theme text;
