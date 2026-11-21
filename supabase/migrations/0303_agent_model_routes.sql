-- 0303 — Les modèles d'un agent, par type de tâche.
--
-- Sur la connexion par défaut de la plateforme (OpenRouter, modèles gratuits),
-- chaque agent peut choisir son modèle par palier : léger, moyen, lourd, et
-- par critère (code, vision, long contexte, image, juges). Même forme que
-- aiops_providers.config.model_routes : {"heavy": "a,b"} ; « a,b » = replis.
-- Une clé absente garde le modèle par défaut de la plateforme.

alter table public.internal_agents
  add column if not exists model_routes jsonb not null default '{}'::jsonb;

comment on column public.internal_agents.model_routes is
  'Modèles de l''agent sur la connexion par défaut, par palier et critère (light, standard, heavy, code, vision, long_context, image, judge).';
