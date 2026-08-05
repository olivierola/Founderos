-- 0134_agent_orchestrator.sql
-- A service dashboard has a default ORCHESTRATOR agent so you can chat without
-- first creating an agent. The orchestrator can build the workspace by request —
-- create other agents, schedule recurring work — via its tools.

alter table public.internal_agents
  add column if not exists is_orchestrator boolean not null default false;

create index if not exists idx_internal_agents_orchestrator
  on public.internal_agents(service_dashboard_id) where is_orchestrator;
