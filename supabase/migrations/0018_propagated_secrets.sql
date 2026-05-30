-- Track which app-level secrets (e.g. STRIPE_SECRET_KEY, OPENAI_API_KEY) have
-- been propagated from FounderOS to a customer's backend (Supabase Secrets,
-- Vercel env vars, Railway, Render, Cloudflare, AWS SSM, RunPod, Firebase…).
--
-- The plaintext value is NEVER stored here — only an encrypted copy lives in
-- encrypted_credentials, scoped to a synthetic connector with provider =
-- 'app-secret:<key>'. This table only tracks the propagation status per target.

create table if not exists propagated_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  key text not null,                       -- e.g. STRIPE_SECRET_KEY
  target_provider text not null,           -- e.g. supabase, vercel, railway, render, cloudflare, aws, runpod, firebase
  env_name text not null,                  -- name in the target backend (often = key)
  status text not null default 'pending',  -- pending | synced | error
  last_synced_at timestamptz,
  last_error text,
  metadata jsonb default '{}'::jsonb,      -- e.g. { project_ref, env_var_id, target_envs }
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (project_id, key, target_provider, env_name)
);

create index if not exists propagated_secrets_project_idx on propagated_secrets(project_id);
create index if not exists propagated_secrets_key_idx on propagated_secrets(project_id, key);

alter table propagated_secrets enable row level security;

-- Members of the workspace can read their propagation status.
create policy "members read propagated_secrets"
  on propagated_secrets for select
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = propagated_secrets.workspace_id
      and wm.user_id = auth.uid()
    )
  );

-- Writes are restricted to the service role (edge functions).
create policy "service role writes propagated_secrets"
  on propagated_secrets for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
