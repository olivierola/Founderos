-- Les outils d'une machine, choisis dans le catalogue (backend/src/machines/catalog.ts).
--
-- On part d'une machine de base et on y met les outils qu'on veut : la colonne
-- `tools` porte leurs identifiants. `template` (0317) devient le preset choisi
-- au départ (une sélection toute faite), gardé pour l'affichage ; ce qui est
-- construit, c'est `tools`.

alter table public.machines
  add column if not exists tools text[] not null default '{}';

alter table public.embedded_agent_configs
  add column if not exists tools text[] not null default '{}';

comment on column public.machines.tools is
  'Les outils du catalogue installés dans l''image de la machine.';
comment on column public.embedded_agent_configs.tools is
  'Les outils du catalogue installés dans le conteneur de l''agent embarqué.';
comment on column public.machines.template is
  'Le preset du catalogue choisi au départ (pour l''affichage ; la build suit tools).';
comment on column public.embedded_agent_configs.machine_template is
  'Le preset du catalogue choisi au départ (pour l''affichage ; la build suit tools).';
