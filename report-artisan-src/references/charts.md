# Graphiques

Un graphique est **lu par des gens** et **exécuté par toi**. Ce qui suit
transforme « fais joli » en décisions vérifiables.

## 1. Choisir la forme d'abord

La question n'est pas « quel graphique ? » mais « quel est le travail de cette
donnée ? ».

| Travail | Forme | Pourquoi |
|---|---|---|
| Comparer des catégories | `bar` | La longueur depuis une base commune est ce que l'œil compare le mieux. |
| Classer, libellés longs | `hbar` | Les libellés se lisent horizontalement, sans rotation. |
| Évolution dans le temps | `line` | La pente est le message. |
| Évolution + volume | `area` | Une seule série ; deux aires superposées deviennent illisibles. |
| Composition qui évolue | `stackedBar` | Ajoute `percent: true` si seule la part compte. |
| Répartition d'un tout | `donut` | 3 à 6 parts. Au-delà, un `hbar` est plus lisible. |
| Un seul chiffre | *pas un graphique* | Une tuile `kpis`. |

Si tu hésites entre deux formes, c'est souvent que le graphique essaie de dire
deux choses. Fais-en deux.

## 2. Les règles non négociables

**Un seul axe de valeurs.** Jamais deux échelles verticales dans un même
graphique — c'est l'erreur la plus fréquente et la plus trompeuse. Deux mesures
d'ordres de grandeur différents → deux graphiques, ou une indexation base 100.

**La couleur suit l'entité, jamais le rang.** « Avant » garde sa couleur d'un
graphique à l'autre. Un `hbar` trié du plus grand au plus petit reçoit un aplat
unique (le comportement par défaut) : colorier chaque barre différemment
suggère une identité qui n'existe pas.

**Légende dès deux séries.** Une série unique n'en a pas besoin — le titre la
nomme, et le moteur la peint dans la couleur d'accent du rapport.

**Huit séries maximum**, et en pratique quatre. Au-delà, regroupe la queue en
« Autres » ou fais des petits multiples. Le build refuse plus de huit.

**Pas de valeur sur chaque point.** Étiqueter tout revient à n'étiqueter rien.
Le moteur étiquette le dernier point d'une courbe ; `showValues: true` sur un
`bar` ne se justifie que si les valeurs exactes sont le sujet.

## 3. Montrer le seuil

Un rapport de pilotage tourne presque toujours autour d'une valeur de référence :
une cible de marge, un SLA, un budget, un seuil d'alerte. Un lecteur qui doit
faire la comparaison de tête la fait mal.

```jsonc
"target": 32                                   // trait pointillé + « cible 32 % »
"target": { "value": 32, "label": "cible marge" }
```

Le moteur étend l'échelle si la cible sort du domaine des données, réserve une
gouttière à droite pour le libellé, et dessine le trait au-dessus de la grille
mais sous les marques. Disponible sur `bar`, `hbar`, `line`, `area`,
`stackedBar`.

Une seule ligne de référence par graphique. Deux seuils sur un même tracé, c'est
deux graphiques ou un tableau.

## 4. Régler les nombres

`valueFormat` s'applique aux axes, aux étiquettes et aux infobulles :

```jsonc
{ "suffix": " %" }                    // 31 %
{ "prefix": "€", "decimals": 0 }      // €1 240
{ "compact": true }                   // 1,2 k  ·  3,4 M
{ "suffix": " j", "decimals": 1 }     // 4,5 j
```

Le séparateur et la virgule décimale suivent `locale` (`fr-FR` par défaut).

Pour les axes de temps longs (12 mois, 52 semaines), le moteur n'affiche qu'une
étiquette sur N pour éviter le chevauchement — n'essaie pas de raccourcir les
libellés toi-même, écris-les en clair.

## 5. La légende de lecture (`caption`)

C'est le champ le plus important et le plus souvent bâclé.

Mauvais : « Évolution des inscriptions par semaine. » — le titre le dit déjà.
Bon : « L'inflexion de la semaine 21 correspond à la mise en production de la
file d'envoi dédiée. »

Une bonne légende désigne **ce qu'il faut voir** : un point d'inflexion, une
exception, une limite méthodologique, un ordre de grandeur. Si tu n'as rien à
dire de plus que le titre, le graphique ne mérite peut-être pas sa place.

## 6. Ce que le moteur fait déjà pour toi

- palette catégorielle validée pour les daltonismes courants, avec une variante
  propre au mode sombre (pas un simple inversement) ;
- infobulle au survol sur toutes les formes, plus un `<title>` natif qui
  fonctionne même sans JavaScript ;
- grille et axes discrets, marques fines, coins arrondis côté valeur,
  espacement de 2 px entre segments empilés ;
- le texte reste en encre neutre : jamais un libellé coloré à la couleur de sa
  série, c'est la pastille qui porte l'identité.

Tu n'as donc rien à régler côté couleur. Concentre-toi sur la forme, l'échelle
et la légende.

## 7. Après le rendu, regarde

Le validateur contrôle la structure, pas la géométrie. Ouvre le fichier (ou
capture-le) et vérifie :

- des étiquettes d'axe qui se chevauchent → moins de catégories, ou `hbar` ;
- un titre de graphique qui passe à la ligne bizarrement → raccourcis-le, le
  contexte va dans `subtitle` ;
- une aire qui écrase une variation réelle → l'échelle démarre peut-être à zéro
  alors que la variation est de 2 % ; passe en `line` avec `"zero": false` ;
- un donut dont deux parts font 1 % → regroupe-les ;
- des étiquettes de fin de courbe superposées → le moteur en supprime une quand
  deux séries finissent à moins de 7 % d'écart, mais trois séries serrées
  restent illisibles : augmente `height`, ou passe la série de contexte en
  `labelLast: false` ;
- des libellés `hbar` coupés → ils dépassent 34 caractères ; raccourcis-les et
  mets le détail dans la `caption`.

Une remarque d'outillage : si `playwright` est disponible (souvent le cas),
ouvre le fichier en Chromium headless et prends une capture pleine page. C'est
le seul moyen fiable de voir un chevauchement. Écris les captures dans un
dossier propre à ton exécution — pas dans `/tmp/shot.png`, que d'autres
processus écrasent.
