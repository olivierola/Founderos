-- 0210_agent_soul_preferences.sql
-- Un agent s'écrit en TROIS fichiers, pas en un seul bloc d'instructions.
--
-- Jusqu'ici tout tenait dans `instructions` (+ un `persona` d'une ligne) : la
-- procédure, le caractère et les habitudes de l'utilisateur se disputaient le
-- même texte. Trois problèmes en découlaient :
--
--   1. Le caractère se diluait. Noyé au milieu d'une procédure numérotée, il
--      n'était plus lu comme une identité mais comme une consigne de plus.
--   2. Rien n'était apprenable. Une préférence exprimée dans le chat
--      (« toujours en français », « pas d'emoji », « les alertes sur Slack pas
--      par mail ») disparaissait avec la conversation : l'agent la redemandait
--      à la session suivante.
--   3. Tout partait à chaque requête. Instructions, skills et mémoire étaient
--      injectés en entier quelle que soit la tâche.
--
-- D'où la séparation :
--
--   • instructions — CE QUE l'agent fait : sa procédure de travail, ses règles
--     absolues. Écrit par l'humain. Toujours envoyé.
--   • soul         — QUI il est : caractère, voix, valeurs, ce sur quoi il ne
--     transige pas. Écrit par l'humain, court, stable. Toujours envoyé.
--   • preferences  — COMMENT son utilisateur aime les choses. Écrit par
--     l'humain ET par l'agent lui-même (outil remember_preference), une
--     préférence par ligne, SÉLECTIONNÉ selon la tâche du moment.
--
-- Format du fichier de préférences (une ligne = une préférence) :
--
--     - [langue] Répondre en français, même sur une demande en anglais.
--     - ![sécurité] Ne jamais poster dans #general sans validation.
--
-- Le `!` devant le sujet marque une préférence TOUJOURS envoyée (elle échappe
-- à la sélection par pertinence). Le sujet entre crochets est libre et court —
-- il sert à regrouper, et à repérer un doublon quand l'agent en ajoute une.
--
-- Les écritures de l'agent passent par un compare-and-swap côté applicatif
-- (update … where preferences = <ancienne valeur>), donc deux sous-agents qui
-- apprennent en même temps ne peuvent pas s'écraser l'un l'autre.

alter table public.internal_agents
  add column if not exists soul text,
  add column if not exists preferences text,
  -- Quand le fichier a bougé pour la dernière fois, et par qui : l'UI montre
  -- « appris par l'agent il y a 2 h » à côté du fichier, sinon une ligne
  -- apparue toute seule ressemble à un bug.
  add column if not exists preferences_updated_at timestamptz,
  add column if not exists preferences_updated_by text;

comment on column public.internal_agents.soul is
  'Qui est l''agent : caractère, voix, valeurs. Court et stable — toujours envoyé dans le prompt.';
comment on column public.internal_agents.preferences is
  'Préférences de l''utilisateur, une par ligne au format "- [sujet] texte" ("- ![sujet] …" = toujours envoyée). Écrit par l''humain et par l''agent (remember_preference) ; sélectionné par pertinence à chaque tâche.';
comment on column public.internal_agents.preferences_updated_by is
  '"agent" ou "user" — qui a écrit la dernière version du fichier de préférences.';

-- Les agents existants n'ont pas d'âme écrite : plutôt que de les laisser
-- vides, on reprend le persona, qui EST déjà une phrase de caractère. C'est
-- une graine, pas une fin — l'écran Fichiers la donne à retravailler.
update public.internal_agents
   set soul = persona
 where soul is null
   and persona is not null
   and length(trim(persona)) > 0;
