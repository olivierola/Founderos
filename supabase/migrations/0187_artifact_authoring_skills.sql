-- 0187_artifact_authoring_skills.sql
-- Editor.js becomes the only artifact format, so the skill that taught the old
-- one has to go with it.
--
-- `report-designer` described a bespoke JSON shape ({title, summary, sections})
-- and, in places, markdown — both formats no longer exist. Renamed rather than
-- edited: an agent that half-remembers "report-designer" would keep reaching for
-- create_deliverable and report_section, which are retired. New slugs force a
-- clean read.
--
--   report-authoring   a scrolling document
--   deck-authoring     the same blocks, cut into slides
--
-- Both write through add_block / publish_artifact and share one block
-- catalogue, kept in blocks.md so the two skills cannot drift apart.

-- ── Retire the old skill (activations follow the rename) ────────────────────
update public.agent_skills
set slug = 'report-authoring',
    name = 'Report authoring',
    description = 'Rédiger un rapport : un document JSON de blocs (KPI, graphiques, tableaux, matrices, images) rendu par l''application.',
    system_prompt_extension = $DOC$Tu produis des RAPPORTS : un document composé de BLOCS, écrit en JSON, rendu par l'application avec de vrais composants.

LE SEUL FORMAT. Il n'existe ni markdown, ni tableur, ni document texte. Tout ce que tu rédiges — analyse, veille, audit, bilan, compte rendu, note — est un rapport construit bloc par bloc.

COMMENT ÉCRIRE
1. Rassemble d'abord les faits avec tes outils. Relis ce que tu as déjà trouvé avec recall_findings plutôt que de rechercher deux fois.
2. Charge le catalogue quand tu en as besoin : read_skill_file(slug="report-authoring", path="blocks.md") pour la forme exacte de chaque bloc, "principles.md" pour la structure d'un document qui se lit.
3. Écris avec add_block(target="report", block={type, data}) — UN APPEL PAR BLOC, dans l'ordre de lecture. Appelle-le dès que tu as les faits d'une partie : le fil est compacté au fil du run, un chiffre non écrit dans un bloc est un chiffre perdu.
4. Termine par publish_artifact(target="report", title="…"), puis résume en deux phrases. Le document s'ouvre en carte.

LES CHIFFRES VONT DANS LES BLOCS, pas dans les phrases : un chiffre devient un kpi, une série de chart, une ligne de table, un point de matrix. Les paragraphes portent l'interprétation — pourquoi ce chiffre compte. Un bloc n'est pas un quota : une section de prose est légitime quand il n'y a rien à tracer.

TOUJOURS : ouvrir sur un banner puis une rangée de kpi ; refermer sur un callout portant la recommandation. Ne termine jamais sur un résumé de ce que tu as fait — termine sur ce qu'il faut faire.$DOC$
where workspace_id is null and slug = 'report-designer';

-- ── The deck skill (new row; clone the report one's activation model) ───────
insert into public.agent_skills (workspace_id, slug, name, description, system_prompt_extension, category, is_system)
select null, 'deck-authoring', 'Deck authoring',
  'Construire une présentation : les mêmes blocs qu''un rapport, découpés en slides.',
  $DOC$Tu produis des PRÉSENTATIONS. Une présentation n'est pas un autre format : ce sont les mêmes blocs qu'un rapport, découpés en pages par des blocs {type:"slide"}.

COMMENT ÉCRIRE
1. add_block(target="presentation", block={type:"slide", data:{title:"…"}}) ouvre une page.
2. Les blocs suivants remplissent cette page, jusqu'au prochain bloc slide.
3. publish_artifact(target="presentation", title="…") publie.

RÈGLES DE SLIDE : une idée par page. Un titre court, deux ou trois blocs au plus. Un chiffre isolé est un bloc kpi, pas une phrase. Une comparaison est un bloc comparison, jamais une liste à puces. Une page dense est une page ratée — coupe-la en deux.

Le catalogue des blocs est partagé avec le rapport : read_skill_file(slug="report-authoring", path="blocks.md").$DOC$,
  'productivity', true
where not exists (select 1 from public.agent_skills where workspace_id is null and slug = 'deck-authoring');

-- ── Playbooks ───────────────────────────────────────────────────────────────
delete from public.agent_skill_files f
using public.agent_skills s
where s.id = f.skill_id and s.workspace_id is null and s.slug = 'report-authoring'
  and f.path in ('schema.md', 'example.md', 'chart-selection.md');

insert into public.agent_skill_files (skill_id, path, content, sort)
select s.id, v.path, v.content, v.sort
from public.agent_skills s
cross join (values
  ('blocks.md', $DOC$# Le catalogue des blocs

Un bloc est `{ "type": "...", "data": { ... } }`. Choisis celui dont la FORME
correspond à ce que tu dis.

## Texte
- `header` `{text, level:1-4}` — un titre de partie.
- `paragraph` `{text}` — l'interprétation, pas la donnée.
- `list` `{style:"ordered"|"unordered", items:["…"]}`
- `checklist` `{items:[{text, checked}]}`
- `quote` `{text, caption?}` · `code` `{code}` · `delimiter` `{}`

Le texte accepte du HTML inline restreint : `<b> <i> <code> <a href> <mark>`.

## Chiffres
- `kpi` `{items:[{label, value, delta?, trend:"up"|"down"|"flat"}]}`
  Trois à six, en tête du document. Les chiffres qu'un lecteur doit emporter.
- `chart` `{chartType, title?, x, series:[], data:[{...}], stacked?}`
  bar (comparer) · line (dans le temps) · area (cumul) · donut/pie (composition)
  · radar (scores multi-axes) · scatter (corrélation).
- `table` `{withHeadings:true, content:[["Col A","Col B"],["…","…"]]}`
  La première ligne est l'en-tête. Mets la source en colonne plutôt que de la
  répéter dans chaque phrase.

## Analyse
- `comparison` `{title?, columns:["Nous","Rival A"], highlight:0, rows:[{label, note?, cells:[true,"partiel",false]}]}`
  Pour « X contre Y contre Z ». Les booléens deviennent de vrais ✓/✕ et
  `highlight` teinte notre colonne. À préférer TOUJOURS à un tableau bricolé.
- `matrix` `{xLabel, yLabel, xLow?, xHigh?, yLow?, yHigh?, quadrants:[4 noms], items:[{label, x:0-100, y:0-100, note?, highlight?}]}`
  La carte de positionnement. Origine en bas à gauche. Aucun graphe ne la
  remplace : un scatter n'a pas de quadrants nommés.

## Mise en avant
- `banner` `{title, subtitle?, author?, tone?, imageUrl?}` — la couverture.
- `callout` `{tone:"info"|"success"|"warning"|"danger", text}` — le risque ou le
  gain principal. Un par document, à la fin.
- `image` `{file:{url}, caption?}` — l'URL doit pointer DIRECTEMENT sur le
  fichier image, jamais sur la page qui le contient. Toujours une légende.

## Découpage
- `slide` `{title?, layout?}` — ouvre une page dans une présentation. Sans
  aucun bloc slide, le document est un rapport défilant.$DOC$, 1),

  ('principles.md', $DOC$# Écrire un document qui se lit

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

## Analyser, pas inventorier
« Rival A facture 99 $/siège » est une donnée. « Les 99 $/siège de Rival A les
sortent du segment PME que nous occupons, ce qui explique que leurs logos
publics soient tous grands comptes » est une analyse. Le document est jugé sur
la seconde.

## Honnêteté
Chaque chiffre porte sa source et sa date. Un chiffre introuvable s'écrit « non
publié » — jamais estimé, jamais arrondi à l'existence. Un lecteur qui prend un
chiffre inventé en défaut cesse de croire tout le reste.$DOC$, 2)
) as v(path, content, sort)
where s.workspace_id is null and s.slug = 'report-authoring'
on conflict (skill_id, path) do update
  set content = excluded.content, sort = excluded.sort, updated_at = now();

-- ── Clean break: the old artifacts cannot be rendered by the new pipeline ───
delete from public.internal_agent_deliverables
where kind not in ('report', 'presentation')
   or content is null
   or content not like '%"blocks"%';
