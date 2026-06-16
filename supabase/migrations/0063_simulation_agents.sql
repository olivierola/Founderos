-- Materialize individual agents: 1 node = 1 agent. Archetypes seed the
-- generation; agents (is_archetype=false) are instanced from them and carry a
-- reference back to their archetype. Relations are then derived agent↔agent.
alter table public.sim_personas
  add column if not exists archetype_id uuid references public.sim_personas(id) on delete set null;

create index if not exists idx_sim_personas_arch on public.sim_personas(archetype_id);
create index if not exists idx_sim_personas_sim_kind on public.sim_personas(simulation_id, is_archetype);
