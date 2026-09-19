---
name: report-artisan
description: >-
  Produit des rapports HTML soignés et éditables — bannière, indicateurs,
  graphiques, encadrés, illustrations — à partir d'un simple fichier JSON de
  contenu. Utilise ce skill dès que l'utilisateur demande un rapport, un bilan
  de mission, une synthèse, un compte rendu, un résumé de fin de mission, un
  livrable client, une note d'analyse, un récapitulatif de données ou un
  « document stylisé » — même s'il ne dit pas explicitement « rapport HTML »,
  et même si le contenu semble tenir en quelques paragraphes. Déclenche aussi
  sur : bilan, débrief, executive summary, rapport d'audit, restitution,
  reporting interne, présentation client sous forme de document, « fais-moi un
  beau document avec des graphiques ». N'utilise pas ce skill si le livrable
  demandé est explicitement un .docx, .pptx, .xlsx ou .pdf natif.
---

# Report Artisan

Ce skill fabrique un **fichier HTML unique et autonome** : mise en page
éditoriale, bannières vectorielles, graphiques SVG, indicateurs, encadrés — et
un éditeur Editor.js intégré pour que le destinataire retouche le texte
lui-même. Tout est inliné (CSS, moteur, contenu), donc le fichier s'ouvre hors
ligne, s'envoie par mail et s'imprime en PDF proprement.

Tu écris **un JSON de contenu**. Le script de build s'occupe du reste.

## Le principe

La beauté d'un rapport ne vient pas d'un effet visuel : elle vient de la
hiérarchie. Un lecteur pressé doit comprendre l'essentiel en quinze secondes
(bannière → titre → chapô → indicateurs), et un lecteur attentif doit pouvoir
descendre sans jamais tomber sur un mur de texte. Les blocs visuels servent
cette lecture — ils ne la décorent pas.

Un rapport réussi tient en une phrase qu'on peut dire à voix haute. Trouve
cette phrase avant d'écrire quoi que ce soit : elle devient le titre de la
bannière, et tout le reste la démontre.

## Déroulé

1. **Rassemble la matière d'abord.** Chiffres, sources, contexte. Si des
   données existent (fichiers, recherche web, résultats d'analyse), va les
   chercher avant de penser mise en page.
2. **Décide de l'histoire.** Quelle est la conclusion ? Quels 3–5 faits la
   soutiennent ? Qu'est-ce qui reste ouvert ? C'est le plan du document.
3. **Écris `contenu.json`.** Schéma complet dans
   `references/content-schema.md` — garde-le ouvert pendant la rédaction.
4. **Construis :**
   ```bash
   python3 <skill>/scripts/build_report.py contenu.json -o rapport.html
   ```
   Le script valide avant d'écrire : il refuse un graphique dont les séries ne
   correspondent pas aux catégories, signale un graphique sans légende de
   lecture, etc. Lis les avertissements, ils désignent presque toujours un vrai
   problème de rédaction.
5. **Regarde le résultat.** Le validateur contrôle la structure, pas la mise en
   page : chevauchements d'étiquettes, titre trop long, tuile KPI qui passe à la
   ligne — ça ne se voit qu'à l'œil. Sans affichage, `playwright` est en général
   installé :
   ```bash
   node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});const p=await b.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:2});p.on('pageerror',e=>console.log('ERR',e.message));await p.goto('file://'+process.argv[1]);await p.waitForTimeout(1800);await p.screenshot({path:process.argv[2],fullPage:true});await b.close()})()" "$PWD/rapport.html" "$PWD/apercu.png"
   ```
   Écris la capture dans ton propre dossier de travail, jamais dans un chemin
   partagé comme `/tmp/shot.png`. Puis lis l'image.
6. **Livre le fichier** (`SendUserFile`). Dis en une phrase ce qu'il contient
   et rappelle que le rapport est éditable : le destinataire clique dans le
   texte, modifie, puis « Exporter HTML » pour récupérer une version figée.

Pour un livrable final que personne ne retouchera, ajoute `--static` : le
fichier passe de ~450 Ko à ~90 Ko, n'embarque plus l'éditeur, et perd les
affordances d'édition. C'est ce qu'il faut envoyer à un client quand la version
éditable est réservée à l'usage interne.

À savoir sur la version éditable : le bloc `table` affiche les contrôles
d'Editor.js (une colonne « + » à droite, un « + » sous le tableau). Ce n'est pas
un défaut de mise en page — ils disparaissent en `--static`, à l'impression, et
dans l'export HTML depuis le bouton de la barre d'outils.

## La structure d'un rapport qui se lit

Cet ordre n'est pas obligatoire, mais il fonctionne parce qu'il répond aux
questions dans l'ordre où elles se posent :

| Bloc | Rôle | Question du lecteur |
|---|---|---|
| `heroBanner` | La conclusion, en grand | « De quoi ça parle ? » |
| masthead (`title`, `subtitle`, `meta`) | Identité du document | « C'est pour qui, quand ? » |
| `lead` | Le chapô : la réponse en 3 phrases | « Je continue ou pas ? » |
| `kpis` | 3–4 chiffres qui portent la démonstration | « Ça a marché ? » |
| `header` + prose + `chart` | Le corps : constat → preuve | « Pourquoi ? » |
| `callout` | Ce qu'il ne faut pas rater | « Et alors ? » |
| `table` | Ce qui reste, engagements, planning | « Ensuite ? » |

Alterne les registres. Deux graphiques consécutifs se neutralisent ; un
graphique encadré de prose se lit. Si trois blocs d'affilée sont du texte,
c'est qu'un chiffre attend d'être montré.

## Choisir la forme

**Bannières** (12 styles, redessinés à chaque accent et à chaque thème) :
`aurora`, `glow`, `waves`, `ribbon`, `arcs`, `grid`, `topo`, `dots`, `prism`,
`strata`, `bars`, `blueprint`. Catalogue commenté dans `references/gallery.md`.
En règle générale : `aurora` et `glow` pour un ton posé, `waves` et `ribbon`
pour du mouvement, `grid`, `topo` et `blueprint` pour du technique, `bars`
pour du chiffré. Une bannière hero + une ou deux bannières de section suffisent
— au-delà, elles se banalisent.

**Graphiques** : `bar` (comparer des catégories), `hbar` (classer, libellés
longs), `line` / `area` (évolution dans le temps), `stackedBar` (composition),
`donut` (répartition d'un tout, 3–6 parts). Les règles qui comptent — un seul
axe, jamais de double échelle, couleur par entité et non par rang, légende dès
deux séries — sont détaillées dans `references/charts.md`. Lis-le avant de
composer un graphique un peu ambitieux.

Un chiffre isolé n'est pas un graphique : c'est une tuile `kpis`. Un graphique
à une seule barre non plus.

**Accents** : `blue`, `indigo`, `teal`, `green`, `amber`, `rose`, `plum`,
`slate`. Choisis en fonction du sujet et du client, pas de tes goûts — et
garde le même accent sur toute une série de rapports pour un même client.

**Typographie** : `editorial` (titres en serif, par défaut — chaleureux,
mémorable) ou `modern` (tout en sans, plus neutre, plus « produit »).

## Ce qui fait la différence

**Les légendes de graphique disent ce qu'on voit, pas ce que c'est.**
« Évolution des inscriptions » ne sert à rien : le titre le dit déjà. Écris
« L'inflexion de la semaine 21 correspond à la mise en production de la file
d'envoi dédiée. » Le champ `caption` est là pour ça, et il porte souvent
l'information la plus utile du rapport.

**Les textes de tuile sont courts.** Une tuile KPI fait ~170 px : « vs janvier »
tient, « vs la cohorte d'inscrits de janvier » passe à la ligne et déséquilibre
la rangée. Le validateur signale les dépassements.

**Un seuil se montre, il ne se raconte pas.** Si le rapport tourne autour d'une
cible (marge, SLA, budget), mets-la dans le graphique avec `target` plutôt que
dans la légende — voir `references/charts.md`.

**Les indicateurs portent une variation.** Un chiffre sans point de comparaison
ne dit rien. Utilise `delta` (pourcentage) ou `deltaLabel` (texte libre, pour
les points de pourcentage ou les valeurs absolues), et `good` pour dire si la
variation est une bonne nouvelle — une baisse du taux d'abandon est verte, une
baisse du chiffre d'affaires ne l'est pas.

**Les encadrés sont rares.** Un `callout` par section au maximum, sinon le
lecteur cesse de les voir. `critical` pour une cause racine ou un risque,
`warn` pour une réserve, `good` pour un résultat acquis, `idea` pour une
recommandation, `info` pour du contexte.

**Le HTML inline est autorisé** dans les champs de texte (`<b>`, `<i>`, `<a>`,
`<mark>`). Mets en gras le chiffre qui compte dans une phrase, pas la phrase
entière.

**Écris en français si l'utilisateur écrit en français.** Le moteur formate les
nombres selon `locale` (`fr-FR` par défaut) : espaces d'espacement des
milliers, virgule décimale.

## Illustrations et photos

Le bloc `figure` accepte n'importe quelle URL d'image ou data-URI, et retombe
sur un aplat dégradé si l'image ne charge pas. Deux mises en garde :

- une URL externe (Unsplash et consorts) ne s'affichera pas si le fichier est
  publié comme artifact, ni hors ligne. Pour un livrable, préfère une image
  encodée en data-URI, une illustration SVG, ou une bannière procédurale ;
- une photo décorative sans rapport avec le propos affaiblit un rapport
  professionnel. Si l'image n'apporte pas d'information, une bannière fait
  mieux le travail.

Les 24 pictogrammes intégrés (`references/gallery.md`) servent les encadrés et
les tuiles ; ils n'ont pas besoin d'être déclarés.

## Fichiers du skill

| Chemin | Contenu |
|---|---|
| `scripts/build_report.py` | Build + validation. `--static`, `--check`. |
| `references/content-schema.md` | **Le schéma JSON complet, bloc par bloc.** |
| `references/charts.md` | Choisir et régler un graphique. |
| `references/gallery.md` | Bannières, accents, pictogrammes. |
| `assets/` | CSS, moteur JS, gabarit HTML. Ne pas éditer par rapport. |

Pour adapter la charte à un client (couleurs de marque, autre police), modifie
les jetons en tête de `assets/report.css` — c'est le seul endroit à toucher.
