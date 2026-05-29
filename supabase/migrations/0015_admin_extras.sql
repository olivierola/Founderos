-- Supporting tables for extended admin actions: per-user feature flags and announcements.

create table if not exists public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  flag_key text not null,
  target_email text,                       -- null = project-wide flag
  enabled boolean default true,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (project_id, flag_key, target_email)
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  body text,
  level text default 'info' check (level in ('info','success','warning','critical')),
  active boolean default true,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

do $$
declare t text;
begin
  foreach t in array array['feature_flags','announcements']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy "Members read %1$s"
      on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format($f$
      create policy "Admins manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin')))
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin')));
    $f$, t);
  end loop;
end $$;

create index if not exists idx_feature_flags_project on public.feature_flags(project_id);
create index if not exists idx_announcements_project on public.announcements(project_id, active);
