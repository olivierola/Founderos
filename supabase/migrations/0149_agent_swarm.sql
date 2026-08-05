-- Swarm ("Essaim") — make the existing parallel sub-agent capability a
-- user-controllable, visible property of an agent instead of an always-on
-- implicit tool.
--
-- The engine already lets any primary run fan independent subtasks out to
-- ephemeral sub-agents (spawn_parallel_agents, migrations 0143/0144). This adds
-- the OWNER's switch on top:
--   swarm_enabled           — whether the agent is even OFFERED the tool. When
--                             true (the default, preserving today's behaviour)
--                             the AGENT still decides per task whether to fan
--                             out; when false the tool isn't registered at all.
--   swarm_max_concurrency   — how many sub-agents may run at once (wave size),
--                             capped engine-side at 8.

alter table public.internal_agents
  add column if not exists swarm_enabled boolean not null default true;

alter table public.internal_agents
  add column if not exists swarm_max_concurrency int not null default 8
    check (swarm_max_concurrency between 2 and 8);

comment on column public.internal_agents.swarm_enabled is
  'When true, the agent MAY spawn parallel sub-agents (it still decides per task). False removes the capability entirely.';
comment on column public.internal_agents.swarm_max_concurrency is
  'Max sub-agents running at once (wave size), 2..8.';
