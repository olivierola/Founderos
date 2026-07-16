-- 0124_vibe_customize.sql
-- Vibe Code "Personnaliser" parity with the internal-agent Customize tab:
--   · vibe_skills       → reusable task templates (markdown) the agent can run
--   · vibe_mcp_servers  → workspace MCP servers attached to the coding agent
--                         (their tools become callable inside the run loop)
--   · vibe_automations  → recurring coding tasks (prompt + schedule + repo)
-- All project-scoped, members-RLS like vibe_sessions/vibe_memory (0112/0113).

-- ── Skills: reusable task templates ─────────────────────────────────────────
create table if not exists public.vibe_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- Markdown body: the task prompt injected when the skill is run.
  body text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_vibe_skills_project on public.vibe_skills(project_id, created_at);

-- ── MCP servers attached to the coding agent ────────────────────────────────
create table if not exists public.vibe_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  server_id uuid not null references public.mcp_servers(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, server_id)
);
create index if not exists idx_vibe_mcp_project on public.vibe_mcp_servers(project_id);

-- ── Automations: recurring coding tasks ─────────────────────────────────────
create table if not exists public.vibe_automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  prompt text not null default '',
  repository_id uuid references public.repositories(id) on delete set null,
  branch text,
  -- 'manual' = run on demand only; others are picked up by a scheduler.
  schedule text not null default 'manual' check (schedule in ('manual','hourly','daily','weekly')),
  enabled boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_vibe_automations_project on public.vibe_automations(project_id, enabled);
create index if not exists idx_vibe_automations_due on public.vibe_automations(next_run_at) where enabled and schedule <> 'manual';

-- ── RLS (members of the workspace) ──────────────────────────────────────────
alter table public.vibe_skills enable row level security;
alter table public.vibe_mcp_servers enable row level security;
alter table public.vibe_automations enable row level security;

drop policy if exists "Members read vibe_skills" on public.vibe_skills;
create policy "Members read vibe_skills" on public.vibe_skills for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_skills.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write vibe_skills" on public.vibe_skills;
create policy "Members write vibe_skills" on public.vibe_skills for all
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_skills.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_skills.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members read vibe_mcp_servers" on public.vibe_mcp_servers;
create policy "Members read vibe_mcp_servers" on public.vibe_mcp_servers for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_mcp_servers.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write vibe_mcp_servers" on public.vibe_mcp_servers;
create policy "Members write vibe_mcp_servers" on public.vibe_mcp_servers for all
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_mcp_servers.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_mcp_servers.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members read vibe_automations" on public.vibe_automations;
create policy "Members read vibe_automations" on public.vibe_automations for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_automations.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "Members write vibe_automations" on public.vibe_automations;
create policy "Members write vibe_automations" on public.vibe_automations for all
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_automations.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = vibe_automations.workspace_id and wm.user_id = auth.uid()));
