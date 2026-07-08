-- 0108_aiops_providers.sql
-- Real GPU / model-hosting infrastructure for the AI Ops module. Two ways an
-- enterprise brings compute:
--   1. cloud_endpoint — the company already hosts its own models on a provider
--      and gives us an OpenAI-compatible base URL + API key. We test the
--      connection, list its models, and route real inference through it.
--   2. runpod — the company rents GPU pods on RunPod. We store their RunPod API
--      key, list GPU types/prices, and create/start/stop/terminate real pods
--      that serve a model (vLLM, OpenAI-compatible) — each pod becomes a row in
--      aiops_servers with a real pod_id + endpoint_url.
-- The API key is encrypted at rest (AES-GCM, CREDENTIAL_ENCRYPTION_KEY) exactly
-- like the connectors vault; only the aiops-infra edge function decrypts it.

create table if not exists public.aiops_providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('cloud_endpoint','runpod')),
  name text not null,
  -- Non-secret config: { base_url, region, default_gpu, default_image, ... }
  config jsonb not null default '{}'::jsonb,
  -- Encrypted API key (AES-GCM). Never selected by the frontend (RLS below
  -- forbids reading these two columns via a view; the edge function uses the
  -- service role).
  secret_ciphertext text,
  secret_iv text,
  status text not null default 'pending' check (status in ('pending','connected','error')),
  status_detail text,
  -- Provider metadata: discovered models, account info, gpu cache…
  metadata jsonb not null default '{}'::jsonb,
  last_tested_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aiops_providers_project on public.aiops_providers(project_id);

-- Link real compute to servers. Existing seeded rows keep source='seed'.
alter table public.aiops_servers
  add column if not exists provider_id uuid references public.aiops_providers(id) on delete set null,
  add column if not exists source text not null default 'seed' check (source in ('seed','runpod','cloud')),
  add column if not exists pod_id text,
  add column if not exists endpoint_url text,
  add column if not exists hourly_usd numeric(10,3) not null default 0,
  add column if not exists desired_status text;

-- A public-safe view of providers that never exposes the ciphertext, so the
-- frontend can list providers without touching the secret columns.
-- security_invoker = on → the view enforces the base table's RLS as the caller
-- (without it the view would run as owner and bypass RLS entirely).
create or replace view public.aiops_providers_public
  with (security_invoker = on) as
  select id, workspace_id, project_id, kind, name, config, status, status_detail,
         metadata, last_tested_at, created_at, updated_at,
         (secret_ciphertext is not null) as has_secret
  from public.aiops_providers;

-- ── RLS (members block; the view inherits the base table's policies) ─────────
alter table public.aiops_providers enable row level security;
drop policy if exists "Members read aiops_providers" on public.aiops_providers;
create policy "Members read aiops_providers" on public.aiops_providers for select
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_providers.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write aiops_providers" on public.aiops_providers;
create policy "Members write aiops_providers" on public.aiops_providers for insert
  with check (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_providers.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members update aiops_providers" on public.aiops_providers;
create policy "Members update aiops_providers" on public.aiops_providers for update
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_providers.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members delete aiops_providers" on public.aiops_providers;
create policy "Members delete aiops_providers" on public.aiops_providers for delete
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_providers.workspace_id and wm.user_id = auth.uid()));
