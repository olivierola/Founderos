-- 0087 · Simulation V2: 100K personas, rich archetypes, real-world enrichment
-- Adds enrichment storage, persona types, and granular sentiment scoring.

-- sim_simulations: enrichment context & config
ALTER TABLE public.sim_simulations
  ADD COLUMN IF NOT EXISTS enrichment      jsonb,
  ADD COLUMN IF NOT EXISTS enrichment_config jsonb;

-- sim_personas: persona type for graph coloring / filtering
ALTER TABLE public.sim_personas
  ADD COLUMN IF NOT EXISTS persona_type text;

-- sim_actions: numeric sentiment (-1..1) alongside the text column
ALTER TABLE public.sim_actions
  ADD COLUMN IF NOT EXISTS sentiment_value real;
