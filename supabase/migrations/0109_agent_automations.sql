-- 0109_agent_automations.sql
-- Pre-designed, "coded" automations an agent can switch on from its Customize →
-- Automation tab. Each enabled automation grants the connector-action tools it
-- needs and (optionally) spawns a scheduled mission the existing agent scheduler
-- runs. We only persist which template is enabled + the mission it created; the
-- template logic itself lives in the frontend catalog (agentAutomations.ts).

create table if not exists public.internal_agent_automations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  key text not null,                              -- automation template key
  enabled boolean not null default true,
  mission_id uuid references public.internal_agent_missions(id) on delete set null,
  config jsonb not null default '{}'::jsonb,       -- { providers: [...] }
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, key)
);
create index if not exists idx_agent_automations_agent on public.internal_agent_automations(agent_id);

-- RLS: same access model as the other internal_agent_* child tables — guarded by
-- has_internal_agent_access(agent_id, uid).
alter table public.internal_agent_automations enable row level security;

drop policy if exists "Read internal_agent_automations via agent access" on public.internal_agent_automations;
create policy "Read internal_agent_automations via agent access"
on public.internal_agent_automations for select
using (public.has_internal_agent_access(internal_agent_automations.agent_id, auth.uid()));

drop policy if exists "Insert internal_agent_automations via agent access" on public.internal_agent_automations;
create policy "Insert internal_agent_automations via agent access"
on public.internal_agent_automations for insert
with check (public.has_internal_agent_access(internal_agent_automations.agent_id, auth.uid()));

drop policy if exists "Update internal_agent_automations via agent access" on public.internal_agent_automations;
create policy "Update internal_agent_automations via agent access"
on public.internal_agent_automations for update
using (public.has_internal_agent_access(internal_agent_automations.agent_id, auth.uid()))
with check (public.has_internal_agent_access(internal_agent_automations.agent_id, auth.uid()));

drop policy if exists "Delete internal_agent_automations via agent access" on public.internal_agent_automations;
create policy "Delete internal_agent_automations via agent access"
on public.internal_agent_automations for delete
using (public.has_internal_agent_access(internal_agent_automations.agent_id, auth.uid()));
