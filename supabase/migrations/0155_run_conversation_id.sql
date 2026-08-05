-- Scope a run to its conversation, so the LIVE run card only shows in the chat
-- that started it (before this, the frontend keyed the active run on agent_id
-- alone → the same live timeline appeared in every open conversation of that
-- agent). internal_agent_run_state already had conversation_id but has no
-- frontend-readable RLS policy, so we mirror it onto the run row the UI reads.

alter table public.internal_agent_runs
  add column if not exists conversation_id uuid references public.internal_agent_conversations(id) on delete set null;

-- Backfill in-flight runs from their run_state (best-effort).
update public.internal_agent_runs r
set conversation_id = rs.conversation_id
from public.internal_agent_run_state rs
where rs.run_id = r.id and r.conversation_id is null and rs.conversation_id is not null;

create index if not exists internal_agent_runs_convo_idx
  on public.internal_agent_runs(conversation_id, created_at desc);
