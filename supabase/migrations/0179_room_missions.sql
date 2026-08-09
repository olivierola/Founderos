-- 0179_room_missions.sql
-- Rooms get an ORCHESTRATOR and MISSIONS.
--
-- Until now a room turn was a flat request/response: the human wrote, one or
-- three agents each answered the whole thing on their own. There was no way to
-- express "this piece of work needs three specialists in a specific order", so
-- either one agent did everything badly, or the human hand-routed every step.
--
-- A MISSION is the unit that fixes that: the room's assistant (its orchestrator)
-- reads an incoming request, decides whether it is a plain answer, a routing to
-- one specialist, or real multi-agent work — and when it is the latter, it
-- decomposes the work into MILESTONES (jalons, rendered as a timeline) holding
-- TASKS, each assigned to the agent best suited to it, each declaring what it
-- depends on. The orchestrator then drives it: dispatch what is ready, wait for
-- results, feed those results into the next tasks, record what was learned,
-- move the cards across the kanban, and report back in the room.
--
-- Every room message carries the mission it belongs to, so the thread stays
-- readable when several missions run at once.

-- ── Missions ─────────────────────────────────────────────────────────────────
create table if not exists public.service_room_missions (
  id                    uuid primary key default gen_random_uuid(),
  room_id               uuid not null references public.service_rooms(id) on delete cascade,
  dashboard_id          uuid not null references public.service_dashboards(id) on delete cascade,
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  project_id            uuid not null references public.projects(id) on delete cascade,
  -- The assistant that owns this mission (the room's orchestrator, normally).
  orchestrator_agent_id uuid references public.internal_agents(id) on delete set null,
  title                 text not null,
  objective             text,
  -- The orchestrator's reading of the request: why it decomposed it this way.
  plan_rationale        text,
  status                text not null default 'planning'
                        check (status in ('planning','running','paused','blocked','done','failed','cancelled')),
  -- 0-100, recomputed from the tasks by the trigger below.
  progress              int  not null default 0,
  color                 text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  started_at            timestamptz,
  completed_at          timestamptz
);
create index if not exists idx_room_missions_room on public.service_room_missions(room_id, created_at desc);
create index if not exists idx_room_missions_dashboard on public.service_room_missions(dashboard_id, updated_at desc);

-- ── Milestones (jalons) — the timeline rows ──────────────────────────────────
create table if not exists public.service_room_milestones (
  id          uuid primary key default gen_random_uuid(),
  mission_id  uuid not null references public.service_room_missions(id) on delete cascade,
  title       text not null,
  description text,
  position    int  not null default 0,
  status      text not null default 'pending'
              check (status in ('pending','active','done','blocked')),
  -- Planned window. The orchestrator estimates it at planning time so the
  -- timeline has something to draw before anything has run.
  starts_at   timestamptz,
  ends_at     timestamptz,
  progress    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_room_milestones_mission on public.service_room_milestones(mission_id, position);

-- ── Tasks — one unit of work, one assignee agent ─────────────────────────────
create table if not exists public.service_room_tasks (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references public.service_room_missions(id) on delete cascade,
  milestone_id   uuid references public.service_room_milestones(id) on delete set null,
  -- Null while the orchestrator has not picked (or created) an assignee yet.
  agent_id       uuid references public.internal_agents(id) on delete set null,
  title          text not null,
  -- The brief actually handed to the agent when the task is dispatched.
  description    text,
  status         text not null default 'todo'
                 check (status in ('todo','in_progress','waiting','review','blocked','done','failed','skipped')),
  position       int  not null default 0,
  -- Task ids that must be `done` before this one may be dispatched. This is
  -- what lets the orchestrator pause: it dispatches only the ready frontier.
  depends_on     uuid[] not null default '{}',
  -- The agent run that executed it, and the room message that carries its reply.
  run_id         uuid references public.internal_agent_runs(id) on delete set null,
  message_id     uuid references public.service_room_messages(id) on delete set null,
  -- What the agent produced, condensed — fed into dependent tasks' briefs.
  result_summary text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_room_tasks_mission on public.service_room_tasks(mission_id, position);
create index if not exists idx_room_tasks_status on public.service_room_tasks(mission_id, status);

-- ── Orchestration trace ──────────────────────────────────────────────────────
-- Why the orchestrator did what it did: routing decisions, dispatches, waits,
-- resumptions, memorisations. Rendered as the mission's "Exécution" tab.
create table if not exists public.service_room_mission_events (
  id          uuid primary key default gen_random_uuid(),
  mission_id  uuid not null references public.service_room_missions(id) on delete cascade,
  task_id     uuid references public.service_room_tasks(id) on delete cascade,
  agent_id    uuid references public.internal_agents(id) on delete set null,
  kind        text not null
              check (kind in ('routed','planned','dispatched','waiting','completed','failed',
                              'replanned','memorised','agent_created','note','finished')),
  message     text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_room_mission_events on public.service_room_mission_events(mission_id, created_at);

-- ── Messages carry their mission ─────────────────────────────────────────────
alter table public.service_room_messages
  add column if not exists mission_id uuid references public.service_room_missions(id) on delete set null;
alter table public.service_room_messages
  add column if not exists task_id uuid references public.service_room_tasks(id) on delete set null;
create index if not exists idx_room_messages_mission on public.service_room_messages(mission_id, created_at);

-- ── Progress rollup ──────────────────────────────────────────────────────────
-- Mission and milestone progress are DERIVED, never written by the agent: an
-- orchestrator that could set its own progress would be grading its own
-- homework, which is exactly the failure mode the loop engine exists to stop.
create or replace function public.service_room_mission_rollup() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_mission   uuid;
  v_milestone uuid;
  v_total   int;
  v_done    int;
  v_failed  int;
  v_running int;
begin
  -- NEW is unassigned on DELETE and OLD on INSERT, so neither may be touched
  -- unconditionally: reading the wrong one raises "record is not assigned yet"
  -- and takes the whole task update down with it.
  if TG_OP = 'DELETE' then
    v_mission := old.mission_id;
    v_milestone := old.milestone_id;
  else
    v_mission := new.mission_id;
    v_milestone := new.milestone_id;
    if TG_OP = 'UPDATE' and old.milestone_id is distinct from new.milestone_id then
      -- A task that moved between milestones leaves the old one stale; roll the
      -- source up too by handling it first.
      update public.service_room_milestones ms set
        progress = coalesce((
          select (count(*) filter (where status in ('done','skipped')) * 100) / nullif(count(*), 0)
          from public.service_room_tasks t where t.milestone_id = ms.id), 0),
        updated_at = now()
      where ms.id = old.milestone_id;
    end if;
  end if;
  if v_mission is null then
    return case when TG_OP = 'DELETE' then old else new end;
  end if;

  select count(*),
         count(*) filter (where status in ('done','skipped')),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status in ('in_progress','waiting','review'))
    into v_total, v_done, v_failed, v_running
    from public.service_room_tasks where mission_id = v_mission;

  update public.service_room_missions m set
    progress = case when v_total = 0 then 0 else (v_done * 100) / v_total end,
    status = case
      when m.status in ('cancelled','paused') then m.status
      when v_total = 0 then m.status
      when v_done = v_total then 'done'
      when v_failed > 0 and v_done + v_failed = v_total then 'failed'
      when v_running > 0 then 'running'
      else m.status
    end,
    completed_at = case when v_total > 0 and v_done = v_total then now() else m.completed_at end,
    updated_at = now()
  where m.id = v_mission;

  -- Milestone rollup for the row the touched task belongs to.
  if v_milestone is not null then
    update public.service_room_milestones ms set
      progress = coalesce((
        select (count(*) filter (where status in ('done','skipped')) * 100) / nullif(count(*), 0)
        from public.service_room_tasks t where t.milestone_id = ms.id), 0),
      status = case
        when not exists (select 1 from public.service_room_tasks t where t.milestone_id = ms.id) then ms.status
        when not exists (select 1 from public.service_room_tasks t where t.milestone_id = ms.id and t.status not in ('done','skipped')) then 'done'
        when exists (select 1 from public.service_room_tasks t where t.milestone_id = ms.id and t.status in ('in_progress','waiting','review')) then 'active'
        when exists (select 1 from public.service_room_tasks t where t.milestone_id = ms.id and t.status = 'blocked') then 'blocked'
        else ms.status
      end,
      updated_at = now()
    where ms.id = v_milestone;
  end if;

  return case when TG_OP = 'DELETE' then old else new end;
end $$;

drop trigger if exists trg_room_mission_rollup on public.service_room_tasks;
create trigger trg_room_mission_rollup
  after insert or update or delete on public.service_room_tasks
  for each row execute function public.service_room_mission_rollup();

-- ── RLS — same rule as the rest of the room: workspace membership ────────────
alter table public.service_room_missions       enable row level security;
alter table public.service_room_milestones     enable row level security;
alter table public.service_room_tasks          enable row level security;
alter table public.service_room_mission_events enable row level security;

drop policy if exists "members manage room missions" on public.service_room_missions;
create policy "members manage room missions" on public.service_room_missions for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_room_missions.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = service_room_missions.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "members manage room milestones" on public.service_room_milestones;
create policy "members manage room milestones" on public.service_room_milestones for all
  using  (exists (select 1 from public.service_room_missions m join public.workspace_members wm on wm.workspace_id = m.workspace_id
                  where m.id = service_room_milestones.mission_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.service_room_missions m join public.workspace_members wm on wm.workspace_id = m.workspace_id
                  where m.id = service_room_milestones.mission_id and wm.user_id = auth.uid()));

drop policy if exists "members manage room tasks" on public.service_room_tasks;
create policy "members manage room tasks" on public.service_room_tasks for all
  using  (exists (select 1 from public.service_room_missions m join public.workspace_members wm on wm.workspace_id = m.workspace_id
                  where m.id = service_room_tasks.mission_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.service_room_missions m join public.workspace_members wm on wm.workspace_id = m.workspace_id
                  where m.id = service_room_tasks.mission_id and wm.user_id = auth.uid()));

drop policy if exists "members read room mission events" on public.service_room_mission_events;
create policy "members read room mission events" on public.service_room_mission_events for all
  using  (exists (select 1 from public.service_room_missions m join public.workspace_members wm on wm.workspace_id = m.workspace_id
                  where m.id = service_room_mission_events.mission_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.service_room_missions m join public.workspace_members wm on wm.workspace_id = m.workspace_id
                  where m.id = service_room_mission_events.mission_id and wm.user_id = auth.uid()));

-- ── Run-event kinds ──────────────────────────────────────────────────────────
-- 'prompt' is the prompt compiler's budget trace (what each section cost, how
-- many tool schemas were sent); 'route' is the orchestrator's routing decision.
alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;
alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in (
    'llm_call','tool_call','tool_result','status','log','error',
    'plan','plan_step','tool_error','question','todos','ui',
    'browser_navigate','browser_action','browser_screenshot',
    'loop','prompt','route'
  ));
