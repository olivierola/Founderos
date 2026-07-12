-- 0113_vibe_memory.sql
-- Vibe Code agent memory: durable facts/preferences the coding agent respects.
-- session_id NULL = global memory (all sessions of the project); otherwise the
-- memory is scoped to one session.
create table if not exists public.vibe_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id uuid references public.vibe_sessions(id) on delete cascade,
  content text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_vibe_memory_project on public.vibe_memory(project_id, created_at);
create index if not exists idx_vibe_memory_session on public.vibe_memory(session_id) where session_id is not null;

alter table public.vibe_memory enable row level security;
drop policy if exists "Members read vibe_memory" on public.vibe_memory;
create policy "Members read vibe_memory" on public.vibe_memory for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_memory.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write vibe_memory" on public.vibe_memory;
create policy "Members write vibe_memory" on public.vibe_memory for insert
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_memory.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members update vibe_memory" on public.vibe_memory;
create policy "Members update vibe_memory" on public.vibe_memory for update
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_memory.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members delete vibe_memory" on public.vibe_memory;
create policy "Members delete vibe_memory" on public.vibe_memory for delete
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_memory.workspace_id and wm.user_id = auth.uid()));
