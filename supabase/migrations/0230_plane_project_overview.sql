-- 0230_plane_project_overview.sql
-- L'Overview d'un projet devient un DOCUMENT.
--
-- Jusqu'ici la description d'un projet était une ligne de texte dans un coin de
-- page, à côté de compteurs. C'est trop peu pour ce que cette page sert
-- réellement : quelqu'un qui arrive sur un projet veut lire ce qu'il est, ce
-- qu'il couvre, ce qui est décidé — un texte structuré avec des titres, des
-- listes et des tableaux, pas un champ de deux lignes.
--
-- D'où les mêmes deux colonnes que les pages (0228) : `description_rich` est la
-- SOURCE que relit l'éditeur, `description` en reste le rendu texte, celui que
-- lisent la recherche, les exports et les cartes de la liste des projets.

alter table public.pj_projects
  add column if not exists description_rich jsonb;

comment on column public.pj_projects.description_rich is
  'La source de l''éditeur (arbre Plate) de l''Overview. `description` en est le rendu texte : recherche, exports et cartes projet le lisent, jamais l''éditeur.';
