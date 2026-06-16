-- Simulation graph & scale: archetype-based personas (so we can scale to ~1000
-- agents), relations/influence edges between archetypes, and per-round sentiment.

-- personas become "archetypes" with a population weight (how many agents they
-- represent). is_archetype=true for the graph nodes.
alter table public.sim_personas
  add column if not exists is_archetype boolean not null default true,
  add column if not exists population int not null default 1,         -- agents this node represents
  add column if not exists sentiment_score real not null default 0,   -- -1..1, evolves per round
  add column if not exists cluster text;                              -- optional grouping label

-- Total simulated population for the run (can be up to 1000).
alter table public.sim_simulations
  add column if not exists population_size int not null default 0;

-- Relations between archetype personas — the graph edges (who influences whom).
create table if not exists public.sim_relations (
  id uuid primary key default gen_random_uuid(),
  simulation_id uuid not null references public.sim_simulations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.sim_personas(id) on delete cascade,
  target_id uuid not null references public.sim_personas(id) on delete cascade,
  -- ally | rival | mentor | follower | peer | influences
  kind text not null default 'influences',
  label text,
  strength real not null default 0.5,   -- 0..1 influence weight
  created_at timestamptz not null default now()
);
create index if not exists idx_sim_relations_sim on public.sim_relations(simulation_id);

alter table public.sim_relations enable row level security;
drop policy if exists "members read sim_relations" on public.sim_relations;
create policy "members read sim_relations" on public.sim_relations for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_relations.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "members write sim_relations" on public.sim_relations;
create policy "members write sim_relations" on public.sim_relations for insert
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_relations.workspace_id and wm.user_id = auth.uid()));
drop policy if exists "members delete sim_relations" on public.sim_relations;
create policy "members delete sim_relations" on public.sim_relations for delete
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = sim_relations.workspace_id and wm.user_id = auth.uid()));
