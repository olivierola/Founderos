-- Mission kanban board.
--
-- Missions gain a board column independent from the lifecycle status
-- (draft/active/archived). Both humans (drag & drop in the UI) and the agent
-- itself (move_mission tool, plus automatic moves by the worker: run started
-- → in_progress, succeeded → review, failed → todo) manipulate it.

alter table public.internal_agent_missions
  add column if not exists board_column text not null default 'todo'
    check (board_column in ('backlog','todo','in_progress','review','done'));

-- Archived missions are off the board conceptually; park them in done.
update public.internal_agent_missions
  set board_column = 'done'
  where status = 'archived' and board_column = 'todo';

create index if not exists idx_internal_agent_missions_board
  on public.internal_agent_missions(agent_id, board_column);
