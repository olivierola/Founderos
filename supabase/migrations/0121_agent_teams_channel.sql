-- 0121_agent_teams_channel.sql
-- Microsoft Teams as an agent channel (Bot Framework). The provider enum already
-- allows 'teams' (migration 0100). To reply proactively into a Teams conversation
-- the bot needs the per-tenant Bot Framework serviceUrl from the incoming
-- activity — cache it on the channel row.
--
-- Routing: external_team_id holds the Teams AAD tenant id; bot_user_id holds the
-- bot's recipient id (to disambiguate when several agents share a tenant).
-- Reply auth uses the shared Azure Bot app credentials (MICROSOFT_APP_ID /
-- MICROSOFT_APP_PASSWORD secrets), not a per-channel token.

alter table public.internal_agent_channels
  add column if not exists service_url text;
