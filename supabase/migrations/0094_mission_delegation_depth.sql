-- 0094_mission_delegation_depth.sql
-- Anti-loop guard for agent-to-agent delegation: track how deep a mission sits
-- in a delegation chain (A delegates to B delegates to C …). create_mission
-- refuses to delegate beyond a max depth, preventing infinite A→B→A loops and
-- unbounded cost on the delegation tree.

alter table public.internal_agent_missions
  add column if not exists delegation_depth int not null default 0;
