-- 0111_agent_hosted_model.sql
-- Let an internal agent run on a self-hosted model instead of the default
-- provider (DeepSeek/Groq). When hosted_endpoint_url is set, internal-agent-run
-- routes the agent's execution turns to this OpenAI-compatible endpoint — in
-- practice a model served by a rented RunPod GPU pod (aiops_servers.endpoint_url,
-- vLLM on :8000/v1). Null = unchanged behaviour (all existing agents).

alter table public.internal_agents
  add column if not exists hosted_endpoint_url text,   -- OpenAI-compatible base URL (…/v1)
  add column if not exists hosted_model text,          -- model name the endpoint serves
  add column if not exists hosted_server_id uuid references public.aiops_servers(id) on delete set null;

-- Remember which model a rented pod serves (the HF repo passed to vLLM), so an
-- agent bound to that server knows the `model` name to send to /chat/completions.
alter table public.aiops_servers
  add column if not exists served_model text;
