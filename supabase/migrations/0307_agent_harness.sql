-- 0307 — Le moteur d'un agent : l'ancien, ou OpenCode (docs/harness-opencode).
--
-- Le harnais OpenCode n'existe que dans le backend local (PLATFORM=self,
-- HARNESS_OPENCODE=1). Le choix se fait agent par agent, pour basculer par
-- vagues et revenir en arrière sur un seul agent :
--   legacy   — le moteur de ticks (internal-agent-run), comme avant ;
--   opencode — le moteur d'OpenCode embarqué dans le backend.
-- Sur le cloud, la colonne est ignorée : tout reste sur l'ancien moteur.
--
-- Une conversation garde SA session OpenCode (l'historique d'exécution :
-- appels d'outils, compaction, reprise) ; un run note la session qui l'a
-- produit, pour que le pont réattache ses événements après un redémarrage.

alter table public.internal_agents
  add column if not exists harness text not null default 'legacy';

do $$ begin
  alter table public.internal_agents
    add constraint internal_agents_harness_check check (harness in ('legacy', 'opencode'));
exception when duplicate_object then null; end $$;

alter table public.internal_agent_conversations
  add column if not exists opencode_session_id text;

alter table public.internal_agent_runs
  add column if not exists opencode_session_id text;

create index if not exists internal_agent_runs_opencode_session_idx
  on public.internal_agent_runs (opencode_session_id)
  where opencode_session_id is not null;
