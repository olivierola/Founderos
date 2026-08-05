-- 0158_service_dashboard_settings.sql
-- Per-service-dashboard settings. A service dashboard is its own little product
-- (its sidebar, its assistant, its agents, its rooms), so it gets its own
-- Settings surface INSIDE the dashboard instead of bouncing users to the
-- org-wide Admin area. Two columns carry it:
--   description — one line shown in the switcher / settings header
--   settings    — jsonb blob of the dashboard's own preferences:
--     {
--       "landing": "home" | "agents" | "schedules" | "memory" | "artifacts",
--       "hidden_tabs": ["schedules", …],          -- nav items hidden here
--       "sidebar_collapsed": false,                -- default sidebar state
--       "agent_defaults": {                        -- applied to NEW agents
--         "model": "deepseek", "sandbox_mode": "cloud",
--         "max_steps": 8, "max_run_cost_usd": 0.5,
--         "swarm_enabled": true, "requires_approval": false
--       },
--       "rooms": {
--         "auto_add_orchestrator": true,           -- seed new rooms w/ assistant
--         "default_responder_agent_id": "<uuid>"   -- who answers untagged turns
--       }
--     }
alter table public.service_dashboards
  add column if not exists description text,
  add column if not exists settings jsonb not null default '{}'::jsonb;
