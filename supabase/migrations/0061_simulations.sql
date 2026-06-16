-- Simulations (MiroFish-inspired): seed material + a question → a population of
-- AI personas → rounds of simulated reactions/interactions → a prediction report
-- → chat with a persona. LLM-driven (DeepSeek), executed by the unified runner.

create table if not exists public.sim_simulations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  -- The seed material (pasted text / report / idea description).
  seed_text text not null default '',
  -- The natural-language prediction question / scenario to test.
  question text not null default '',
  persona_count int not null default 12,
  total_rounds int not null default 8,
  current_round int not null default 0,
  status text not null default 'draft'
    check (status in ('draft','preparing','ready','queued','running','completed','failed')),
  -- Final prediction report (DeliverableReport-style JSON or markdown).
  report jsonb,
  error text,
  -- Runner claim bookkeeping.
  claimed_by text,
  claimed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sim_project on public.sim_simulations(project_id);
create index if not exists idx_sim_status on public.sim_simulations(status);

create table if not exists public.sim_personas (
  id uuid primary key default gen_random_uuid(),
  simulation_id uuid not null references public.sim_simulations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  role text,                          -- e.g. "Power user", "Skeptical CFO"
  bio text,                           -- short persona description
  stance text,                        -- initial stance toward the idea
  traits jsonb not null default '{}'::jsonb,
  avatar_emoji text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sim_personas_sim on public.sim_personas(simulation_id);

create table if not exists public.sim_actions (
  id uuid primary key default gen_random_uuid(),
  simulation_id uuid not null references public.sim_simulations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  round int not null,
  persona_id uuid references public.sim_personas(id) on delete set null,
  kind text not null default 'post'   -- post | reply | reaction | signal
    check (kind in ('post','reply','reaction','signal')),
  content text not null,
  sentiment text,                     -- positive | neutral | negative
  created_at timestamptz not null default now()
);
create index if not exists idx_sim_actions_sim on public.sim_actions(simulation_id, round);

create table if not exists public.sim_messages (
  id uuid primary key default gen_random_uuid(),
  simulation_id uuid not null references public.sim_simulations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  persona_id uuid references public.sim_personas(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sim_messages_persona on public.sim_messages(persona_id, created_at);

-- RLS: workspace members can read/write rows in their workspaces. The runner /
-- edge functions use the service role and bypass RLS.
do $$
declare t text;
begin
  foreach t in array array['sim_simulations','sim_personas','sim_actions','sim_messages'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "members read %1$s" on public.%1$s;', t);
    execute format('drop policy if exists "members write %1$s" on public.%1$s;', t);
    execute format('drop policy if exists "members update %1$s" on public.%1$s;', t);
    execute format('drop policy if exists "members delete %1$s" on public.%1$s;', t);
  end loop;
end $$;

-- sim_simulations gate by its own workspace_id; child tables gate via parent.
create policy "members read sim_simulations" on public.sim_simulations for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_simulations.workspace_id and wm.user_id = auth.uid()));
create policy "members write sim_simulations" on public.sim_simulations for insert
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_simulations.workspace_id and wm.user_id = auth.uid()));
create policy "members update sim_simulations" on public.sim_simulations for update
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_simulations.workspace_id and wm.user_id = auth.uid()));
create policy "members delete sim_simulations" on public.sim_simulations for delete
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_simulations.workspace_id and wm.user_id = auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['sim_personas','sim_actions','sim_messages'] loop
    execute format($f$
      create policy "members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format($f$
      create policy "members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format($f$
      create policy "members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;

-- Realtime so the live action feed streams to the UI.
alter publication supabase_realtime add table public.sim_actions;
alter publication supabase_realtime add table public.sim_simulations;

-- Atomically claim the oldest queued simulation for a runner.
create or replace function public.claim_simulation(_runner text)
returns public.sim_simulations
language plpgsql security definer set search_path = public as $$
declare claimed public.sim_simulations;
begin
  select * into claimed from public.sim_simulations
   where status = 'queued'
   order by created_at asc
   for update skip locked
   limit 1;
  if claimed.id is null then return null; end if;
  update public.sim_simulations
     set status = 'running', claimed_by = _runner, claimed_at = now(), updated_at = now()
   where id = claimed.id
   returning * into claimed;
  return claimed;
end $$;
