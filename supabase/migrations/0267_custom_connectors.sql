-- 0267_custom_connectors.sql
-- Outils internes : des connecteurs que le client décrit lui-même.
--
-- Composio couvre les applications du marché. Il ne couvre pas ce qu'un client
-- héberge chez lui : Argo CD, Vault, Grafana, Loki, Prometheus, Jenkins, une API
-- maison… souvent derrière un SSO, sur une URL interne que le cloud ne voit pas.
--
-- Cinq objets :
--
--   · custom_connectors            la définition : URL de base, schéma
--                                  d'authentification, opérations déclarées,
--                                  politique de sécurité. Aucun secret.
--   · custom_connector_credentials les secrets, chiffrés (AES-GCM, même clé que
--                                  encrypted_credentials) OU laissés chez le
--                                  client (emplacement « relay » : on ne stocke
--                                  que des références env:/file:).
--   · connector_relays             le relais déployé dans l'infra du client.
--                                  Sortant seulement : il vient chercher le
--                                  travail, aucun port n'est ouvert chez lui.
--   · connector_relay_jobs         la file entre le cloud et le relais. Jamais de
--                                  secret en clair : les requêtes portent des
--                                  marqueurs {{secret:x}} résolus au moment où le
--                                  relais réclame la tâche, et les réponses sont
--                                  chiffrées au repos.
--   · custom_connector_calls       le journal d'accès : chaque appel, autorisé,
--                                  approuvé, refusé ou en erreur. En ajout seul,
--                                  chaîné par empreinte SHA-256 : une ligne
--                                  modifiée ou retirée se voit à la vérification.
--
-- Écritures : la définition s'édite depuis l'interface (owner/admin, RLS). Tout
-- ce qui touche un secret ou un relais passe par la fonction connector-action
-- (service role) : ces tables n'ont aucune policy d'écriture côté client.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Les relais
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.connector_relays (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  -- Seule l'empreinte du jeton est conservée ; le jeton est montré une fois.
  token_hash text not null unique,
  token_hint text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  -- Ce que le relais déclare à chaque contact. Déclaratif : l'autorité reste sa
  -- propre liste blanche, appliquée chez le client.
  last_seen_at timestamptz,
  last_ip text,
  version text,
  hostname text,
  reported_hosts text[] not null default '{}',
  reported_binaries text[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists connector_relays_project_idx on public.connector_relays(project_id);

alter table public.connector_relays enable row level security;

drop policy if exists "connector_relays: members read" on public.connector_relays;
create policy "connector_relays: members read"
on public.connector_relays for select
using (public.is_workspace_member(workspace_id));

-- L'empreinte du jeton ne sort pas de la base.
revoke select on public.connector_relays from anon, authenticated;
grant select (id, workspace_id, project_id, name, token_hint, status, last_seen_at, last_ip, version,
              hostname, reported_hosts, reported_binaries, created_by, created_at, revoked_at)
  on public.connector_relays to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Les connecteurs
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.custom_connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Rattaché à un service : seuls ses collaborateurs peuvent s'en servir.
  -- Null : tout le projet.
  service_dashboard_id uuid references public.service_dashboards(id) on delete set null,
  name text not null,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  template_key text,
  description text,
  icon text,
  base_url text not null default '',
  transport text not null default 'direct' check (transport in ('direct', 'relay')),
  relay_id uuid references public.connector_relays(id) on delete set null,
  auth_scheme text not null default 'none' check (auth_scheme in (
    'none', 'bearer', 'api_key', 'basic', 'headers',
    'oauth2_client_credentials', 'oauth2_authorization_code', 'session_login', 'mtls'
  )),
  -- Paramètres NON secrets du schéma : URL de jeton, client_id, nom d'en-tête…
  auth_config jsonb not null default '{}'::jsonb,
  operations jsonb not null default '[]'::jsonb,
  policy jsonb not null default '{}'::jsonb,
  -- draft : inerte, les collaborateurs ne le voient pas. disabled : coupe-circuit.
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled')),
  -- Ce qu'il reste à compléter à la main (écrit par le modèle ou l'assistant).
  setup_notes text,
  created_via text not null default 'manual' check (created_via in ('manual', 'template', 'assistant', 'openapi')),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_detail text,
  version integer not null default 1,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, slug)
);

create index if not exists custom_connectors_project_idx on public.custom_connectors(project_id);
create index if not exists custom_connectors_dashboard_idx on public.custom_connectors(service_dashboard_id);

alter table public.custom_connectors enable row level security;

drop policy if exists "custom_connectors: members read" on public.custom_connectors;
create policy "custom_connectors: members read"
on public.custom_connectors for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "custom_connectors: admins write" on public.custom_connectors;
create policy "custom_connectors: admins write"
on public.custom_connectors for all
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- Chaque modification de la définition est une nouvelle version : le journal
-- d'accès peut ainsi dire quelle version a servi.
create or replace function public.custom_connectors_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if (new.base_url, new.transport, new.relay_id, new.auth_scheme, new.auth_config, new.operations, new.policy)
     is distinct from
     (old.base_url, old.transport, old.relay_id, old.auth_scheme, old.auth_config, old.operations, old.policy) then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists custom_connectors_touch on public.custom_connectors;
create trigger custom_connectors_touch
before update on public.custom_connectors
for each row execute function public.custom_connectors_touch();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Les identifiants
-- ────────────────────────────────────────────────────────────────────────────
-- Plusieurs profils par connecteur (« lecture seule », « prod-admin », « SSO
-- d'Olivier ») : chaque collaborateur reçoit le profil dont il a besoin, pas
-- plus. Un profil est LIÉ aux origines vers lesquelles il a été saisi
-- (`binding`) : si l'URL du connecteur ou de son serveur de jetons change, le
-- secret n'est plus envoyé tant qu'on ne l'a pas ressaisi. Sans cela, modifier
-- l'URL suffirait à faire partir le jeton ailleurs.
create table if not exists public.custom_connector_credentials (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.custom_connectors(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null default 'Par défaut',
  location text not null default 'cloud' check (location in ('cloud', 'relay')),
  encrypted_payload text,
  iv text,
  -- Emplacement « relay » : nom du champ → env:NOM ou file:/chemin, lus par le
  -- relais chez le client. Pas un secret.
  relay_refs jsonb not null default '{}'::jsonb,
  -- Nom du champ → « ••••a1b2 » : de quoi reconnaître un secret sans le lire.
  hints jsonb not null default '{}'::jsonb,
  -- L'identité au nom de laquelle les appels partent (compte de service, SSO…).
  identity text,
  binding text not null,
  -- Vide : tous les collaborateurs autorisés à utiliser le connecteur.
  allowed_agent_ids uuid[] not null default '{}',
  expires_at timestamptz,
  -- Jeton obtenu (OAuth, session) mis en cache, chiffré.
  token_enc text,
  token_iv text,
  token_expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  last_used_at timestamptz
);

create index if not exists custom_connector_credentials_connector_idx
  on public.custom_connector_credentials(connector_id);

alter table public.custom_connector_credentials enable row level security;

drop policy if exists "custom_connector_credentials: members read" on public.custom_connector_credentials;
create policy "custom_connector_credentials: members read"
on public.custom_connector_credentials for select
using (public.is_workspace_member(workspace_id));

revoke select, insert, update, delete on public.custom_connector_credentials from anon, authenticated;
grant select (id, connector_id, workspace_id, label, location, relay_refs, hints, identity,
              allowed_agent_ids, expires_at, token_expires_at, status, created_by, created_at,
              rotated_at, last_used_at)
  on public.custom_connector_credentials to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. La file du relais
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.connector_relay_jobs (
  id uuid primary key default gen_random_uuid(),
  relay_id uuid not null references public.connector_relays(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connector_id uuid references public.custom_connectors(id) on delete cascade,
  credential_id uuid references public.custom_connector_credentials(id) on delete set null,
  -- La requête, marqueurs {{secret:x}} compris. Jamais de secret en clair.
  request jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'error', 'expired')),
  result_enc text,
  result_iv text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '2 minutes'
);

create index if not exists connector_relay_jobs_queue_idx
  on public.connector_relay_jobs(relay_id, status, created_at);

alter table public.connector_relay_jobs enable row level security;
-- Aucune policy : service role uniquement.

-- Réclamer la prochaine tâche, atomiquement. Deux relais sur le même jeton (une
-- réplique de plus) ne prennent jamais la même tâche.
create or replace function public.ccx_claim_relay_job(p_relay uuid)
returns setof public.connector_relay_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Ménage occasionnel : la file n'est pas un historique (le journal l'est).
  if random() < 0.02 then
    delete from public.connector_relay_jobs where created_at < now() - interval '1 day';
  end if;
  update public.connector_relay_jobs
     set status = 'expired'
   where relay_id = p_relay and status = 'queued' and expires_at <= now();

  return query
  update public.connector_relay_jobs j
     set status = 'claimed', claimed_at = now()
   where j.id = (
     select q.id from public.connector_relay_jobs q
      where q.relay_id = p_relay and q.status = 'queued' and q.expires_at > now()
      order by q.created_at
      limit 1
      for update skip locked
   )
  returning j.*;
end;
$$;

revoke all on function public.ccx_claim_relay_job(uuid) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Les états OAuth en vol (SSO utilisateur, code + PKCE)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.custom_connector_oauth_states (
  state text primary key,
  connector_id uuid not null references public.custom_connectors(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null default 'SSO',
  verifier_enc text not null,
  verifier_iv text not null,
  redirect_uri text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.custom_connector_oauth_states enable row level security;
-- Aucune policy : service role uniquement.

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Le journal d'accès
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.custom_connector_calls (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  -- Le connecteur peut disparaître ; son nom et sa version restent au journal.
  connector_id uuid references public.custom_connectors(id) on delete set null,
  connector_name text,
  connector_version integer,
  credential_id uuid,
  credential_label text,
  identity text,
  operation text,
  method text,
  -- Chemin seul, la chaîne de requête est retirée (elle porte parfois un jeton).
  target text,
  transport text,
  relay_id uuid,
  source text not null default 'collaborator' check (source in ('collaborator', 'approval', 'test', 'assistant')),
  agent_id uuid,
  agent_name text,
  run_id uuid,
  conversation_id uuid,
  actor_user_id uuid,
  approval_id uuid,
  decision text not null check (decision in ('allowed', 'approved', 'blocked', 'error')),
  risk text,
  status_code integer,
  duration_ms integer,
  request_bytes integer,
  response_bytes integer,
  redactions integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  prev_hash text not null default '',
  hash text not null default ''
);

create index if not exists custom_connector_calls_ws_idx on public.custom_connector_calls(workspace_id, seq desc);
create index if not exists custom_connector_calls_connector_idx on public.custom_connector_calls(connector_id, created_at desc);
create index if not exists custom_connector_calls_agent_idx on public.custom_connector_calls(agent_id, created_at desc);

alter table public.custom_connector_calls enable row level security;

drop policy if exists "custom_connector_calls: members read" on public.custom_connector_calls;
create policy "custom_connector_calls: members read"
on public.custom_connector_calls for select
using (public.is_workspace_member(workspace_id));

revoke insert, update, delete on public.custom_connector_calls from anon, authenticated;

-- Ce qui entre dans l'empreinte d'une ligne. Toute colonne qui raconte l'appel
-- en fait partie ; changer l'une d'elles casse la chaîne à partir de là.
create or replace function public.ccx_call_digest(c public.custom_connector_calls)
returns text
language sql
stable
as $$
  select concat_ws('|',
    c.seq::text, c.id::text, c.workspace_id::text,
    coalesce(c.connector_id::text, ''), coalesce(c.connector_version::text, ''),
    coalesce(c.credential_id::text, ''), coalesce(c.identity, ''),
    coalesce(c.operation, ''), coalesce(c.method, ''), coalesce(c.target, ''),
    coalesce(c.transport, ''), coalesce(c.relay_id::text, ''), c.source,
    coalesce(c.agent_id::text, ''), coalesce(c.run_id::text, ''),
    coalesce(c.actor_user_id::text, ''), coalesce(c.approval_id::text, ''),
    c.decision, coalesce(c.risk, ''), coalesce(c.status_code::text, ''),
    coalesce(c.response_bytes::text, ''), coalesce(c.error, ''),
    to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  );
$$;

create or replace function public.ccx_calls_chain()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  -- Une chaîne par espace de travail, sérialisée : deux appels simultanés ne
  -- peuvent pas pointer vers le même prédécesseur.
  perform pg_advisory_xact_lock(hashtextextended('ccx_calls:' || new.workspace_id::text, 0));
  select c.hash into v_prev
    from public.custom_connector_calls c
   where c.workspace_id = new.workspace_id
   order by c.seq desc
   limit 1;
  new.prev_hash := coalesce(v_prev, 'genesis');
  new.hash := encode(extensions.digest(new.prev_hash || '|' || public.ccx_call_digest(new), 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists custom_connector_calls_chain on public.custom_connector_calls;
create trigger custom_connector_calls_chain
before insert on public.custom_connector_calls
for each row execute function public.ccx_calls_chain();

-- En ajout seul. La suppression reste possible (cascade à la suppression d'un
-- espace), mais elle casse la chaîne et la vérification le dit.
create or replace function public.ccx_calls_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Le journal d''accès est en ajout seul.';
end;
$$;

drop trigger if exists custom_connector_calls_append_only on public.custom_connector_calls;
create trigger custom_connector_calls_append_only
before update on public.custom_connector_calls
for each row execute function public.ccx_calls_append_only();

-- Vérifier la chaîne d'un espace : rejoue chaque empreinte dans l'ordre.
create or replace function public.ccx_verify_chain(p_workspace uuid)
returns table (checked integer, ok boolean, broken_seq bigint)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  r public.custom_connector_calls;
  v_prev text := 'genesis';
  v_n integer := 0;
begin
  if not public.is_workspace_member(p_workspace) and auth.role() <> 'service_role' then
    raise exception 'Accès refusé';
  end if;
  for r in
    select * from public.custom_connector_calls c where c.workspace_id = p_workspace order by c.seq
  loop
    v_n := v_n + 1;
    if r.prev_hash <> v_prev
       or r.hash <> encode(extensions.digest(r.prev_hash || '|' || public.ccx_call_digest(r), 'sha256'), 'hex') then
      return query select v_n, false, r.seq;
      return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select v_n, true, null::bigint;
end;
$$;

grant execute on function public.ccx_verify_chain(uuid) to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Le genre d'outil et le type d'approbation
-- ────────────────────────────────────────────────────────────────────────────
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'tracker', 'support', 'governance', 'leads', 'soc',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom',
      'custom_connector'
    )
  );

comment on constraint internal_agent_tools_kind_check on public.internal_agent_tools is
  'Les genres d''outils que le runtime sait construire. Toute addition dans internal-agent-tools.ts doit passer ici, sans quoi la capacité est inaccordable.';

alter table public.internal_agent_approvals
  drop constraint if exists internal_agent_approvals_action_kind_check;
alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_action_kind_check check (
    action_kind in (
      'edge_function', 'webhook', 'connector_action', 'composio_action',
      'crm_write', 'tracker_write', 'custom_connector'
    )
  );
