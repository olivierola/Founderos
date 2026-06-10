-- Activation Engine — the missing link between raw analytics and the proactive
-- RAG agent. It turns the event stream (product_events) and the onboarding flows
-- (rag_onboarding_*) into a *per-visitor activation state* that drives proactive
-- agent interventions in the embedded widget.
--
-- Inspired by the Onboarder SDK's session/activation model, re-platformed onto
-- FounderOS's existing workspace / project / rag_agent / event_definitions stack.
--
-- Objects:
--   * activation_sessions  — one row per (project, agent, visitor): the live
--                            state + the computed activation_score.
--   * activation_rules     — OPTIONAL per-agent overrides for behavioural
--                            triggers. When an agent has no enabled rules, the
--                            rag-activation-tick function falls back to a static
--                            default rule set, so the engine works zero-config.
--   * activation_interventions — audit of fired proactive interventions.
--
-- The score itself is a weighted sum with *static, tuned weights* baked into the
-- tick function (no per-project knobs). The only per-project input is which
-- events are flagged event_definitions.is_key_action — so what already drives
-- funnels also drives activation.

-- ── Per-visitor activation state ───────────────────────────────────────────
create table if not exists public.activation_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,

  -- The end user. visitor_id is the widget's anonymous local id; external_user_id
  -- is set once the host SaaS identifies the user. user_email mirrors track-event.
  visitor_id text,
  external_user_id text,
  user_email text,

  -- Live parcours state (the Onboarder session shape).
  visited_routes text[] not null default '{}',
  used_features text[] not null default '{}',
  completed_intents text[] not null default '{}',
  conversation_turns int not null default 0,

  -- Activation outcome.
  activation_score int not null default 0,
  activated boolean not null default false,
  activated_at timestamptz,

  -- Proactivity bookkeeping (anti-spam, like Onboarder's cooldown).
  proactive_cooldown_until timestamptz,
  last_route text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- One session row per visitor (or external user) per agent.
  unique (agent_id, visitor_id),
  unique (agent_id, external_user_id)
);

create index if not exists idx_activation_sessions_project
  on public.activation_sessions(project_id, last_seen_at desc);
create index if not exists idx_activation_sessions_agent_activated
  on public.activation_sessions(agent_id, activated);

-- ── Behavioural trigger rules (OPTIONAL overrides) ─────────────────────────
-- The tick function ships a static default rule set. These rows, when present
-- and enabled for an agent, REPLACE the defaults for that agent — evaluated by
-- priority, firing the first match (respecting the session cooldown).
create table if not exists public.activation_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id uuid not null references public.rag_agents(id) on delete cascade,

  name text not null,
  enabled boolean not null default true,
  priority int not null default 0,            -- lower = evaluated first

  -- Trigger signal this rule reacts to.
  trigger_type text not null check (trigger_type in
    ('idle','rage_click','route_change','low_score','feature_unused','manual')),

  -- Conditions (all that apply must hold). Unused keys are ignored.
  idle_seconds int,                           -- for 'idle'
  rage_click_threshold int default 4,         -- for 'rage_click'
  on_route text,                              -- glob-ish route this rule applies to (e.g. /billing*)
  score_below int,                            -- for 'low_score'
  unused_feature text,                        -- for 'feature_unused'
  min_seconds_on_page int default 0,          -- gate: only after N seconds on page

  -- What the agent does when the rule fires.
  action_kind text not null default 'orchestrate'
    check (action_kind in ('orchestrate','suggest_flow','message')),
  flow_id uuid references public.rag_onboarding_flows(id) on delete set null,
  message text,                               -- for action_kind = 'message'
  cooldown_seconds int not null default 300,  -- per-session cooldown after firing

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_activation_rules_agent
  on public.activation_rules(agent_id, enabled, priority);

-- ── Audit of fired proactive interventions ─────────────────────────────────
-- Feeds the dashboard "interventions & acceptance rate" view.
create table if not exists public.activation_interventions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  session_id uuid references public.activation_sessions(id) on delete cascade,
  rule_id uuid references public.activation_rules(id) on delete set null,

  trigger_type text not null,
  route text,
  message text,                               -- what the agent surfaced
  -- Outcome lifecycle: shown → (accepted | dismissed | ignored).
  outcome text not null default 'shown'
    check (outcome in ('shown','accepted','dismissed','ignored')),
  outcome_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_activation_interventions_project
  on public.activation_interventions(project_id, created_at desc);
create index if not exists idx_activation_interventions_session
  on public.activation_interventions(session_id, created_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.activation_sessions enable row level security;
alter table public.activation_rules enable row level security;
alter table public.activation_interventions enable row level security;

-- Sessions + interventions are written by the service role (public tick endpoint)
-- and read by workspace members. Rules are optional member-managed overrides.
do $$ declare t text;
begin
  -- Read-only-for-members tables (service role writes).
  foreach t in array array['activation_sessions','activation_interventions']
  loop
    execute format('drop policy if exists "members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members read %1$s" on public.%1$s for select
      using (exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
      ));
    $f$, t);
    execute format('drop policy if exists "service writes %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "service writes %1$s" on public.%1$s for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
    $f$, t);
  end loop;

  -- Member-managed config tables.
  foreach t in array array['activation_rules']
  loop
    execute format('drop policy if exists "members manage %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "members manage %1$s" on public.%1$s for all
      using (exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
      ))
      with check (exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
      ));
    $f$, t);
  end loop;
end $$;
