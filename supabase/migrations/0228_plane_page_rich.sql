-- 0228_plane_page_rich.sql
-- Le contenu riche des pages, dans sa propre colonne.
--
-- `description_html` reste : c'est lui qu'on exporte, qu'on envoie par mail et
-- qu'on indexe. Mais l'éditeur du produit (Plate) travaille sur un ARBRE, pas
-- sur du HTML, et refaire l'aller-retour arbre → HTML → arbre à chaque
-- ouverture perd tout ce que le HTML ne sait pas porter : l'état d'une case à
-- cocher, la largeur d'une colonne de tableau, un bloc de code replié.
--
-- D'où deux colonnes qui ne se concurrencent pas : `description_rich` est la
-- SOURCE (ce que l'éditeur relit), `description_html` en est le rendu (ce que
-- lisent la recherche et les exports).

alter table public.pj_pages
  add column if not exists description_rich jsonb;

comment on column public.pj_pages.description_rich is
  'La source de l''éditeur (arbre Plate). `description_html` en est le rendu : il sert aux exports et à la recherche, jamais à recharger l''éditeur.';

-- Même chose pour la description d'un work item, qui utilise le même éditeur.
alter table public.pj_issues
  add column if not exists description_rich jsonb;
