# Schéma du contenu d'un rapport

Un rapport = une racine, que tu passes à `report_open`, puis une suite de blocs,
un `report_add_block` par bloc, dans l'ordre de lecture.

La racine — les arguments de `report_open` :

```jsonc
{
  "title":    "Refonte du parcours d'onboarding",   // requis — le <h1>
  "subtitle": "Bilan de mission — six semaines…",   // 1–2 phrases
  "eyebrow":  "Rapport de mission",                 // surtitre court
  "accent":   "indigo",   // blue|indigo|teal|green|amber|rose|plum|slate
  "typeface": "editorial", // editorial (serif) | modern (sans)
  "theme":    "light",     // light | dark  (l'utilisateur peut basculer)
  "locale":   "fr-FR",     // formatage des nombres
  "lang":     "fr",
  "footer":   "Novaris SAS — document interne",
  "meta": {                // affiché sous le sous-titre, ordre conservé
    "Client": "Novaris SAS",
    "Période": "3 juin — 15 juillet 2026",
    "Auteur": "Marco Kamga"
  },
  "sources": [             // déclarées UNE fois, citées partout par leur nom
    { "name": "Stack Overflow", "url": "https://survey.stackoverflow.co/2026/" },
    { "name": "BLS", "url": "https://www.bls.gov/ooh/computer-and-information-technology/" }
  ],
  "heroBanner": {          // optionnel mais recommandé
    "style": "aurora",
    "eyebrow": "Novaris · Produit",
    "title": "Six semaines pour diviser l'abandon par deux",
    "subtitle": "Ce que nous avons changé, ce que ça a produit."
  }
}
```

`blocks` n'est pas un argument : chaque bloc part dans son propre appel à
`report_add_block(block)`. Appelle-le dès que tu as les faits d'une partie — le
fil est compacté au fil du run, un chiffre non écrit dans un bloc est perdu.

Le titre de la bannière et le `title` du document **ne doivent pas être le
même texte** : la bannière porte la conclusion, le titre nomme le document.

---

## Blocs

Chaque bloc : `{ "type": "...", "data": { ... } }`.
Le HTML inline (`<b> <i> <a> <mark> <br>`) est accepté dans tous les champs de
texte courant.

### `lead` — chapô
```json
{ "type": "lead", "data": { "text": "Le tunnel perdait <b>68 %</b> des visiteurs…" } }
```
Trois phrases maximum. Répond à « pourquoi je devrais lire ça ».

### `paragraph`
```json
{ "type": "paragraph", "data": { "text": "Trois frictions expliquent…" } }
```

### `header`
```json
{ "type": "header", "data": { "level": 2, "text": "Ce qui bloquait" } }
```
`level` 2 = section, 3 = sous-section, 4 = étiquette en petites capitales.

### `list`
```json
{ "type": "list", "data": {
  "style": "ordered",
  "items": [
    "Texte simple",
    { "content": "<b>Élément</b> avec sous-liste",
      "items": ["sous-élément"] }
  ] } }
```
`style` : `unordered` (défaut) ou `ordered`. Les chaînes simples sont
converties automatiquement.

### `checklist`
```json
{ "type": "checklist", "data": { "items": [
  { "text": "Livré", "checked": true },
  "À faire"
] } }
```

### `kpis` — tuiles d'indicateurs
```json
{ "type": "kpis", "data": { "items": [
  { "label": "Taux d'abandon", "value": "31", "unit": "%",
    "deltaLabel": "−37 pts", "direction": "down", "good": true,
    "deltaNote": "vs mai", "spark": [68, 61, 52, 44, 37, 31] },
  { "label": "Inscriptions / semaine", "value": "1 240",
    "delta": 84, "good": true, "note": "record sur 18 mois" }
] } }
```
| Champ | Effet |
|---|---|
| `value` | Chaîne : tu contrôles le formatage (`"1 240"`, `"2:40"`, `"4,2 M€"`). |
| `unit` | Suffixe en plus petit, collé à la valeur. |
| `delta` | Nombre → affiché en pourcentage signé. |
| `deltaLabel` | Texte libre, prioritaire sur `delta` (pour « −37 pts », « +12 k€ »). |
| `direction` | `up`/`down`/`flat` — la flèche. Déduit de `delta` si absent. |
| `good` | `true` = vert, `false` = rouge. **Toujours l'indiquer** quand une baisse est une bonne nouvelle. |
| `deltaNote` | Précision grise après la variation (« vs mai »). |
| `note` | Ligne de contexte sous la variation. |
| `spark` | Série de nombres → micro-courbe en bas de tuile. |

**Longueurs.** Une tuile fait environ 170 px. Au-delà, le texte passe à la ligne
et déséquilibre la rangée — le validateur prévient : `label` ~26 caractères,
`deltaLabel` ~14, `deltaNote` ~14, `note` ~34. Écris « vs janvier », pas « vs la
cohorte de janvier ».

3 ou 4 tuiles. Cinq et plus : ce n'est plus un coup d'œil, c'est un tableau.

### `chart`
```json
{ "type": "chart", "data": {
  "type": "bar",
  "title": "Abandons par étape du tunnel",
  "subtitle": "Part des visiteurs entrés dans l'étape qui n'en sortent pas",
  "categories": ["Tarifs", "Création compte", "Vérif. e-mail"],
  "series": [
    { "name": "Avant (mai)",     "data": [22, 31, 24] },
    { "name": "Après (juillet)", "data": [18, 11, 6] }
  ],
  "valueFormat": { "suffix": " %" },
  "caption": "La vérification e-mail concentrait le quart des pertes."
} }
```

| Champ | Détail |
|---|---|
| `type` | `bar`, `hbar`, `line`, `area`, `stackedBar`, `donut`. |
| `categories` | Axe des abscisses (ou libellés de lignes en `hbar`). |
| `series` | `[{name, data[], color?}]`. `data` doit avoir la même longueur que `categories`. |
| `valueFormat` | `{prefix, suffix, decimals, compact}` — `compact: true` → « 1,2 k ». |
| `caption` | Ce que le graphique montre. Voir `charts.md`. |
| `height` | Hauteur du tracé (défaut 300, 280 pour `donut`). |
| `showValues` | `bar` uniquement : valeur au-dessus de chaque barre. |
| `percent` | `stackedBar` : normalise chaque colonne à 100 %. |
| `wide` | `false` = le graphique reste dans la colonne de texte. |
| `colorByCategory` | `hbar` : une couleur par ligne au lieu d'un aplat unique. À n'activer que si les lignes sont des entités que le lecteur suit ailleurs. |
| `target` | Ligne de référence en pointillés : `32` ou `{"value": 32, "label": "cible 32 %"}`. Disponible sur `bar`, `hbar`, `line`, `area`, `stackedBar`. Le moteur réserve la place du libellé et étend l'échelle si besoin. |
| `zero` | `false` sur `line`/`area` : l'axe ne démarre plus à zéro. À utiliser quand la variation utile est petite devant les valeurs. |
| `labelLast` | `false` : pas d'étiquette sur le dernier point d'une courbe. |
| `rowHeight` / `labelWidth` | `hbar` : réglages fins. La gouttière de libellés est calculée automatiquement ; ne la force que si le rendu le demande. |

Un libellé de catégorie `hbar` est tronqué au-delà de 34 caractères (le texte
complet reste en infobulle). Le validateur prévient : déplace le détail dans la
`caption` plutôt que de le laisser couper.

`showValues` est ignoré sur un `bar` à plusieurs séries — les étiquettes se
chevauchent dans une même catégorie, et l'infobulle porte déjà les valeurs.

`donut` prend `items` au lieu de `categories`/`series`. **Donne-lui des valeurs
absolues** : la part en pourcentage est calculée et affichée par le moteur. Si
tes valeurs sont déjà des pourcentages, le moteur le détecte et n'affiche pas la
part deux fois ; `showShare: false` force le comportement.
```json
{ "type": "chart", "data": {
  "type": "donut",
  "title": "Répartition du temps de mission",
  "items": [ { "name": "Audit", "value": 34 }, { "name": "Tests", "value": 26 } ],
  "centerValue": "240 h", "centerLabel": "au total",
  "valueFormat": { "suffix": " h" }
} }
```

### `banner` — bannière de section
```json
{ "type": "banner", "data": {
  "style": "waves", "eyebrow": "Chantier suivant",
  "title": "Rétention à 30 jours",
  "subtitle": "L'inscription n'est plus le goulot.",
  "height": 210, "light": false
} }
```
`light: true` → fond clair et texte sombre (pour `blueprint`).
`image: "https://…"` remplace le motif procédural par une photo.

### `callout` — encadré
```json
{ "type": "callout", "data": {
  "tone": "critical", "title": "Cause principale",
  "text": "Le lien expirait avant d'être cliqué dans <b>41 % des cas</b>."
} }
```
`tone` : `info` | `good` | `warn` | `critical` | `idea`.
`icon` : nom de pictogramme pour forcer autre chose que l'icône par défaut.

### `table`
```json
{ "type": "table", "data": {
  "withHeadings": true,
  "content": [
    ["Chantier", "Impact", "Charge", "Échéance"],
    ["Activation J+7", "+12 pts rétention", "3 semaines", "Septembre"]
  ] } }
```
Première ligne = en-têtes. Les colonnes numériques sont alignées à droite
automatiquement dans la version exportée. Quatre à six colonnes maximum.

### `figure` — image ou illustration
```json
{ "type": "figure", "data": {
  "src": "data:image/png;base64,…",
  "alt": "Parcours d'inscription avant refonte",
  "caption": "Le schéma remis à l'équipe le 12 juin.",
  "wide": true
} }
```
Sans `src`, le bloc affiche un aplat marqué avec le texte `alt` — utile comme
emplacement réservé quand l'image viendra plus tard.

### `sources` — citer un passage

```json
{ "type": "sources", "data": { "items": ["Stack Overflow", "BLS"] } }
```

Se pose **juste après** le passage qu'il appuie : paragraphe, tableau,
graphique. Les `items` sont les `name` déclarés à la racine — le lien et le
logo du site sont repris de là.

Rendu : les logos se superposent en une petite pastille ; au survol elle se
déplie et chaque source devient une pastille nommée, cliquable vers sa page. À
l'impression, tout est déplié.

| Champ | Effet |
|---|---|
| `items` | Noms déclarés dans `sources`, ou `{name, url}` pour une source ponctuelle. |
| `label` | Surtitre facultatif (« Sources », « Méthode »). Vide par défaut. |

Le logo est récupéré à la construction et **intégré au fichier** : il s'affiche
hors ligne. Une source sans `url`, ou dont le logo est introuvable, porte un
monogramme coloré — la citation reste lisible, elle perd juste sa marque.

Cite ce qui porte un CHIFFRE ou une AFFIRMATION contestable. Un bloc de sources
après chaque paragraphe est un rapport qu'on ne lit plus.

### `quote`
```json
{ "type": "quote", "data": {
  "text": "On savait qu'on perdait des gens.",
  "caption": "Léa Marchand, Head of Growth" } }
```

### `delimiter`
```json
{ "type": "delimiter", "data": {} }
```
Séparateur discret. Utile avant une annexe ou une note de fin.

---

## Validation

`report_publish()` valide avant de construire, et refuse d'écrire un fichier
qu'un lecteur ne pourrait pas lire.

Les erreurs bloquent la publication, les avertissements sont des remarques de rédaction
(graphique sans titre, sans légende, trop de tuiles KPI, rapport sans aucun
graphique). Ils méritent presque toujours une correction plutôt qu'un haussement
d'épaules.
