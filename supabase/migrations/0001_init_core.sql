-- FounderOS — Sprint 1 core schema
-- Tables: profiles, workspaces, workspace_members, projects, repositories
-- RLS enabled on all workspace-scoped tables.

-- profiles --------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users can read their own profile"
on public.profiles for select
using (auth.uid() = id);

create policy "Users can update their own profile"
on public.profiles for update
using (auth.uid() = id);

create policy "Users can insert their own profile"
on public.profiles for insert
with check (auth.uid() = id);

-- workspaces ------------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  owner_id uuid references auth.users(id),
  plan text default 'free',
  created_at timestamptz default now()
);

alter table public.workspaces enable row level security;

-- workspace_members -----------------------------------------------------------
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz default now(),
  unique (workspace_id, user_id)
);

alter table public.workspace_members enable row level security;

create policy "Members can read their memberships"
on public.workspace_members for select
using (user_id = auth.uid());

create policy "Workspace members can read workspaces"
on public.workspaces for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = workspaces.id and wm.user_id = auth.uid()
  )
);

create policy "Owners can update workspaces"
on public.workspaces for update
using (owner_id = auth.uid());

create policy "Authenticated users can create workspaces"
on public.workspaces for insert
with check (owner_id = auth.uid());

-- projects --------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  website_url text,
  detected_stack jsonb default '{}'::jsonb,
  health_score int default 0,
  created_at timestamptz default now(),
  unique (workspace_id, slug)
);

alter table public.projects enable row level security;

create policy "Workspace members can read projects"
on public.projects for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = projects.workspace_id and wm.user_id = auth.uid()
  )
);

create policy "Workspace admins can mutate projects"
on public.projects for all
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = projects.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
)
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = projects.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

-- repositories ----------------------------------------------------------------
create table if not exists public.repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null,
  external_id text,
  name text not null,
  full_name text,
  default_branch text,
  private boolean default true,
  last_scanned_at timestamptz,
  created_at timestamptz default now()
);

alter table public.repositories enable row level security;

create policy "Workspace members can read repositories"
on public.repositories for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = repositories.workspace_id and wm.user_id = auth.uid()
  )
);

-- Helper trigger: create profile + default workspace on new auth user ---------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
  workspace_slug text;
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;

  workspace_slug := 'ws-' || substr(replace(new.id::text, '-', ''), 1, 8);

  insert into public.workspaces (name, slug, owner_id)
  values (coalesce(new.raw_user_meta_data->>'name', 'My workspace'), workspace_slug, new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();
