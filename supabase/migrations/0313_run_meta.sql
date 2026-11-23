-- 0313 — L'état métier d'un run, sur le run lui-même.
--
-- L'ancien moteur gardait l'état d'un run en cours dans internal_agent_run_state
-- (transcription, tours, bail des ticks) avec, dans `meta`, ce qui n'était pas
-- de la boucle : la salle ou le workflow servi, la tâche de mission, le contrat
-- de succès, le brouillon de rapport construit section par section. Le harnais
-- OpenCode tient lui-même la transcription et la reprise ; ce qui reste métier
-- vit désormais ici, et survit au run (la table d'état était effacée à la fin).
--
--   kind          chat | mission | room | workflow | a2a
--   task          le texte de la tâche (contrat, initiatives, garde-fous)
--   room          { room_id, placeholder_id, requested_by }
--   mission_task  { mission_id, task_id }
--   workflow_run  { id }
--   a2a           { message_id }
--   contract      le contrat de succès (agent-loop.ts)
--   verify_fails  relances après un contrat non tenu
--   run_context   le contexte du run donné au modèle (reprise après redémarrage)
--   report_draft  le rapport en construction (report_section)

alter table public.internal_agent_runs
  add column if not exists run_meta jsonb not null default '{}'::jsonb;

comment on column public.internal_agent_runs.run_meta is
  'État métier du run (harnais OpenCode) : mode, liaisons salle/mission/workflow/a2a, contrat, contexte, brouillon de rapport.';
