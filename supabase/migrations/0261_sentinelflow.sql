-- 0261_sentinelflow.sql
-- SentinelFlow — le triage SOC : toutes les sources d'alertes, un format
-- commun, un tri Jev, des faux positifs PROUVÉS, et aucune remédiation sans
-- validation humaine.
--
-- Réglé par l'usage `soc_triage` de typesafe_settings. Les alertes arrivent par
-- automation-receiver?sentinel=<jeton> (webhook), par interrogation d'API (le
-- planificateur, chaque minute), par nos signaux internes, par l'outil
-- `sentinel` des agents, ou par import. Toutes sont normalisées selon le
-- préréglage d'éditeur de leur source (_shared/sentinel.ts).

-- ── Les sources ──────────────────────────────────────────────────────────────
create table if not exists public.sentinel_sources (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  project_id            uuid not null references public.projects(id) on delete cascade,
  name                  text not null,
  kind                  text not null check (kind in ('webhook', 'poll', 'internal', 'agent', 'manual')),
  -- Préréglage d'éditeur (wazuh, elastic, ms_sentinel, splunk, crowdstrike…).
  vendor                text not null default 'generic',
  -- Où sont les alertes dans un lot, et les chemins de champs qui SURCHARGENT
  -- le préréglage : { "host": ["data.device"], "severity": ["risk"] }.
  items_path            text,
  mapping               jsonb not null default '{}'::jsonb,

  -- Webhook : seule l'empreinte du jeton est gardée (le jeton n'est montré
  -- qu'une fois), plus ses 4 derniers caractères pour le reconnaître.
  token_hash            text unique,
  token_hint            text,

  -- Interrogation : { url, method, body, auth: none|bearer|basic|header,
  -- header_name, internal } — l'identifiant, lui, est chiffré (AES-GCM).
  poll                  jsonb not null default '{}'::jsonb,
  secret_ciphertext     text,
  secret_iv             text,
  poll_interval_minutes int not null default 5,
  cursor                text,
  last_polled_at        timestamptz,
  last_error            text,

  last_seen_at          timestamptz,
  enabled               boolean not null default true,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists sentinel_sources_project_idx on public.sentinel_sources (project_id);

-- ── Les alertes ──────────────────────────────────────────────────────────────
create table if not exists public.sentinel_alerts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  project_id          uuid not null references public.projects(id) on delete cascade,
  source_id           uuid not null references public.sentinel_sources(id) on delete cascade,

  -- Le format commun.
  external_id         text,
  title               text not null,
  description         text,
  severity_raw        text,
  -- 0 faible · 1 moyenne · 2 haute · 3 critique (gravité ANNONCÉE par l'éditeur).
  severity            smallint check (severity between 0 and 3),
  category_raw        text,
  rule_id             text,
  rule_name           text,
  host                text,
  src_ip              text,
  dst_ip              text,
  user_name           text,
  mitre               text[] not null default '{}',
  occurred_at         timestamptz not null default now(),
  dedupe_key          text not null,
  occurrences         int not null default 1,
  last_seen_at        timestamptz not null default now(),
  raw                 jsonb,

  -- Le tri.
  -- new = pas encore trié · untriaged = jugement éteint, gravité éditeur seule ·
  -- triaged · escalated · investigating · closed_fp · closed_resolved
  status              text not null default 'new'
                      check (status in ('new', 'untriaged', 'triaged', 'escalated', 'investigating', 'closed_fp', 'closed_resolved')),
  priority            smallint check (priority between 0 and 3),
  gravity             smallint check (gravity between 0 and 3),
  category            text,
  category_confidence real,
  -- Les raisons VÉRIFIABLES de tenir l'alerte pour un faux positif.
  fp_verified         text[] not null default '{}',
  -- L'avis du modèle — un indice, jamais une preuve.
  fp_hint_p           real,
  escalate            boolean not null default false,
  playbook            text,
  triage_mode         text check (triage_mode in ('shadow', 'on', 'off')),
  triaged_at          timestamptz,

  notes               jsonb not null default '[]'::jsonb,
  resolution          text,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (source_id, dedupe_key)
);
create index if not exists sentinel_alerts_queue_idx on public.sentinel_alerts (project_id, status, priority desc, occurred_at desc);
create index if not exists sentinel_alerts_pending_idx on public.sentinel_alerts (created_at) where status = 'new';
create index if not exists sentinel_alerts_host_idx on public.sentinel_alerts (project_id, host, occurred_at desc);
create index if not exists sentinel_alerts_rule_idx on public.sentinel_alerts (project_id, rule_id, status);

-- ── Le contexte : actifs, règles de suppression, configuration ───────────────
create table if not exists public.sentinel_assets (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  name         text not null,
  ips          text[] not null default '{}',
  criticality  text not null default 'medium' check (criticality in ('low', 'medium', 'high', 'critical')),
  owner        text,
  -- test, scanner, honeypot, lab, sandbox → critère de faux positif vérifiable.
  tags         text[] not null default '{}',
  notes        text,
  created_at   timestamptz not null default now()
);
create index if not exists sentinel_assets_project_idx on public.sentinel_assets (project_id);

create table if not exists public.sentinel_suppressions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  label        text not null,
  -- { rule_id?, host?, src_ip?, user?, category?, title_contains? } — tous
  -- les champs renseignés doivent correspondre.
  match        jsonb not null default '{}'::jsonb,
  reason       text,
  expires_at   timestamptz,
  enabled      boolean not null default true,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.sentinel_config (
  project_id   uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- { playbooks:[{key,label,what}], auto_close_verified_fp, fp_rate_threshold, fp_rate_min_samples }
  config       jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- ── Les remédiations proposées ───────────────────────────────────────────────
-- Rien ne s'exécute d'ici : une proposition attend qu'une personne la valide,
-- puis l'exécution passe par les outils habituels (connecteurs), eux-mêmes
-- soumis à PolicyGuard.
create table if not exists public.sentinel_actions (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  project_id         uuid not null references public.projects(id) on delete cascade,
  alert_id           uuid not null references public.sentinel_alerts(id) on delete cascade,
  playbook           text,
  remediation        text not null,
  justification      text,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'done')),
  proposed_by_agent  uuid,
  run_id             uuid,
  decided_by         uuid references auth.users(id) on delete set null,
  decided_at         timestamptz,
  decision_note      text,
  created_at         timestamptz not null default now()
);
create index if not exists sentinel_actions_project_idx on public.sentinel_actions (project_id, status, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['sentinel_sources','sentinel_alerts','sentinel_assets','sentinel_suppressions','sentinel_config','sentinel_actions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "members read %1$s" on public.%1$s', t);
    execute format($f$
      create policy "members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $f$, t);
  end loop;
end $$;

-- Les membres travaillent la file (statut, notes) et tiennent le contexte
-- (actifs, suppressions, configuration, décision sur une remédiation). Les
-- SOURCES, elles, ne s'écrivent que par la fonction (jeton, secret chiffré,
-- réservé aux administrateurs) : aucune politique d'écriture directe.
do $$
declare t text;
begin
  foreach t in array array['sentinel_alerts','sentinel_actions'] loop
    execute format('drop policy if exists "members update %1$s" on public.%1$s', t);
    execute format($f$
      create policy "members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
      with check (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $f$, t);
  end loop;
  foreach t in array array['sentinel_assets','sentinel_suppressions','sentinel_config'] loop
    execute format('drop policy if exists "members manage %1$s" on public.%1$s', t);
    execute format($f$
      create policy "members manage %1$s" on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
      with check (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $f$, t);
  end loop;
end $$;

-- Le jeton et le secret ne doivent jamais être lus par le navigateur, même
-- par un membre : on retire ces colonnes du SELECT des rôles clients.
revoke select on public.sentinel_sources from anon, authenticated;
grant select (id, workspace_id, project_id, name, kind, vendor, items_path, mapping, token_hint, poll,
              poll_interval_minutes, cursor, last_polled_at, last_error, last_seen_at, enabled,
              created_by, created_at, updated_at)
  on public.sentinel_sources to authenticated;

-- ── Le genre d'outil `soc` (outil sentinel) ──────────────────────────────────
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'tracker', 'support', 'governance', 'leads', 'soc',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom'
    )
  );

comment on constraint internal_agent_tools_kind_check on public.internal_agent_tools is
  'Les genres d''outils que le runtime sait construire. Toute addition dans internal-agent-tools.ts doit passer ici, sans quoi la capacité est inaccordable.';
