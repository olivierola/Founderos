-- Allow a 'frame' node kind on whiteboards (a labelled section to group notes).
alter table public.whiteboard_nodes
  drop constraint if exists whiteboard_nodes_kind_check;
alter table public.whiteboard_nodes
  add constraint whiteboard_nodes_kind_check
  check (kind in ('note','text','frame'));
