-- 0243_issue_mark_started_fix.sql
-- Corrige `pj_issue_mark_started` (0242), qui avait deux défauts.
--
-- 1. UNE LIGNE D'ACTIVITÉ EN DOUBLE. La fonction insérait elle-même dans
--    `pj_issue_activity`, alors que le déclencheur `trg_pj_issues_journal`
--    (0222) journalise DÉJÀ tout UPDATE de `pj_issues`, libellés traduits. Chaque
--    démarrage d'agent laissait donc deux lignes pour un seul changement d'état.
--
-- 2. UN FILET QUI ANNULAIT CE QU'IL DEVAIT PROTÉGER. Le bloc
--    `exception when … then null` englobait toute la fonction. Or en plpgsql, un
--    bloc qui attrape une exception s'exécute en sous-transaction : l'exception
--    attrapée ANNULE tout ce que le bloc a fait. Si le journal échouait, le
--    changement d'état était défait avec lui — l'exact contraire du commentaire,
--    qui promettait que « l'état a quand même bougé ».
--
-- La correction supprime les deux à la fois : plus d'insertion manuelle, donc
-- plus rien à protéger par un filet. Le déclencheur écrit la trace, et un
-- échec de la mise à jour remonte au lieu de disparaître en silence.
--
-- Ce que le déclencheur ne sait pas dire, c'est QUI a bougé l'item : il voit un
-- UPDATE, pas un agent. On rattache donc l'agent à la ligne que le déclencheur
-- vient d'écrire — la plus récente de l'item sur le champ `state`.

create or replace function public.pj_issue_mark_started(p_issue uuid, p_agent uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_state   uuid;
  v_moved   int;
begin
  select pj_project_id into v_project from public.pj_issues where id = p_issue;
  if v_project is null then return; end if;

  select s.id into v_state
  from public.pj_states s
  where s.pj_project_id = v_project and s."group" = 'started'
  order by s.sequence asc
  limit 1;

  if v_state is null then return; end if;

  -- On ne descend jamais un état : l'item ne bouge que depuis backlog ou
  -- « à faire ». Déjà en cours, en revue ou terminé, on n'y touche pas.
  update public.pj_issues i
     set state_id = v_state,
         updated_at = now()
   where i.id = p_issue
     and exists (
       select 1 from public.pj_states cur
       where cur.id = i.state_id and cur."group" in ('backlog', 'unstarted')
     );

  get diagnostics v_moved = row_count;
  if v_moved = 0 then return; end if;

  -- L'auteur, sur la ligne que le déclencheur vient d'écrire. Sans lui, le
  -- journal dirait « état → En cours » sans que personne ne sache qu'une
  -- machine s'y est mise, ce qui est justement ce qu'on vient y chercher.
  update public.pj_issue_activity a
     set agent_id = p_agent
   where a.id = (
     select id from public.pj_issue_activity
     where issue_id = p_issue and field = 'state'
     order by created_at desc, id desc
     limit 1
   );
end $$;

comment on function public.pj_issue_mark_started is
  'Passe un work item en « en cours » quand un agent s''y met — jamais en arrière. La trace est écrite par trg_pj_issues_journal ; la fonction y rattache l''agent.';
