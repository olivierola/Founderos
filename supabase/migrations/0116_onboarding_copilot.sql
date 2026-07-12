-- 0116_onboarding_copilot.sql
-- Co-pilot mode for the live onboarding agent: instead of only pointing/highlighting,
-- the agent may perform UI actions (click/fill/select/submit) on the user's behalf.
-- Opt-in: the founder enables it per public agent; the end user still opts in from
-- the widget ("do it for me"). Destructive actions are never auto-performed.
alter table public.rag_agents
  add column if not exists onboarding_copilot_enabled boolean not null default false;
