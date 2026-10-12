-- 0273_functions_base_url.sql
-- Les tâches pg_cron appellent les fonctions à une URL réglable, et non plus à
-- celle du projet Supabase écrite en dur.
--
-- Six fonctions SQL lancées par pg_cron (drain_agent_ticks,
-- tick_agent_scheduler, reconcile_stalled_room_missions,
-- tick_workflow_scheduler, tick_sentinelflow…) postaient vers
-- https://scugmxahflsjabglodyv.supabase.co/functions/v1/…, avec la clé service
-- de la base dans l'en-tête. Deux conséquences :
--   · le backend Express (backend/) ne recevait jamais ces appels ;
--   · sur une installation dédiée, chaque tick aurait envoyé la clé service du
--     client vers NOTRE projet.
--
-- La base de l'URL vit désormais dans le vault, à côté de la clé service que
-- ces fonctions y lisent déjà : le secret `functions_base_url` (ex.
-- https://api.client.example ou http://founderos-backend.scic.svc:8787).
--
-- Une instance déjà en service (clé service présente dans le vault) reçoit
-- l'URL qu'elle utilisait : rien ne change pour elle. Une installation neuve
-- n'a pas encore de clé service au moment de la migration : on n'écrit rien, et
-- tant que le secret manque, les tâches échouent en le disant au lieu de partir
-- ailleurs.

create or replace function public.functions_base_url()
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'functions_base_url' limit 1;
  if coalesce(trim(v), '') = '' then
    raise exception 'functions_base_url absent du vault : select vault.create_secret(''https://<backend>'', ''functions_base_url'');';
  end if;
  return rtrim(trim(v), '/');
end;
$$;

revoke all on function public.functions_base_url() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'agent_service_key')
     and not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url') then
    perform vault.create_secret(
      'https://scugmxahflsjabglodyv.supabase.co',
      'functions_base_url',
      'Base des URL /functions/v1 appelées par pg_cron (migration 0273).'
    );
  end if;
end;
$$;

-- Réécriture à partir de la définition EN BASE de chaque fonction, pas d'une
-- copie : on garde exactement la dernière version (0096, 0185, 0199, 0262,
-- 0263…), à l'URL près. Droits et propriétaire sont conservés par
-- CREATE OR REPLACE.
do $$
declare
  r record;
  def text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc like '%''https://scugmxahflsjabglodyv.supabase.co/functions/v1/%'
  loop
    def := replace(
      pg_get_functiondef(r.oid),
      '''https://scugmxahflsjabglodyv.supabase.co/functions/v1/',
      'public.functions_base_url() || ''/functions/v1/'
    );
    execute def;
  end loop;

  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc like '%scugmxahflsjabglodyv.supabase.co/functions/v1/%'
  ) then
    raise exception 'Une fonction appelle encore l''URL du projet en dur : forme non prévue par 0273.';
  end if;
end;
$$;
