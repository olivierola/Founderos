-- 0192_editorjs_block_shapes.sql
-- Opening a report emptied it. The cause is not the editor: it is the shape of
-- the blocks the agent writes.
--
-- The document IS an Editor.js document. Each block is handed to the Editor.js
-- tool that owns its `type`, and a tool given data it does not recognise renders
-- an empty node — which Editor.js then reads as an empty block and drops. A list
-- whose items are objects instead of strings, a table whose rows are uneven, a
-- slide with no title: each of those renders blank and is deleted the first time
-- a human opens the document.
--
-- add_block now refuses a malformed block at write time (checkBlockShape). This
-- migration teaches the shapes, so the agent gets them right instead of learning
-- them one rejection at a time.

update public.agent_skills
set system_prompt_extension = system_prompt_extension || $DOC$

LA FORME DES BLOCS EST IMPOSÉE
Le document est un document Editor.js. Chaque bloc est confié à l'outil qui porte son `type`, et un outil qui reçoit une forme qu'il ne reconnaît pas n'affiche RIEN — le bloc est alors considéré comme vide et supprimé. Une liste dont les items sont des objets, un tableau aux lignes inégales, une slide sans titre : chacun disparaît silencieusement.

Les formes exactes :
- header {text, level:1|2|3|4} — le niveau est un ENTIER, pas des dièses dans le texte
- paragraph {text}
- list {style:"ordered"|"unordered", items:["texte","texte"]} — items = des CHAÎNES
- checklist {items:[{text, checked}]}
- table {withHeadings:true, content:[["En-tête A","En-tête B"],["cellule","cellule"]]} — content = tableau de LIGNES, chaque ligne un tableau de cellules de MÊME longueur, la première étant l'en-tête
- quote {text, caption, alignment:"left"} · code {code} · delimiter {}
- image {file:{url:"https://…"}, caption}
- kpi {items:[{label,value,delta?,trend}]} · chart {chartType, x, series:[], data:[{…}]}
- comparison {columns:[], rows:[{label, cells:[…]}]} — autant de cells que de columns
- matrix {items:[{label, x:0-100, y:0-100}]} — x et y NUMÉRIQUES
- banner {title} · callout {tone, text} · slide {title}

JAMAIS DE MARKDOWN DANS UN CHAMP TEXTE. Ni « # », ni « ** », ni « | », ni « - » en début de ligne. La structure est portée par le TYPE du bloc : un titre est un header, une liste est un list, un tableau est un table. Du markdown dans un paragraph s'affiche tel quel, dièses compris.

Un bloc sans contenu est refusé : pas de liste vide, pas de table sans lignes, pas de chart sans data.$DOC$
where workspace_id is null and slug in ('report-authoring', 'deck-authoring');

update public.agent_skill_files f
set content = $DOC$# Le catalogue des blocs

Le document est un document Editor.js. Un bloc est `{"type": "...", "data": {...}}`
et `data` doit avoir **exactement** la forme que son outil attend : un outil qui
reçoit autre chose n'affiche rien, et un bloc qui n'affiche rien est supprimé à
la première ouverture du document.

## Texte

```json
{"type":"header","data":{"text":"Ce que montrent les chiffres","level":2}}
{"type":"paragraph","data":{"text":"Le marché se concentre : trois acteurs captent 71 % des revenus."}}
{"type":"list","data":{"style":"unordered","items":["Premier point","Deuxième point"]}}
{"type":"checklist","data":{"items":[{"text":"Vérifié auprès de la source","checked":true}]}}
{"type":"quote","data":{"text":"…","caption":"Rapport annuel 2025","alignment":"left"}}
{"type":"code","data":{"code":"SELECT 1;"}}
{"type":"delimiter","data":{}}
```

`level` est un entier de 1 à 4. `items` d'une `list` sont des **chaînes** — pas
des objets `{text: …}`. Le texte accepte seulement `<b> <i> <code> <a href>
<mark>` : aucun markdown, jamais.

## Données

```json
{"type":"table","data":{"withHeadings":true,"content":[
  ["Acteur","Part de marché","Source"],
  ["Rival A","31 %","IDC, mars 2026"],
  ["Rival B","24 %","IDC, mars 2026"]]}}
```

`content` est un tableau de **lignes**, chaque ligne un tableau de cellules de
même longueur. La première ligne est l'en-tête. Une ligne plus courte que
l'en-tête casse le tableau entier.

```json
{"type":"kpi","data":{"items":[
  {"label":"Marché 2026","value":"4,4 T$","delta":"+18 %","trend":"up"},
  {"label":"Acteurs > 1 Md$","value":7}]}}

{"type":"chart","data":{"chartType":"bar","title":"Revenus par segment (2026, IDC)",
  "x":"segment","series":["revenus"],
  "data":[{"segment":"Infrastructure","revenus":142},{"segment":"Modèles","revenus":88}]}}
```

`x` nomme la clé de catégorie, `series` les clés à tracer, et chaque objet de
`data` porte ces clés. Types : `bar`, `line`, `area`, `pie`, `donut`, `radar`,
`scatter`.

## Analyse

```json
{"type":"comparison","data":{"columns":["Nous","Rival A","Rival B"],"highlight":0,
  "rows":[{"label":"Tarif par siège","note":"liste publique","cells":["29 $","99 $","non publié"]},
          {"label":"SSO inclus","cells":[true,true,false]}]}}

{"type":"matrix","data":{"xLabel":"Prix","yLabel":"Couverture fonctionnelle",
  "quadrants":["Niche","Leaders","Généralistes","Entrée de gamme"],
  "items":[{"label":"Rival A","x":85,"y":72,"note":"grands comptes"}]}}
```

Autant de `cells` que de `columns`. Les `x` et `y` d'une matrice sont des
**nombres** de 0 à 100.

## Mise en avant

```json
{"type":"banner","data":{"title":"Marchés affectés par l'IA","subtitle":"Analyse — août 2026"}}
{"type":"callout","data":{"tone":"warning","text":"Les deux estimations divergent d'un facteur trois ; nous retenons celle d'IDC, la seule méthodologie publiée."}}
```

`tone` : `info`, `success`, `warning`, `danger`.

## Découpage d'une présentation

```json
{"type":"slide","data":{"title":"Ce que nous recommandons"}}
```

Le titre est obligatoire — une slide sans titre est un bloc vide, et un bloc vide
disparaît. Le bloc n'existe que dans une présentation ; dans un rapport, une
partie s'ouvre par un `header`.$DOC$,
    updated_at = now()
from public.agent_skills s
where s.id = f.skill_id
  and s.workspace_id is null and s.slug in ('report-authoring', 'deck-authoring')
  and f.path = 'blocks.md';
