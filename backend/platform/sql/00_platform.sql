-- 00_platform.sql — ce que Supabase fournit à la base, recréé sur un PostgreSQL
-- ordinaire, pour que supabase/migrations s'y applique TELLES QUELLES.
--
-- Appliqué par le backend (mode PLATFORM=self) avant les migrations, à chaque
-- démarrage : tout est idempotent.
--
-- Fidélité d'abord : les tables d'auth et de storage reprennent les colonnes de
-- GoTrue et de Supabase Storage. Un dump d'un projet Supabase (schémas public,
-- auth, storage) se restaure donc ici sans conversion — mots de passe compris,
-- GoTrue les hache en bcrypt comme ce backend.
--
-- Trois extensions de Supabase ne sont pas disponibles sur un PostgreSQL
-- standard ; elles sont REMPLACÉES par des schémas aux mêmes noms et aux mêmes
-- signatures, dont le backend fait le travail :
--   pg_cron → cron.schedule / cron.unschedule ; le backend exécute les tâches.
--   pg_net  → net.http_post / net.http_get ; le backend envoie les requêtes.
--   pgmq    → pgmq.create / send / read / delete / archive / pop, en pur SQL.

-- ── Rôles ───────────────────────────────────────────────────────────────────
-- Les trois rôles que PostgREST endosse selon le JWT. service_role contourne
-- la RLS, comme chez Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  -- Les migrations ne s'y réfèrent pas, mais les dumps Supabase si.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'dashboard_user') then create role dashboard_user nologin; end if;
end $$;

-- Le rôle qui se connecte (celui de DATABASE_URL) doit pouvoir endosser les
-- trois, comme `authenticator` chez Supabase.
do $$
begin
  execute format('grant anon, authenticated, service_role to %I', current_user);
exception when others then null;
end $$;

-- ── Extensions ──────────────────────────────────────────────────────────────
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Seulement ce que Supabase préinstalle dans `extensions`. vector et pg_trgm,
-- eux, sont créés par les migrations (0016, 0289) sans schéma, donc dans
-- public — comme sur l'instance SaaS, où les fonctions `set search_path =
-- public` trouvent ainsi l'opérateur <=>.
do $$
declare e text;
begin
  foreach e in array array['pgcrypto', 'uuid-ossp'] loop
    begin
      execute format('create extension if not exists %I with schema extensions', e);
    exception when others then
      raise warning 'extension % indisponible sur ce serveur : %', e, sqlerrm;
    end;
  end loop;
end $$;

-- Chez Supabase, `extensions` est dans le search_path de tout le monde : les
-- migrations écrivent vector(1024), digest(), gen_random_bytes() sans schéma.
do $$
begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
exception when others then null;
end $$;
alter role anon set search_path = "$user", public, extensions;
alter role authenticated set search_path = "$user", public, extensions;
alter role service_role set search_path = "$user", public, extensions;

-- ── public : les droits par défaut de Supabase ──────────────────────────────
-- Tout objet créé dans public est accessible aux trois rôles ; c'est la RLS qui
-- garde les données. Sans ces droits par défaut, une table créée par une
-- migration serait invisible au front.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ── auth ────────────────────────────────────────────────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

do $$ begin create type auth.aal_level as enum ('aal1', 'aal2', 'aal3'); exception when duplicate_object then null; end $$;
do $$ begin create type auth.factor_type as enum ('totp', 'webauthn', 'phone'); exception when duplicate_object then null; end $$;
do $$ begin create type auth.factor_status as enum ('unverified', 'verified'); exception when duplicate_object then null; end $$;
do $$ begin create type auth.code_challenge_method as enum ('s256', 'plain'); exception when duplicate_object then null; end $$;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text unique default null,
  phone_confirmed_at timestamptz,
  phone_change text default '',
  phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until timestamptz,
  reauthentication_token varchar(255) default '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
create unique index if not exists users_email_partial_key on auth.users (lower(email)) where is_sso_user = false;
create index if not exists users_instance_id_email_idx on auth.users (instance_id, lower(email));

create table if not exists auth.identities (
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  id uuid primary key default gen_random_uuid(),
  unique (provider_id, provider)
);
create index if not exists identities_user_id_idx on auth.identities (user_id);

create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal auth.aal_level,
  not_after timestamptz,
  refreshed_at timestamp,
  user_agent text,
  ip inet,
  tag text
);
create index if not exists sessions_user_id_idx on auth.sessions (user_id);

create table if not exists auth.refresh_tokens (
  instance_id uuid,
  id bigserial primary key,
  token varchar(255) unique,
  user_id varchar(255),
  revoked boolean,
  created_at timestamptz,
  updated_at timestamptz,
  parent varchar(255),
  session_id uuid references auth.sessions(id) on delete cascade
);

create table if not exists auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type auth.factor_type not null,
  status auth.factor_status not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  secret text,
  phone text,
  last_challenged_at timestamptz
);

create table if not exists auth.mfa_challenges (
  id uuid primary key,
  factor_id uuid not null references auth.mfa_factors(id) on delete cascade,
  created_at timestamptz not null,
  verified_at timestamptz,
  ip_address inet,
  otp_code text
);

create table if not exists auth.mfa_amr_claims (
  session_id uuid not null references auth.sessions(id) on delete cascade,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  authentication_method text not null,
  id uuid primary key,
  unique (session_id, authentication_method)
);

create table if not exists auth.flow_state (
  id uuid primary key,
  user_id uuid,
  auth_code text not null,
  code_challenge_method auth.code_challenge_method not null,
  code_challenge text not null,
  provider_type text not null,
  provider_access_token text,
  provider_refresh_token text,
  created_at timestamptz,
  updated_at timestamptz,
  authentication_method text not null,
  auth_code_issued_at timestamptz
);

create table if not exists auth.one_time_tokens (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  token_type text not null,
  token_hash text not null,
  relates_to text not null,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create table if not exists auth.audit_log_entries (
  instance_id uuid,
  id uuid primary key,
  payload json,
  created_at timestamptz,
  ip_address varchar(64) not null default ''
);

create table if not exists auth.sso_providers (
  id uuid primary key,
  resource_id text,
  created_at timestamptz,
  updated_at timestamptz
);
create table if not exists auth.sso_domains (
  id uuid primary key,
  sso_provider_id uuid not null references auth.sso_providers(id) on delete cascade,
  domain text not null,
  created_at timestamptz,
  updated_at timestamptz
);

-- Les fournisseurs OIDC ajoutés à chaud (GOTRUE_CUSTOM_OAUTH_ENABLED) : ce que
-- sso-admin enregistre par /auth/v1/admin/custom-providers.
create table if not exists auth.custom_oauth_providers (
  identifier text primary key,
  provider_type text not null default 'oidc',
  name text not null,
  client_id text not null,
  client_secret text,
  issuer text not null,
  scopes text[] not null default array['openid', 'profile', 'email'],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ce que les politiques RLS appellent. Lisent les réglages que le backend pose
-- dans chaque transaction, exactement comme PostgREST.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;
-- Les tables d'auth ne sont lisibles que par le service (le backend) ; les
-- fonctions SECURITY DEFINER des migrations les lisent sous leur propriétaire.
grant select on all tables in schema auth to service_role;

-- ── storage ─────────────────────────────────────────────────────────────────
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text,
  owner_id text,
  user_metadata jsonb
);
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
create index if not exists name_prefix_search on storage.objects (name text_pattern_ops);

-- Comme chez Supabase : la RLS est active sur les objets, et ce sont les
-- politiques des migrations qui disent qui lit et qui écrit.
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
do $$ begin
  create policy "service role all buckets" on storage.buckets for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "public read buckets" on storage.buckets for select using (true);
exception when duplicate_object then null; end $$;

create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;

create or replace function storage.filename(name text) returns text
language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;

create or replace function storage.extension(name text) returns text
language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;

grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text) to anon, authenticated, service_role;

-- ── vault ───────────────────────────────────────────────────────────────────
-- Les secrets sont chiffrés (pgcrypto) avec une clé tirée au premier démarrage
-- et gardée dans la base, hors de portée des rôles d'API — l'équivalent de la
-- clé serveur de pgsodium chez Supabase.
create schema if not exists vault;
revoke all on schema vault from public;
grant usage on schema vault to service_role;

create table if not exists vault._key (id int primary key default 1 check (id = 1), key text not null);
insert into vault._key (key)
  select encode(extensions.gen_random_bytes(32), 'hex')
  where not exists (select 1 from vault._key);

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function vault._encrypt(p text) returns text
language sql security definer set search_path = vault, extensions as $$
  select encode(extensions.pgp_sym_encrypt(p, (select key from vault._key)), 'base64')
$$;
create or replace function vault._decrypt(p text) returns text
language sql security definer set search_path = vault, extensions as $$
  select extensions.pgp_sym_decrypt(decode(p, 'base64'), (select key from vault._key))
$$;

create or replace view vault.decrypted_secrets as
  select id, name, description, secret, vault._decrypt(secret) as decrypted_secret,
         key_id, nonce, created_at, updated_at
    from vault.secrets;

create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql security definer set search_path = vault as $$
declare rec_id uuid;
begin
  insert into vault.secrets (secret, name, description)
  values (vault._encrypt(new_secret), new_name, coalesce(new_description, ''))
  returning id into rec_id;
  return rec_id;
end $$;

create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql security definer set search_path = vault as $$
begin
  update vault.secrets set
    secret = coalesce(vault._encrypt(new_secret), secret),
    name = coalesce(new_name, name),
    description = coalesce(new_description, description),
    updated_at = now()
  where id = secret_id;
end $$;

revoke all on all tables in schema vault from public, anon, authenticated;
revoke all on all functions in schema vault from public, anon, authenticated;
grant select on vault.decrypted_secrets, vault.secrets to service_role;
grant execute on function vault.create_secret(text, text, text, uuid), vault.update_secret(uuid, text, text, text, uuid) to service_role;

-- ── cron (à la place de pg_cron) ────────────────────────────────────────────
-- Mêmes tables et mêmes fonctions ; le backend (src/platform/workers.ts) lit
-- cron.job et exécute les commandes à l'heure dite, en notant chaque passage
-- dans cron.job_run_details.
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport int not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);
create table if not exists cron.job_run_details (
  jobid bigint,
  runid bigserial primary key,
  job_pid int,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

-- Un passage = un créneau réservé : avec plusieurs instances du backend, la
-- première qui l'insère l'exécute, les autres passent leur tour.
create table if not exists cron._slots (
  jobid bigint not null,
  slot timestamptz not null,
  primary key (jobid, slot)
);

create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql as $$
declare id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid into id;
  return id;
end $$;

create or replace function cron.schedule(schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (schedule, command) values (schedule, command) returning jobid
$$;

create or replace function cron.unschedule(job_name text) returns boolean
language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  if not found then raise exception 'could not find valid entry for job ''%''', job_name; end if;
  return true;
end $$;

create or replace function cron.unschedule(job_id bigint) returns boolean
language plpgsql as $$
begin
  delete from cron.job where jobid = job_id;
  if not found then raise exception 'could not find valid entry for job ''%''', job_id; end if;
  return true;
end $$;

-- ── net (à la place de pg_net) ──────────────────────────────────────────────
-- Une requête est mise en file et notifiée ; le backend l'envoie aussitôt et
-- range la réponse dans net._http_response, comme pg_net.
create schema if not exists net;
create table if not exists net.http_request_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb,
  body bytea,
  timeout_milliseconds int not null default 5000,
  created timestamptz not null default now()
);
create table if not exists net._http_response (
  id bigint primary key,
  status_code int,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint
language plpgsql security definer set search_path = net as $$
declare id bigint; full_url text := url;
begin
  if params is not null and params <> '{}'::jsonb then
    full_url := url || case when position('?' in url) > 0 then '&' else '?' end
      || (select string_agg(key || '=' || value, '&') from jsonb_each_text(params));
  end if;
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', full_url, headers, convert_to(coalesce(body, '{}'::jsonb)::text, 'UTF8'), timeout_milliseconds)
  returning net.http_request_queue.id into id;
  perform pg_notify('platform_net', id::text);
  return id;
end $$;

create or replace function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint
language plpgsql security definer set search_path = net as $$
declare id bigint; full_url text := url;
begin
  if params is not null and params <> '{}'::jsonb then
    full_url := url || case when position('?' in url) > 0 then '&' else '?' end
      || (select string_agg(key || '=' || value, '&') from jsonb_each_text(params));
  end if;
  insert into net.http_request_queue (method, url, headers, timeout_milliseconds)
  values ('GET', full_url, headers, timeout_milliseconds)
  returning net.http_request_queue.id into id;
  perform pg_notify('platform_net', id::text);
  return id;
end $$;

-- ── pgmq ────────────────────────────────────────────────────────────────────
-- Une seule table pour toutes les files. La sémantique de pgmq est gardée :
-- read() rend invisibles les messages lus pendant `vt` secondes ; un message
-- non supprimé réapparaît (c'est ce qui rattrape un worker tué).
create schema if not exists pgmq;
do $$ begin
  create type pgmq.message_record as (msg_id bigint, read_ct int, enqueued_at timestamptz, vt timestamptz, message jsonb);
exception when duplicate_object then null; end $$;

create table if not exists pgmq.meta (queue_name text primary key, created_at timestamptz not null default now());
create table if not exists pgmq.messages (
  msg_id bigserial primary key,
  queue_name text not null,
  read_ct int not null default 0,
  enqueued_at timestamptz not null default now(),
  vt timestamptz not null default now(),
  message jsonb
);
create index if not exists pgmq_messages_queue_vt on pgmq.messages (queue_name, vt);
create table if not exists pgmq.archive (like pgmq.messages including defaults, archived_at timestamptz not null default now());

create or replace function pgmq.create(queue_name text) returns void
language sql as $$ insert into pgmq.meta (queue_name) values (queue_name) on conflict do nothing $$;

create or replace function pgmq.send(queue_name text, msg jsonb, delay int default 0) returns bigint
language sql as $$
  insert into pgmq.messages (queue_name, message, vt) values (queue_name, msg, now() + make_interval(secs => delay))
  returning msg_id
$$;

create or replace function pgmq.read(queue_name text, vt int, qty int) returns setof pgmq.message_record
language sql as $$
  with picked as (
    select m.msg_id from pgmq.messages m
     where m.queue_name = read.queue_name and m.vt <= now()
     order by m.msg_id
     limit qty
     for update skip locked
  )
  update pgmq.messages m
     set vt = now() + make_interval(secs => read.vt), read_ct = m.read_ct + 1
    from picked
   where m.msg_id = picked.msg_id
  returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
$$;

create or replace function pgmq.pop(queue_name text) returns setof pgmq.message_record
language sql as $$
  with picked as (
    select m.msg_id from pgmq.messages m
     where m.queue_name = pop.queue_name and m.vt <= now()
     order by m.msg_id limit 1 for update skip locked
  )
  delete from pgmq.messages m using picked where m.msg_id = picked.msg_id
  returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
$$;

create or replace function pgmq.delete(queue_name text, msg_id bigint) returns boolean
language plpgsql as $$
begin
  delete from pgmq.messages m where m.queue_name = delete.queue_name and m.msg_id = delete.msg_id;
  return found;
end $$;

create or replace function pgmq.archive(queue_name text, msg_id bigint) returns boolean
language plpgsql as $$
begin
  with moved as (
    delete from pgmq.messages m where m.queue_name = archive.queue_name and m.msg_id = archive.msg_id returning m.*
  )
  insert into pgmq.archive (msg_id, queue_name, read_ct, enqueued_at, vt, message)
    select msg_id, queue_name, read_ct, enqueued_at, vt, message from moved;
  return found;
end $$;

create or replace function pgmq.set_vt(queue_name text, msg_id bigint, vt int) returns setof pgmq.message_record
language sql as $$
  update pgmq.messages m set vt = now() + make_interval(secs => set_vt.vt)
   where m.queue_name = set_vt.queue_name and m.msg_id = set_vt.msg_id
  returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
$$;

-- ── realtime ────────────────────────────────────────────────────────────────
-- La publication que les migrations alimentent (`alter publication
-- supabase_realtime add table …`). Le backend y lit la liste des tables
-- diffusées et leur pose un déclencheur de notification (src/platform/realtime.ts).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
exception when others then
  raise warning 'publication supabase_realtime non créée : %', sqlerrm;
end $$;

create schema if not exists realtime;
create or replace function realtime.notify_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rec jsonb;
  old_rec jsonb;
  payload text;
begin
  rec := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  old_rec := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  payload := jsonb_build_object(
    'schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op,
    'commit_timestamp', now(), 'record', rec, 'old_record', old_rec
  )::text;
  -- NOTIFY est limité à 8000 octets : au-delà, on n'envoie que la clé, et le
  -- backend relit la ligne.
  if octet_length(payload) > 7900 then
    payload := jsonb_build_object(
      'schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op,
      'commit_timestamp', now(), 'truncated', true,
      'record', case when rec is null then null else jsonb_build_object('id', rec -> 'id') end,
      'old_record', case when old_rec is null then null else jsonb_build_object('id', old_rec -> 'id') end
    )::text;
  end if;
  perform pg_notify('platform_realtime', payload);
  return null;
end $$;

-- ── registre des migrations (le même que la CLI Supabase) ───────────────────
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
