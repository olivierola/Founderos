-- Project Whiteboards — collaborative sticky-note canvases inside Projets.
create table if not exists public.project_whiteboards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null default 'Untitled board',
  color text not null default '#2F2FE4',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_whiteboards_project on public.project_whiteboards(project_id);

-- One row per sticky note / shape on a board.
create table if not exists public.whiteboard_nodes (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.project_whiteboards(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note','text')),
  text text not null default '',
  color text not null default '#FEF08A',
  x double precision not null default 0,
  y double precision not null default 0,
  w double precision not null default 180,
  h double precision not null default 120,
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index if not exists idx_whiteboard_nodes_board on public.whiteboard_nodes(board_id);

-- RLS: workspace members can read/write boards & nodes for their workspaces.
do $$
declare t text;
begin
  foreach t in array array['project_whiteboards','whiteboard_nodes'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "members write %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "members update %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "members delete %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;

-- Realtime for live collaboration on nodes.
alter publication supabase_realtime add table public.whiteboard_nodes;
