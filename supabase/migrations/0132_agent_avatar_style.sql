-- 0132_agent_avatar_style.sql
-- Per-agent visual identity choice: show the uploaded AVATAR, or a living ORB
-- (components/AgentOrb). Either/or — never both. Defaults to 'avatar'.

alter table public.internal_agents
  add column if not exists avatar_style text not null default 'avatar'
    check (avatar_style in ('avatar', 'orb'));
