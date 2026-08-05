-- 0145_agent_approval_resume.sql
-- Inline approvals in chat with pause-and-resume.
--
-- A run that hits a requires_approval tool now PAUSES (status 'awaiting_approval')
-- and surfaces the decision inline in the chat, instead of finishing. On the
-- decision the agent resumes with the action's result. Mirrors the existing
-- 'awaiting_input' (ask_user) machinery from migration 0091.

alter table public.internal_agent_runs
  drop constraint if exists internal_agent_runs_status_check;
alter table public.internal_agent_runs
  add constraint internal_agent_runs_status_check
  check (status in ('queued','running','succeeded','failed','cancelled','awaiting_input','awaiting_approval'));

alter table public.internal_agent_runs
  add column if not exists pending_approval jsonb;

-- Chat runs keep the conversation only in the (soon-deleted) run_state, so the
-- approval must carry it to know where to resume the agent.
alter table public.internal_agent_approvals
  add column if not exists conversation_id uuid references public.internal_agent_conversations(id) on delete set null;
