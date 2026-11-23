-- Les machines taillées par métier (catalogue : backend/src/machines/catalog.ts).
--
-- Une machine créée depuis le catalogue garde son modèle (cyber-recon,
-- data-analysis…) : son image est team-machine avec les outils du métier.
-- Un agent embarqué peut partir du même modèle : ses paquets et ses ressources
-- entrent dans le conteneur de l'agent.

alter table public.machines
  add column if not exists template text;

alter table public.embedded_agent_configs
  add column if not exists machine_template text;

comment on column public.machines.template is
  'Le modèle du catalogue dont la machine est faite (null : machine d''équipe de base).';
comment on column public.embedded_agent_configs.machine_template is
  'Le modèle du catalogue dont le conteneur de l''agent reprend les outils et les ressources.';
