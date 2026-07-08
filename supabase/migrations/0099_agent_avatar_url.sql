-- 0099_agent_avatar_url.sql
-- Agents can now have a realistic avatar image (picked at creation) in addition
-- to the emoji fallback. Stores the avatar image URL.
alter table public.internal_agents
  add column if not exists avatar_url text;
