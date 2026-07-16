-- 0118_agent_skill_files.sql
-- Multi-file skills (Agent-Skills format): a skill becomes a small bundle of
-- files authored in the skill editor. SKILL.md (the main playbook) stays in
-- agent_skills.system_prompt_extension; this table holds the ADDITIONAL bundled
-- files (references, scripts, examples…) that the agent pulls on demand via the
-- read_skill_file tool (progressive disclosure).

create table if not exists public.agent_skill_files (
  id          uuid primary key default gen_random_uuid(),
  skill_id    uuid not null references public.agent_skills(id) on delete cascade,
  path        text not null,
  content     text not null default '',
  sort        int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (skill_id, path)
);

create index if not exists idx_agent_skill_files_skill on public.agent_skill_files(skill_id);

alter table public.agent_skill_files enable row level security;

-- A user may manage a skill's files iff they may manage the parent skill —
-- mirrors the agent_skills policy (workspace member, or a null-workspace
-- system skill). Runtime reads go through the service role and bypass RLS.
create policy "manage skill_files via parent skill" on public.agent_skill_files for all
  using (exists (
    select 1 from public.agent_skills s
    where s.id = agent_skill_files.skill_id
      and (s.workspace_id is null or exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = s.workspace_id and wm.user_id = auth.uid()))))
  with check (exists (
    select 1 from public.agent_skills s
    where s.id = agent_skill_files.skill_id
      and (s.workspace_id is null or exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = s.workspace_id and wm.user_id = auth.uid()))));
