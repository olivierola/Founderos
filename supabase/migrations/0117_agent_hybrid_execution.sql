-- 0117_agent_hybrid_execution.sql
-- Add a 4th execution environment: HYBRID.
--   cloud    — serverless edge: web/db/connector tools only
--   runner   — + a real Playwright browser, shell, Python/Node, files on the self-hosted runner
--   sandbox  — + a full Linux AIO Sandbox container (shell, code, files, Chromium, Jupyter)
--   hybrid   — BOTH runner and sandbox are exposed at once, namespaced (runner_* / sandbox_*).
--              An orchestrator (plan-time tagging + a health-aware router) picks which world
--              each task runs in, based on availability, task type and necessity. If one world
--              is down the agent degrades to the other instead of hard-failing.
-- Extends the constraint set by 0092_agent_execution_env.sql.

alter table public.internal_agents
  drop constraint if exists internal_agents_sandbox_mode_check;
alter table public.internal_agents
  add constraint internal_agents_sandbox_mode_check
  check (sandbox_mode in ('cloud','runner','sandbox','hybrid'));
