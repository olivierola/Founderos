-- 0180_aiops_realtime_costs.sql
-- 1. Live everywhere: the aiops tables join the supabase_realtime publication so
--    the frontend can subscribe with postgres_changes (member RLS still applies
--    per row). NOT added: aiops_providers — realtime carries the whole row and
--    RLS is row-level, not column-level, so the AES-GCM ciphertext would leak.
-- 2. Real infra cost accounting: aiops_servers accrues billed hours/$, and every
--    billed segment (rented pod uptime) is appended to aiops_infra_cost_ledger.
--    The aiops-infra edge function writes the segments service-side.

-- ── 1. Realtime publication ──────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.aiops_guardrails; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_servers; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_agent_deployments; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_infra_incidents; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_model_state; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_datasets; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_label_tasks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_jobs; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_versions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_experiments; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_evals; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_endpoints; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_alert_rules; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_roles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.aiops_ft_settings; exception when duplicate_object then null; end;
end $$;

-- ── 2. Cost accounting columns on servers ────────────────────────────────────
-- accrued_cost_usd / accrued_hours: lifetime billed totals (fed by the ledger).
-- running_since: start of the current open billing segment (null when stopped);
-- the edge function rolls it forward on each reconcile so nothing double-counts.
alter table public.aiops_servers
  add column if not exists accrued_cost_usd numeric(12,2) not null default 0,
  add column if not exists accrued_hours numeric(10,3) not null default 0,
  add column if not exists running_since timestamptz;

-- ── 3. Infra cost ledger ──────────────────────────────────────────────────────
-- One row per billed segment. Written only by the aiops-infra edge function
-- (service role) on reconcile / stop / terminate. Read by the costs pages.
create table if not exists public.aiops_infra_cost_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  provider_id uuid references public.aiops_providers(id) on delete set null,
  server_id uuid references public.aiops_servers(id) on delete set null,
  server_name text not null default '',
  gpu text not null default '',
  hourly_usd numeric(10,3) not null default 0,
  period_start timestamptz not null,
  period_end timestamptz not null,
  hours numeric(10,3) not null default 0,
  usd numeric(12,2) not null default 0,
  kind text not null default 'server' check (kind in ('server','training')),
  created_at timestamptz not null default now()
);
create index if not exists idx_aiops_cost_ledger_project on public.aiops_infra_cost_ledger(project_id, created_at desc);
create index if not exists idx_aiops_cost_ledger_server on public.aiops_infra_cost_ledger(server_id, created_at desc);

-- The ledger exists now — safe to add to the realtime publication here
-- (referencing it in the block above would fail: the table doesn't exist yet).
do $$
begin
  begin alter publication supabase_realtime add table public.aiops_infra_cost_ledger; exception when duplicate_object then null; end;
end $$;

-- ── RLS: workspace members (same block as 0107) ───────────────────────────────
alter table public.aiops_infra_cost_ledger enable row level security;
drop policy if exists "Members read aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger;
create policy "Members read aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger for select
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_infra_cost_ledger.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger;
create policy "Members write aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger for insert
  with check (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_infra_cost_ledger.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members update aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger;
create policy "Members update aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger for update
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_infra_cost_ledger.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members delete aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger;
create policy "Members delete aiops_infra_cost_ledger" on public.aiops_infra_cost_ledger for delete
  using (exists (select 1 from public.workspace_members wm
    where wm.workspace_id = aiops_infra_cost_ledger.workspace_id and wm.user_id = auth.uid()));
