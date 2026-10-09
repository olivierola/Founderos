# Anduran · Collaborateurs, extension navigateur

Quatre usages, un seul paquet :

- **le panneau des collaborateurs** : un panneau latéral pleine hauteur, à côté
  de chaque page, où l'on parle à tous ses collaborateurs. La page part d'un
  raccourci, ils la lisent, la surlignent et répondent, en bulle si le panneau
  est fermé (voir plus bas) ;
- enregistrer une démonstration **dans vos propres onglets**, avec vos sessions
  déjà ouvertes, dans le navigateur que vous utilisez déjà ;
- laisser un collaborateur **agir** dans vos onglets (pilotage armé) ;
- se faire **former** dans un outil (mode formation).

C'est la voie principale. Le paquet [skill-recorder/](../skill-recorder/) fait la
même chose avec Playwright, dans un navigateur séparé — utile sur un serveur ou
un poste sans extension, mais il vous demande de vous reconnecter à vos outils.

## Pourquoi une extension plutôt que Playwright

Chromium pose un **verrou exclusif** sur son dossier de profil : deux processus
ne peuvent pas l'ouvrir en même temps. Piloter votre navigateur habituel avec
Playwright imposerait donc de le fermer d'abord, et vaudrait pour Chrome comme
pour Edge, Opera ou Brave.

Une extension vit *dans* le navigateur : rien à fermer, rien à copier, et le
même paquet MV3 s'installe sur Chrome, Edge, Opera, Brave et Vivaldi.

## Installation

1. `chrome://extensions` (ou `edge://extensions`, `opera://extensions`…)
2. activer le **mode développeur**
3. **« Charger l'extension non empaquetée »** → choisir ce dossier
4. cliquer l'icône de l'extension : le panneau s'ouvre sur Anduran (il retrouve
   seul l'adresse de l'app si un onglet Anduran a déjà été ouvert, sinon il la
   demande). Connecté, un bandeau propose « Relier ce navigateur » : un clic, et
   l'appareil est appairé, sans code à recopier

L'appairage ne se refait plus : le jeton vit dans le stockage de l'extension.
C'est le même flux *device code* que le recorder Playwright, le code est
simplement validé par l'app connectée au lieu d'être retapé. Le saisir à la
main reste possible (Réglages de l'extension, dans le panneau).

## Le panneau des collaborateurs

Le panneau latéral du navigateur (Chrome, Edge, Brave : pleine hauteur, largeur
réglable à la souris) affiche **l'app elle-même**, route `/companion`, dans
un iframe et avec votre session. Le chat y est donc exactement celui de l'app :
mêmes collaborateurs, mêmes validations en ligne, mêmes livrables. En haut, la
rangée des collaborateurs du projet, les plus récents d'abord ; un point bleu
signale une réponse non lue, l'avatar s'anime quand l'un d'eux travaille.

Ce que le panneau ajoute, c'est la page :

| Geste | Effet |
| --- | --- |
| `Alt+Shift+A` ou l'icône | ouvrir le panneau |
| `Alt+Shift+P`, ou clic droit « Envoyer cette page » | la page part avec « Analyse cette page… », le collaborateur peut y surligner l'essentiel |
| `Alt+Shift+S`, ou clic droit sur une sélection | la sélection est jointe au prochain message |
| pastille sur le texte sélectionné (panneau ouvert) | Demander, Expliquer, Résumer, Traduire |
| `Alt+Shift+E` ou « Pointer » | cliquer un élément de la page pour le joindre |
| pastille « page » dans le composer | joindre (ou non) la page à chaque message |

Les raccourcis se changent dans `chrome://extensions/shortcuts`.

**Ce qui est lu.** La page est lue **au moment de l'envoi**, jamais en continu :
texte principal en markdown (titres, listes, tableaux, liens), sans les menus ni
les bandeaux de cookies. Les **valeurs des champs ne sont jamais lues**, et ce
qui ressemble à un secret (clé d'API, jeton, IBAN, numéro de carte validé par
Luhn) est masqué dans la page, avant envoi. Une page inchangée depuis le
message précédent n'est pas renvoyée : une ligne la désigne. Côté serveur, seule
la dernière page jointe d'une conversation reste entière dans le contexte.

**Ce que le collaborateur peut faire en retour** passe par l'outil
`page_assist`, enregistré seulement dans une conversation ouverte depuis le
panneau, et par un troisième canal, `companion` (migration 0271) :

- `look` : relire la page en cours, **panneau ouvert seulement**. L'extension
  renouvelle un bail de 150 s (`recorder_devices.companion_until`) tant que le
  panneau est affiché ; fermé, le serveur refuse la lecture, et l'extension aussi ;
- `highlight` : surligner des passages (par leur texte exact) ou des éléments
  (par leur libellé), numérotés, avec une note. Ce qui n'a pas été trouvé revient
  nommé au collaborateur ;
- `say`, `clear` : une bulle dans la page, tout effacer.

Aucun clic, aucune saisie sur ce canal : la liste blanche `COMPANION_ACTIONS`
de [background.js](src/background.js) est la garantie, comme pour la formation.

**Panneau fermé**, la conversation continue : une réponse, une question à choix
ou une validation en attente arrive dans une **bulle** sur la page en cours
(mode `companion_feed`), avec de quoi répondre sur place ou rouvrir le
panneau. Sur une page où aucune bulle ne peut s'afficher, le badge de l'icône
compte les réponses. Désactivable : « Bulles panneau fermé ».

**Prérequis côté app.** La route `/companion` doit être déployée, avec
l'exception d'encadrement de [vercel.json](../vercel.json) (toutes les autres
routes restent en `X-Frame-Options: DENY`). En local, l'adresse
`http://localhost:5173` suffit. Avec ses permissions d'hôte, l'extension
reçoit dans l'iframe le même stockage que l'onglet Anduran : une session
ouverte dans un onglet l'est aussi dans le panneau.

## Ce qui est enregistré, et quand

**Rien n'est injecté hors enregistrement.** `content.js` n'est pas déclaré dans
le manifeste : il est injecté par `chrome.scripting` au démarrage d'une
démonstration, et retiré à la fin. En dehors, l'extension n'observe aucune de
vos pages — la garantie n'est pas une promesse, c'est une absence de code.

Pendant un enregistrement, un bandeau `● Enregistrement 00:00` s'affiche dans
chaque onglet observé. Vous savez en permanence ce qui est vu.

Sont exclus :

- l'onglet FounderOS lui-même (vos clics dans le panneau ne sont pas la démo) ;
- les pages internes du navigateur (`chrome://`, Web Store, lecteur PDF natif) —
  aucune extension ne peut s'y injecter.

Le seul script présent en permanence est [bridge.js](src/bridge.js), qui écoute
un unique message `postMessage` : il sert à ce que FounderOS sache que
l'extension est installée, et à démarrer sans attendre.

## Piloter : l'agent agit dans vos onglets

L'extension a un second canal, en sens inverse : un agent peut cliquer et saisir
dans vos onglets — avec vos sessions — pour EXÉCUTER une procédure qu'il a apprise.

Ce pouvoir est fermé par défaut. Vous l'ouvrez depuis la popup, pour **15 minutes
ou 1 heure**, et pour **ce site uniquement** ou tous. Le badge passe à ⚡ tant
que c'est actif, et « Couper le pilotage » referme tout immédiatement — y compris
les ordres déjà en vol.

Une approbation par action aurait été inutilisable : une procédure fait vingt
clics, et on finirait par tout approuver sans lire. Le consentement porte donc
sur la fenêtre, qui est courte, visible et révocable.

Hors de cette fenêtre, le serveur ne remet **aucun** ordre à l'extension — il ne
les refuse pas, il ne les livre jamais.

L'agent voit et manipule **tous vos onglets** (lister, ouvrir, basculer, fermer,
agir dans un onglet précis sans en voler le focus) — mais seulement ceux qui
entrent dans le périmètre autorisé : la liste masque les autres.

## Se faire former : l'agent montre, vous faites

Le troisième canal est le seul qui ne travaille pas à votre place. Un agent
formateur entoure le bon bouton dans votre page, écrit la phrase — et la dit à
voix haute si vous le voulez —, puis **attend que vous cliquiez**. Ni sa main ni
son curseur n'entrent dans la page.

Vous l'ouvrez depuis la popup, « Mode formation », pour **1 heure ou 4 heures**.
La durée est plus longue que celle du pilotage précisément parce que ce mode
peut moins : apprendre un outil prend une matinée, et un consentement qu'il faut
redonner tous les quarts d'heure finit par se donner sans lire.

Le badge passe à 🎓. Pendant une formation, une petite carte reste en bas à
droite : le parcours, l'étape en cours, le son, et « Quitter » — qui coupe tout,
immédiatement.

Ce que le canal `coach` accepte est **fermé par liste blanche**, dans
[background.js](src/background.js) comme côté serveur : afficher un repère,
poser une question, lire la page, lister les onglets. Aucune commande qui clique,
saisit ou valide n'y est servie. La retenue du formateur n'est donc pas une
consigne dans son prompt, qu'on pourrait lui faire oublier en insistant : c'est
une absence de code, comme pour l'enregistrement.

Deux détails qui font la différence entre une démonstration et une vraie
formation :

- **le geste est détecté**, pas déclaré. Le coach écoute le clic sur l'élément
  visé, la saisie du champ, le changement de page — vous n'avez pas à confirmer
  chaque étape. Le bouton « C'est fait » reste là pour ce qui ne se détecte pas
  (glisser-déposer, canvas, iframe d'un autre domaine) ;
- **l'étape survit à la navigation**. Cliquer « Se connecter » recharge la page
  et emporte le repère avec elle : le service worker le replante dans la page
  suivante, ou conclut l'étape quand le changement de page ÉTAIT le geste
  attendu.

« Je suis bloqué » n'est pas un abandon : il remonte à l'agent, qui doit
reformuler autrement — et la trace en reste dans FounderOS. Une étape sur
laquelle quatre personnes sur cinq trébuchent y apparaît comme ce qu'elle est :
une consigne à réécrire, pas une série de nouveaux arrivants distraits.

## Vie privée

Le caviardage a lieu **dans la page**, avant tout envoi : mots de passe, CVV,
IBAN, clés d'API, codes OTP. Le champ est enregistré — l'agent doit savoir qu'il
faut le remplir — mais sa valeur devient une variable `secret` de la skill.

Aucune clé Supabase n'est embarquée. Les captures d'écran partent en base64 vers
le mode serveur `rec_shot`, qui les range avec une clé qui, elle, reste au
serveur. Embarquer cette clé dans un paquet installé sur des postes reviendrait
à la publier.

## Le service worker meurt — et c'est prévu

MV3 décharge un service worker après ~30 s d'inactivité, y compris en pleine
démonstration si vous vous arrêtez pour lire une page. Deux conséquences dans
[background.js](src/background.js) :

- **tout l'état vit dans `chrome.storage.session`**, jamais en mémoire vive —
  numéro de séquence compris, car un compteur remis à zéro ferait silencieusement
  rejeter les gestes suivants par la contrainte d'unicité côté serveur ;
- **une alarme de 30 s ressuscite le worker** pour pousser les lots, bien en deçà
  des 90 s après lesquelles l'app conclurait que le recorder est mort.

Les mutations d'état passent par une file d'attente à une ligne : sans elle, un
geste arrivant pendant un envoi écraserait la sauvegarde de l'autre, et
disparaîtrait sans erreur.

## Dépannage

| Symptôme | Cause |
| --- | --- |
| L'app ne détecte pas l'extension | rechargez l'onglet FounderOS après l'installation |
| « Extension détectée, mais silencieuse » | pas encore appairée : ouvrez la popup, saisissez le code |
| Rien n'est enregistré sur un site | page interne du navigateur, ou onglet ouvert avant… non : les onglets déjà ouverts sont instrumentés au démarrage. Vérifiez le bandeau `● Enregistrement` |
| Pas de vignettes | la capture ne marche que sur l'onglet visible ; c'est normal si vous travaillez dans une autre fenêtre |
| `Appareil révoqué` | dissociez puis réappairez depuis la popup |

## Limites

- Firefox n'est pas testé : `api.js` utilise le repli `browser ?? chrome`, mais
  MV3 y diverge encore sur le service worker.
- Safari demanderait un empaquetage Xcode.
- Le glisser-déposer et les canvas (éditeurs graphiques, tableurs en canvas) ne
  produisent pas de gestes exploitables — commentez-les à voix haute, la
  narration reprend la main.
