-- Store the full Excalidraw scene (elements + appState subset) as JSON on the
-- board, and stream board updates for live collaboration.
alter table public.project_whiteboards
  add column if not exists scene jsonb not null default '{"elements":[]}'::jsonb;

-- Realtime so collaborators see scene updates as they're saved.
alter publication supabase_realtime add table public.project_whiteboards;
