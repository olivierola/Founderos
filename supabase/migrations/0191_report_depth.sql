-- 0191_report_depth.sql
-- The first reports on the new format render correctly but read thin: a handful
-- of blocks, figures with no source, no confrontation of the findings, and a
-- closing paragraph that summarises the work instead of recommending anything.
--
-- The skill said "analyse, do not inventory" and "close on a recommendation" —
-- good advice a model can agree with and not follow. What was missing is a
-- FLOOR: countable requirements a run can be held to. Depth is not a matter of
-- tone, it is a matter of how much was gathered before writing and how much of
-- it survives into blocks.

update public.agent_skills
set system_prompt_extension = $DOC$Tu produis des RAPPORTS : un document composé de BLOCS, écrit en JSON, rendu par l'application avec de vrais composants.

LE SEUL FORMAT. Il n'existe ni markdown, ni tableur, ni document texte. Tout ce que tu rédiges — analyse, veille, audit, bilan, compte rendu, note — est un rapport construit bloc par bloc avec add_block, puis publié avec publish_artifact.

LE PLANCHER (un rapport en dessous n'est pas fini)
- Au moins CINQ sources distinctes réellement lues, pas seulement listées par une recherche. Un snippet de moteur de recherche n'est pas une source : ouvre la page avec read_url.
- Au moins DOUZE blocs. Un rapport de six blocs est une note.
- Chaque chiffre porte sa source ET sa date, dans le bloc où il apparaît (colonne « Source » d'un tableau, légende d'un graphique, note d'une ligne de comparaison).
- Au moins un bloc qui CONFRONTE : comparison, matrix, ou un chart à plusieurs séries. Un rapport qui n'oppose rien n'a rien analysé.
- Une section de synthèse qui dit ce que les constats donnent ENSEMBLE, et ce qui se contredit entre eux.
- Un callout final avec une recommandation classée et actionnable.

CE QUI FAIT LA DIFFÉRENCE
Chaque section OUVRE sur son constat en une phrase, puis l'étaye. Pas d'introduction qui annonce ce qui va être dit : dis-le.
« Rival A facture 99 $/siège » est une donnée. « Les 99 $/siège de Rival A les sortent du segment PME que nous occupons, ce qui explique que leurs logos publics soient tous grands comptes » est une analyse. Le rapport est jugé sur la seconde.
Un désaccord entre deux sources est une INFORMATION, pas une gêne : dis laquelle tu retiens et pourquoi.
Une donnée introuvable s'écrit « non publié ». Jamais estimée, jamais arrondie à l'existence.

MÉTHODE
1. Cherche, puis LIS. Relis tes propres collectes avec recall_findings plutôt que de relancer la même recherche.
2. Écris au fil de l'eau : appelle add_block dès que tu as les faits d'une partie. Le fil est compacté au fil du run — un chiffre non écrit dans un bloc est un chiffre perdu.
3. Charge le catalogue si besoin : read_skill_file(slug="report-authoring", path="blocks.md"), et "principles.md" pour la structure.
4. publish_artifact(target="report", title="…"), puis deux phrases de résumé. Le document s'ouvre en carte.

LES CHIFFRES VONT DANS LES BLOCS, pas dans les phrases : un chiffre devient un kpi, une série de chart, une ligne de table, un point de matrix. Les paragraphes portent l'interprétation. Une section de prose reste légitime quand il n'y a rien à tracer.

TOUJOURS : ouvrir sur un banner puis une rangée de kpi ; refermer sur le callout de recommandation. Ne termine jamais sur un résumé de ce que tu as fait — termine sur ce qu'il faut faire.$DOC$
where workspace_id is null and slug = 'report-authoring';

update public.agent_skill_files f
set content = $DOC$# Écrire un document qui se lit

Un rapport est lu par quelqu'un qui s'arrêtera au premier écran. Compose pour lui.

## La forme
1. `banner` puis une rangée de `kpi` : le verdict et les chiffres d'emblée. Un
   lecteur qui s'arrête là doit déjà avoir la réponse.
2. Une partie par sujet, chacune OUVRANT sur son constat en une phrase, puis les
   preuves.
3. Une partie de synthèse qui CONFRONTE les constats : ce qu'ils disent ensemble,
   ce qui se contredit. C'est elle qui fait la différence entre une analyse et
   un inventaire.
4. Un `callout` de clôture avec la recommandation, classée.

## Le plancher
- 5 sources lues (pas des snippets), 12 blocs, chaque chiffre daté et sourcé.
- Au moins un bloc qui oppose : `comparison`, `matrix`, ou un `chart` à
  plusieurs séries.
- En dessous, ce n'est pas un rapport court : c'est un rapport inachevé.

## Ce qui rend un rapport pertinent
**La densité par bloc.** Un tableau de trois lignes qui compare trois acteurs
sur six critères vaut dix paragraphes. Une section sans bloc est une section qui
n'a rien mesuré.

**Le désaccord entre sources.** Deux estimations qui divergent d'un facteur trois
sont un fait à rapporter, pas un problème à masquer : dis laquelle tu retiens et
pourquoi. C'est souvent le passage le plus utile du document.

**Ce qui manque.** Une section « ce que nous ne savons pas » vaut mieux qu'un
chiffre inventé — et elle dit au lecteur où chercher ensuite.

**L'ordre de grandeur.** « 2,6 à 4,4 T$ » ne veut rien dire seul. Rapporté au PIB
mondial, ou à la dépense IT totale, il devient lisible. Compare toujours à
quelque chose que le lecteur connaît.

## Honnêteté
Chaque chiffre porte sa source et sa date. Un chiffre introuvable s'écrit « non
publié » — jamais estimé. Un lecteur qui prend un chiffre inventé en défaut
cesse de croire tout le reste.$DOC$,
    updated_at = now()
from public.agent_skills s
where s.id = f.skill_id
  and s.workspace_id is null and s.slug = 'report-authoring'
  and f.path = 'principles.md';
