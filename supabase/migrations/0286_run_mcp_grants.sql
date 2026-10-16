-- 0286_run_mcp_grants.sql
-- Les serveurs MCP qu'un workflow ouvre au run qui l'exécute.
--
-- Une étape de workflow peut s'appuyer sur un ou plusieurs serveurs MCP, avec
-- tous leurs outils ou une sélection (bloc Outil, source « Serveurs MCP »). Au
-- lancement d'une procédure, le moteur (workflow-engine.ts) en fait l'union et
-- l'enregistre ici : [{ "server_id": uuid, "tools": ["pods_list", …] }], une
-- liste d'outils vide valant « tous ses outils ». Le run voit alors ces serveurs
-- en plus de ceux activés sur l'agent, limités aux outils accordés
-- (_shared/mcp-servers.ts) ; une délégation et un sous-agent recopient les accès
-- du run qui les lance.
--
-- Ce n'est pas un droit de plus : qui peut écrire un workflow peut déjà activer
-- ces serveurs sur un agent, le chargement se limite à l'espace de l'agent, et
-- chaque appel reste soumis à la politique et aux approbations du serveur MCP.

alter table public.internal_agent_runs
  add column if not exists mcp_grants jsonb not null default '[]'::jsonb
    check (jsonb_typeof(mcp_grants) = 'array' and jsonb_array_length(mcp_grants) <= 20);

comment on column public.internal_agent_runs.mcp_grants is
  'Serveurs MCP accordés au run par un workflow : [{server_id, tools}] (tools vide = tous). Voir 0286.';
