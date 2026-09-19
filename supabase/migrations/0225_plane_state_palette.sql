-- 0225_plane_state_palette.sql
-- Aligne les couleurs d'état sur celles de Plane.
--
-- 0221 avait semé des teintes « évidentes » : gris, bleu, ambre, vert, rouge.
-- Ce n'est pas ce que fait Plane, et l'écart n'est pas un détail de goût.
--
-- Chez Plane, backlog et « à faire » sont deux GRIS, séparés d'un cran de
-- luminosité, et « annulé » est gris lui aussi. Seuls « en cours » et
-- « terminé » portent une vraie teinte. La raison tient au board : sur cent
-- lignes dont les deux tiers n'ont pas commencé, donner une couleur franche à
-- ces deux tiers noie précisément les deux états qui appellent une action. Le
-- rouge sur « annulé » est le pire des cas — il attire l'œil sur ce qui, par
-- définition, ne demande plus rien.

create or replace function public.pj_seed_project_states()
returns trigger language plpgsql as $$
begin
  insert into public.pj_states (pj_project_id, workspace_id, name, color, "group", sequence, is_default)
  values
    (new.id, new.workspace_id, 'Backlog',  '#8b8f99', 'backlog',   15000, false),
    (new.id, new.workspace_id, 'À faire',  '#6b7180', 'unstarted', 25000, true),
    (new.id, new.workspace_id, 'En cours', '#eda100', 'started',   35000, false),
    (new.id, new.workspace_id, 'Terminé',  '#3e9b4f', 'completed', 45000, false),
    (new.id, new.workspace_id, 'Annulé',   '#8c8fa4', 'cancelled', 55000, false)
  on conflict do nothing;
  return new;
end $$;

-- Les projets déjà créés portent les anciennes teintes. On ne les corrige que
-- si elles n'ont PAS été retouchées : un état dont quelqu'un a choisi la
-- couleur exprès ne doit pas être réécrit par une migration.
update public.pj_states set color = '#8b8f99' where "group" = 'backlog'   and color = '#a3a3a3';
update public.pj_states set color = '#6b7180' where "group" = 'unstarted' and color = '#3b82f6';
update public.pj_states set color = '#eda100' where "group" = 'started'   and color = '#f59e0b';
update public.pj_states set color = '#3e9b4f' where "group" = 'completed' and color = '#16a34a';
update public.pj_states set color = '#8c8fa4' where "group" = 'cancelled' and color = '#ef4444';

comment on function public.pj_seed_project_states is
  'États par défaut, palette Plane : backlog/à faire/annulé restent gris pour que seuls « en cours » et « terminé » attirent l''œil.';
