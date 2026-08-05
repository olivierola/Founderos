-- 0144_room_message_run.sql
-- Let a room agent turn own a run so it can fan out parallel sub-agents. The
-- assistant message points at that (lazily-created) run; the UI reads run_id to
-- render the sub-agent instance cards for the turn.

alter table public.service_room_messages
  add column if not exists run_id uuid references public.internal_agent_runs(id) on delete set null;
