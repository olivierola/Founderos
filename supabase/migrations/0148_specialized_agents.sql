-- Specialized agents ("studios") — the replacement for the standalone Vibe
-- Code / Test runs / Simulations modules. Instead of a whole module per tool,
-- one agent OWNS the tool: it drives the same engine (fn vibe-code,
-- test-run-orchestrate, simulation-prepare) and produces structured artifacts
-- (deliverables) that render as a real session view.
--
-- `studio` marks such an agent so the UI can give it its premium animated
-- border and route its artifacts to the right renderer. Null = ordinary agent.

alter table public.internal_agents
  add column if not exists studio text
    check (studio is null or studio in ('vibe_code', 'testing', 'simulation'));

comment on column public.internal_agents.studio is
  'Specialized-agent kind. Drives the matching engine + structured artifact renderer; null for ordinary agents.';

-- Studio agents are found by (project, studio) when a service dashboard lists
-- "which specialized agents do I have?".
create index if not exists internal_agents_studio_idx
  on public.internal_agents (project_id, studio)
  where studio is not null;

-- The studio engines are agent TOOLS, so the tool-kind constraint has to admit
-- them (an unlisted kind fails at insert time and the template silently loses
-- its main tool — see 0140 for the same trap with composio_toolkit).
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

-- NB: the full list must carry EVERY kind already in use ('crm' came in with
-- 0142) — a missing one makes this ALTER fail against existing rows.
alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom'
    )
  );

-- Deliverables gain a typed structure for studio sessions. `kind` stays free
-- text (no constraint on that column), so 'coding_session' / 'test_session' /
-- 'simulation_session' need no schema change — but the session artifacts are
-- queried by kind per agent, so index that path.
create index if not exists internal_agent_deliverables_kind_idx
  on public.internal_agent_deliverables (agent_id, kind, created_at desc);
