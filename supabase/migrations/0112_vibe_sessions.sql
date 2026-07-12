-- 0112_vibe_sessions.sql
-- Vibe Code chat sessions: a persisted conversation with the coding agent on a
-- repo. Sessions are listed in the SecondarySidebar; messages restore the agent
-- summary + proposed changes (stored in meta).
create table if not exists public.vibe_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  repository_id uuid references public.repositories(id) on delete set null,
  title text not null default 'Nouvelle session',
  branch text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_vibe_sessions_project on public.vibe_sessions(project_id, updated_at desc);

create table if not exists public.vibe_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.vibe_sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  meta jsonb not null default '{}'::jsonb,       -- { result: RunResult, pr }
  created_at timestamptz not null default now()
);
create index if not exists idx_vibe_messages_session on public.vibe_messages(session_id, created_at);

-- RLS: workspace members read/write their rows.
do $$
declare t text;
begin
  foreach t in array array['vibe_sessions','vibe_messages']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members write %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members update %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members delete %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;
