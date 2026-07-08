-- 0106_governance.sql
-- AI & Data Governance module. A project-scoped framework to develop, deploy and
-- operate AI systems responsibly: an AI registry (model cards), risk register,
-- policies, control frameworks (EU AI Act / NIST AI RMF / ISO 42001), a
-- human-in-the-loop approval queue, incident log, data-asset catalog and an
-- append-only audit trail. Every table is scoped by workspace_id/project_id and
-- guarded by the standard members-RLS block. No edge functions — the frontend
-- reads/writes these tables directly, and the AI registry is kept in sync with
-- the real internal_agents via the gov_sync_ai_systems() RPC below.

-- ── AI registry (model cards / system inventory) ─────────────────────────────
create table if not exists public.gov_ai_systems (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Where this entry comes from. 'internal_agent' rows are synced from an agent.
  source text not null default 'manual' check (source in ('internal_agent','external','manual')),
  agent_id uuid references public.internal_agents(id) on delete set null,
  name text not null,
  description text,
  purpose text,                                   -- business use case
  owner_user_id uuid references auth.users(id),
  owner_name text,
  model text,
  provider text,
  -- EU AI Act risk tiers.
  risk_tier text not null default 'limited' check (risk_tier in ('unacceptable','high','limited','minimal')),
  status text not null default 'draft' check (status in ('draft','in_review','approved','deployed','deprecated','retired')),
  data_sources jsonb not null default '[]'::jsonb,-- free-form list of data source labels
  decision_logic text,                            -- explainability: how it decides
  human_oversight text,                           -- what HITL controls exist
  tags text[] not null default '{}',
  last_review_at date,
  next_review_at date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_systems_project on public.gov_ai_systems(project_id);
create unique index if not exists uq_gov_systems_agent on public.gov_ai_systems(agent_id) where agent_id is not null;

-- ── Risk register ────────────────────────────────────────────────────────────
create table if not exists public.gov_risks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  system_id uuid references public.gov_ai_systems(id) on delete set null,
  title text not null,
  description text,
  category text not null default 'other' check (category in ('bias','security','privacy','hallucination','compliance','safety','operational','other')),
  likelihood int not null default 3 check (likelihood between 1 and 5),
  impact int not null default 3 check (impact between 1 and 5),
  mitigation text,
  owner_name text,
  status text not null default 'open' check (status in ('open','mitigating','accepted','closed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_risks_project on public.gov_risks(project_id);

-- ── Policies ─────────────────────────────────────────────────────────────────
create table if not exists public.gov_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  category text,
  body text,                                      -- markdown
  version text not null default 'v1',
  status text not null default 'draft' check (status in ('draft','active','archived')),
  owner_name text,
  effective_at date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_policies_project on public.gov_policies(project_id);

create table if not exists public.gov_policy_acks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  policy_id uuid not null references public.gov_policies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (policy_id, user_id)
);

-- ── Controls & compliance ────────────────────────────────────────────────────
create table if not exists public.gov_controls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  framework text not null default 'eu_ai_act' check (framework in ('eu_ai_act','nist_ai_rmf','iso_42001','gdpr','custom')),
  ref_code text,                                  -- e.g. 'Art. 9', 'GOVERN-1.1'
  title text not null,
  description text,
  status text not null default 'not_started' check (status in ('not_started','in_progress','implemented','not_applicable')),
  owner_name text,
  system_id uuid references public.gov_ai_systems(id) on delete set null,
  evidence text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_controls_project on public.gov_controls(project_id);

-- ── Human-in-the-loop approval queue ─────────────────────────────────────────
create table if not exists public.gov_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  system_id uuid references public.gov_ai_systems(id) on delete set null,
  title text not null,
  description text,
  kind text not null default 'other' check (kind in ('deployment','use_case','model_change','data_access','other')),
  risk_tier text check (risk_tier in ('unacceptable','high','limited','minimal')),
  status text not null default 'pending' check (status in ('pending','approved','rejected','changes_requested')),
  requested_by_name text,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_approvals_project on public.gov_approvals(project_id);

-- ── Incidents ────────────────────────────────────────────────────────────────
create table if not exists public.gov_incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  system_id uuid references public.gov_ai_systems(id) on delete set null,
  title text not null,
  description text,
  category text not null default 'other' check (category in ('bias','harmful_output','data_leak','outage','privacy','other')),
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','resolved','closed')),
  occurred_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_incidents_project on public.gov_incidents(project_id);

-- ── Data-asset catalog (data governance side) ────────────────────────────────
create table if not exists public.gov_data_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  source text,                                    -- system / db.table / api
  classification text not null default 'internal' check (classification in ('public','internal','confidential','restricted')),
  contains_pii boolean not null default false,
  lawful_basis text,                              -- GDPR lawful basis
  owner_name text,
  retention text,
  status text not null default 'active' check (status in ('active','archived')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_gov_data_assets_project on public.gov_data_assets(project_id);

-- ── Append-only audit trail ──────────────────────────────────────────────────
create table if not exists public.gov_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  actor_name text,
  action text not null,                           -- e.g. 'system.approved', 'policy.published'
  entity_type text,                               -- 'system' | 'risk' | 'policy' | ...
  entity_id uuid,
  entity_label text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_gov_audit_project on public.gov_audit_events(project_id, created_at desc);

-- ── RLS: workspace members can read/write rows in their workspaces ───────────
do $$
declare t text;
begin
  foreach t in array array[
    'gov_ai_systems','gov_risks','gov_policies','gov_policy_acks','gov_controls',
    'gov_approvals','gov_incidents','gov_data_assets','gov_audit_events'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members write %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members update %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members delete %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;

-- ── Keep the AI registry in sync with real internal_agents ───────────────────
-- Idempotent: inserts one gov_ai_systems row per non-archived agent that does
-- not yet have one. Called from the Registry page on load (like crm_seed_project).
create or replace function public.gov_sync_ai_systems(p_workspace uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.gov_ai_systems (
    workspace_id, project_id, source, agent_id, name, description,
    purpose, owner_user_id, model, provider, risk_tier, status
  )
  select
    a.workspace_id, a.project_id, 'internal_agent', a.id, a.name, a.description,
    'Agent interne autonome', a.created_by, a.model, 'internal',
    'limited', case when coalesce(a.is_archived, false) then 'deprecated' else 'deployed' end
  from public.internal_agents a
  where a.project_id = p_project
    and a.workspace_id is not null
    and not exists (select 1 from public.gov_ai_systems g where g.agent_id = a.id);
end $$;
