# Galerie — bannières, accents, pictogrammes

Tout est **procédural** : les bannières sont dessinées en SVG à partir de la
couleur d'accent et du thème. Changer `accent` ou basculer en mode sombre
redessine la galerie entière, de façon cohérente. Aucun fichier image, aucune
requête réseau, aucun droit d'auteur à gérer.

## Bannières

| Style | Allure | Va bien avec |
|---|---|---|
| `aurora` | nappes floues qui se croisent | par défaut ; stratégie, bilan, produit |
| `glow` | une lueur douce, très épuré | rapport sobre, note de direction |
| `waves` | vagues superposées | croissance, progression, cycles |
| `ribbon` | rubans souples qui traversent | parcours, flux, transformation |
| `arcs` | cercles concentriques décentrés | portée, cible, périmètre |
| `grid` | grille en perspective | technique, infrastructure |
| `topo` | courbes de niveau | analyse, exploration, cartographie |
| `dots` | trame de points en dégradé | données, échantillon, enquête |
| `prism` | éclats translucides superposés | créatif, marque, lancement |
| `strata` | bandes horizontales dégradées | couches, segments, paliers |
| `bars` | silhouette de barres | reporting chiffré, finance |
| `blueprint` | grille technique fine, fond clair | spécification, audit — utiliser avec `"light": true` |

Une bannière hero en tête, une ou deux bannières de section pour marquer une
bascule dans le récit. Trois ou plus et elles cessent de signifier quoi que ce
soit.

Le `title` d'une bannière est court et affirmatif — c'est une phrase qu'on
retient, pas un intitulé de chapitre. Le `subtitle` peut préciser.

Champ `seed` : deux bannières du même style dans un même rapport se ressemblent
(le tirage est déterministe et dérivé du titre). Donne un `seed` différent si
tu veux varier la composition sans changer de style.

## Accents

| Accent | Registre |
|---|---|
| `blue` | neutre, institutionnel, financier |
| `indigo` | produit, tech, conseil |
| `teal` | santé, environnement, opérations |
| `green` | croissance, durabilité, résultats |
| `amber` | retail, énergie, alerte maîtrisée |
| `rose` | marque, marketing, culture interne |
| `plum` | recherche, création, prospective |
| `slate` | juridique, gouvernance, austère |

Chaque accent a une déclinaison claire et une déclinaison sombre, choisies pour
garder le contraste dans les deux modes. Pour une charte client, remplace les
valeurs dans le bloc `[data-accent="…"]` de `assets/report.css` — c'est le seul
endroit à modifier.

La palette des graphiques est **indépendante** de l'accent : elle est validée
pour rester distinguable en cas de daltonisme, et ne change pas quand tu changes
d'accent. C'est voulu — un rapport rose ne doit pas rendre ses graphiques
illisibles.

## Pictogrammes

Disponibles pour `callout.icon` (l'icône par défaut découle du `tone`) :

`info` · `check` · `alert` · `stop` · `bulb` · `target` · `trendUp` ·
`trendDown` · `arrowUp` · `arrowDown` · `minus` · `clock` · `users` · `euro` ·
`chart` · `doc` · `flag` · `lock` · `globe` · `spark` · `layers` · `calendar` ·
`search` · `building`

Trait de 1,75 px sur une grille de 24 : ils s'accordent au texte sans le
concurrencer. N'en mets pas ailleurs que dans les encadrés — un pictogramme par
titre de section transforme un rapport en présentation.

## Typographie

`editorial` (défaut) : titres en Instrument Serif, texte en Inter. Chaleureux,
mémorable, adapté à un livrable qu'on lit.
`modern` : tout en Inter, resserré. Neutre, adapté à un reporting récurrent ou
à une charte déjà très sans-serif.

Les polices viennent de Google Fonts avec repli sur les polices système : hors
ligne, le document reste correct, simplement moins caractérisé.
