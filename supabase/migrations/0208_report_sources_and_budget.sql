-- 0208_report_sources_and_budget.sql
--
-- Deux choses qu'un rapport doit porter et que le skill ne disait pas.
--
-- 1. LES SOURCES SONT DES OBJETS, PAS DU TEXTE.
--    Jusqu'ici une source finissait dans une cellule de méta : « Sources :
--    Stack Overflow, McKinsey, BLS ». Un lecteur qui veut vérifier un chiffre
--    n'a alors rien à cliquer, et rien ne dit QUEL passage s'appuie sur QUOI.
--    Le moteur (0209) sait désormais afficher une source comme une marque : le
--    logo du site, récupéré à la construction et intégré au fichier, qui se
--    déplie au survol en une pastille nommée et cliquable. Les sources se
--    déclarent une fois à la racine et se citent par leur nom, dans un bloc
--    `sources` posé juste après le passage qu'elles appuient.
--
-- 2. UN RAPPORT RÉPOND À UN TRAVAIL.
--    Le plafond (deux au maximum) est appliqué par l'outil request_report ;
--    la règle est écrite ici pour que le Rédacteur la porte aussi — il n'écrit
--    pas trois documents là où la matière en fait un.

update public.agent_skills
set system_prompt_extension = replace(
      system_prompt_extension,
      '4. report_add_block(block) une fois par bloc, dans l''ordre de lecture. Le schéma exact de chaque bloc : read_skill_file(slug="report-artisan", path="content-schema.md").',
      '4. report_add_block(block) une fois par bloc, dans l''ordre de lecture. Le schéma exact de chaque bloc : read_skill_file(slug="report-artisan", path="content-schema.md").'
      || E'\n' ||
      'CITER : chaque source consultée se déclare dans report_open (nom lisible + URL EXACTE de la page, pas la racine du site) ; son logo est récupéré et intégré au fichier. Dans le corps, un bloc {"type":"sources","data":{"items":["Nom A","Nom B"]}} posé JUSTE APRÈS un passage dit sur quoi ce passage repose. Cite ce qui porte un chiffre ou une affirmation contestable — pas chaque paragraphe.')
where workspace_id is null and slug = 'report-artisan'
  and system_prompt_extension not like '%CITER :%';

update public.agent_skills
set system_prompt_extension = system_prompt_extension || $DOC$

UN SEUL DOCUMENT. Toute la matière qu'on t'a passée tient dans UN rapport : c'est le travail de synthèse qu'on attend de toi. N'ouvre pas un second document parce que le sujet a deux faces — une partie, c'est un header ; un écart entre deux sources, c'est un paragraphe qui tranche. Deux rapports sont un maximum, et seulement quand les sujets n'ont vraiment rien à se dire.$DOC$
where workspace_id is null and slug = 'report-artisan'
  and system_prompt_extension not like '%UN SEUL DOCUMENT%';

-- Les autres agents : ils rassemblent, ils ne multiplient pas les livrables.
-- (Le plafond dur est dans request_report ; la présentation est refusée par
-- add_block/publish_artifact quand personne n'en a demandé.)
update public.agent_skills
set system_prompt_extension = system_prompt_extension || $DOC$

NE PRODUIS PAS DE PRÉSENTATION SPONTANÉMENT. Une présentation ne se fabrique que si l'utilisateur en a demandé une, dans sa requête ou dans l'ordre de mission. Sinon, ce qui se livre est un rapport.$DOC$
where workspace_id is null and slug = 'deck-authoring'
  and system_prompt_extension not like '%SPONTANÉMENT%';
