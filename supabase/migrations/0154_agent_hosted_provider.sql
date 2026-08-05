-- Let an agent run on a company-registered model (an aiops_providers row of kind
-- 'cloud_endpoint' — cloud API by key, or a custom OpenAI-compatible endpoint),
-- not only a RunPod GPU server. Null = the FounderOS default provider.
--
-- The provider's API key stays encrypted on aiops_providers (secret_ciphertext);
-- the run engine (service role) resolves it at call time — the key never reaches
-- the browser (the aiops_providers_public view already hides it).

alter table public.internal_agents
  add column if not exists hosted_provider_id uuid references public.aiops_providers(id) on delete set null;

comment on column public.internal_agents.hosted_provider_id is
  'Registered model (aiops_providers cloud_endpoint) this agent runs on; null = FounderOS default. hosted_model holds the chosen model id.';
