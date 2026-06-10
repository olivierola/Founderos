-- Internal agents v2 — "autonomous agents".
-- The v1 worker did a single LLM call and never executed tools. v2 turns the
-- worker into a real agentic loop (multi-step tool execution), so the schema
-- gains:
--   1. Per-agent autonomy budgets (max steps / max cost per run).
--   2. Per-tool human-approval gating + a new 'rag_search' tool kind.
--   3. An approvals queue: sensitive tool calls are proposed by the agent and
--      executed only after a human approves them.
--   4. Mission scheduling bookkeeping (next_run_at / last_run_at) consumed by
--      the internal-agent-scheduler edge function.
--   5. Run provenance (manual / schedule / api) + steps taken.

-- ---- Agents: autonomy budgets ----------------------------------------------

alter table public.internal_agents
  add column if not exists max_steps int not null default 8
    check (max_steps between 1 and 30),
  add column if not exists max_run_cost_usd numeric(10, 4) not null default 0.50
    check (max_run_cost_usd >= 0);

-- ---- Tools: approval gating + rag_search kind ------------------------------

alter table public.internal_agent_tools
  add column if not exists requires_approval boolean not null default false;

-- Extend the kind catalogue with 'rag_search' (semantic search over the
-- project's indexed knowledge).
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;
alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check
  check (kind in ('web_search','web_fetch','db_read','rag_search','edge_function','vault_connector','custom'));

-- ---- Runs: provenance + step accounting ------------------------------------

alter table public.internal_agent_runs
  add column if not exists triggered_via text not null default 'manual'
    check (triggered_via in ('manual','schedule','api')),
  add column if not exists steps int not null default 0;

-- ---- Missions: scheduling bookkeeping ---------------------------------------

alter table public.internal_agent_missions
  add column if not exists last_run_at timestamptz,
  add column if not exists next_run_at timestamptz;

-- Backfill: active scheduled missions become due immediately so the first
-- scheduler tick picks them up.
update public.internal_agent_missions
  set next_run_at = now()
  where schedule is not null and status = 'active' and next_run_at is null;

create index if not exists idx_internal_agent_missions_due
  on public.internal_agent_missions(next_run_at)
  where schedule is not null and status = 'active';

-- ---- Approvals: human-in-the-loop for sensitive tool calls ------------------
-- When an agent invokes a tool flagged requires_approval, the worker records
-- the intended action here instead of executing it. A human approves/rejects
-- from the UI; execution happens server-side in internal-agent-approve.

create table if not exists public.internal_agent_approvals (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.internal_agents(id) on delete cascade,
  -- Nullable: approvals can also originate from chat mode (no run).
  run_id uuid references public.internal_agent_runs(id) on delete cascade,
  mission_id uuid references public.internal_agent_missions(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  tool_name text not null,
  -- What to execute on approval:
  --   edge_function: { slug, args }
  --   webhook:       { url, method, args }
  action_kind text not null check (action_kind in ('edge_function','webhook')),
  payload jsonb not null default '{}'::jsonb,
  -- The agent's stated justification, shown to the approver.
  reason text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','executed','failed')),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  error_message text
);

alter table public.internal_agent_approvals enable row level security;

-- Members with agent access can see approvals. Decisions + execution go
-- through the internal-agent-approve edge function (service role), so no
-- user-facing insert/update/delete policies are needed.
drop policy if exists "Read approvals via agent access" on public.internal_agent_approvals;
create policy "Read approvals via agent access"
on public.internal_agent_approvals for select
using (public.has_internal_agent_access(internal_agent_approvals.agent_id, auth.uid()));

create index if not exists idx_internal_agent_approvals_agent
  on public.internal_agent_approvals(agent_id, status, requested_at desc);
create index if not exists idx_internal_agent_approvals_run
  on public.internal_agent_approvals(run_id) where run_id is not null;
