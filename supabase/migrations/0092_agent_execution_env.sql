-- 0092_agent_execution_env.sql
-- Formalize the per-agent execution environment as a 3-way choice:
--   cloud    — serverless edge: web/db/connector tools only (default)
--   runner   — + a real Playwright browser (browse_web) via the local runner
--   sandbox  — + a full Linux AIO Sandbox (shell, code, files, sandbox browser)
-- The sandbox_mode/sandbox_url columns were added ad-hoc earlier; this migration
-- makes the choice explicit and constrained.

update public.internal_agents set sandbox_mode = 'cloud' where sandbox_mode is null;

alter table public.internal_agents
  alter column sandbox_mode set default 'cloud';

alter table public.internal_agents
  drop constraint if exists internal_agents_sandbox_mode_check;
alter table public.internal_agents
  add constraint internal_agents_sandbox_mode_check
  check (sandbox_mode in ('cloud','runner','sandbox'));
