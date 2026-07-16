-- 0123_vibe_settings.sql
-- Per-project customization for the Vibe Code agent: extra system instructions
-- (coding conventions/constraints injected into every run) and the default PR
-- merge method. One row per project.
create table if not exists public.vibe_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  instructions text not null default '',
  merge_method text not null default 'squash' check (merge_method in ('squash','merge','rebase')),
  updated_at timestamptz not null default now(),
  unique (project_id)
);

alter table public.vibe_settings enable row level security;
drop policy if exists "Members read vibe_settings" on public.vibe_settings;
create policy "Members read vibe_settings" on public.vibe_settings for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_settings.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write vibe_settings" on public.vibe_settings;
create policy "Members write vibe_settings" on public.vibe_settings for all
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_settings.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_settings.workspace_id and wm.user_id = auth.uid()));
