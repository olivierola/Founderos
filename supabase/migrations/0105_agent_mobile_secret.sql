-- 0105_agent_mobile_secret.sql
-- Mobile companion app auth. An agent can be reached from the FounderOS mobile
-- app with its id + a secret. We store only a SHA-256 hash of the secret (the
-- plaintext is shown once, at generation time, in the web agent settings).
-- mobile_enabled gates access independently of whether a secret exists.

alter table public.internal_agents
  add column if not exists mobile_secret_hash text,
  add column if not exists mobile_enabled boolean not null default false;
