# Apprentissage par démonstration

*Comment une compétence s'apprend en la montrant, plutôt qu'en l'écrivant.*

---

## Le problème

Écrire un playbook d'agent suppose de savoir **formuler** une procédure. Or les
gens qui connaissent le mieux un processus métier savent le *faire*, pas
l'écrire — et ce qu'ils écrivent omet systématiquement ce qu'ils jugent évident
(le champ qu'on laisse toujours vide, le filtre qu'on remet à chaque fois, le
cas particulier du vendredi).

Cette fonctionnalité inverse le geste : l'utilisateur **fait son travail en le
commentant à voix haute**, et la procédure est déduite de la démonstration.

## Les deux moitiés

Il y a deux capteurs, sur la même machine, qui ne se parlent pas directement.

| | Ce qu'il capture | Où il vit |
|---|---|---|
| **Extension** *(voie principale)* | les mêmes gestes, **dans les onglets de l'utilisateur**, avec ses sessions vivantes | [browser-recorder/](../browser-recorder/) — MV3, Chrome/Edge/Opera/Brave |
| **Recorder Playwright** *(repli)* | clics, saisies, sélections, navigations, téléversements, touches, vignettes | [skill-recorder/](../skill-recorder/) — Node, navigateur séparé |
| **App** | narration dictée au micro (Deepgram), notes texte | [SkillRecorder.tsx](../src/features/internal-agents/SkillRecorder.tsx) |

Les deux capteurs de gestes sont **interchangeables** : ils parlent le même
contrat `rec_events`, et la synthèse ne sait pas lequel lui écrit. C'est ce qui a
permis d'ajouter l'extension sans toucher une ligne de la synthèse.

### Lequel s'exécute

Interchangeables ne veut pas dire indifférenciables. Les deux réclament au même
endpoint : sans arbitrage, **le premier arrivé gagnait**, et lancer une
démonstration avec les deux installés ouvrait tantôt un onglet, tantôt une
fenêtre Playwright, au hasard de la latence réseau.

L'appariement est donc explicite (migration `0204`) :

- l'enregistrement porte `capture_mode` — `extension`, `playwright`, ou `any` ;
- chaque capteur se déclare à la réclamation (`rec_claim`, champ `capture`) ;
- `rec_claim` ne sert que les enregistrements compatibles.

Le choix est fait par l'app, et il n'est proposé à l'utilisateur que **lorsqu'il
est réel** : le sélecteur « Mes onglets / Navigateur séparé » n'apparaît que si
l'extension répond au ping. Sinon, `capture_mode` reste `any` — plutôt que
d'imposer Playwright, car la détection peut être un faux négatif (extension
installée mais onglet chargé avant elle) et bloquer le capteur présent serait
pire que de le laisser venir.

`captured_by` enregistre qui a effectivement pris la main ; la timeline l'affiche
pendant l'enregistrement, pour que la question ne se pose jamais.

### Pourquoi une extension plutôt que « piloter le navigateur de l'utilisateur »

Chromium pose un **verrou exclusif** sur son dossier de profil : deux processus
ne peuvent pas l'ouvrir simultanément. Piloter le navigateur habituel de
quelqu'un avec Playwright imposerait de le fermer d'abord — et cette contrainte
vaut pour Chrome comme pour Edge, Opera ou Brave.

Embarquer un navigateur dans un iframe de FounderOS ne marche pas non plus : les
sites tiers envoient `X-Frame-Options` / `frame-ancestors`, et un iframe
cross-origin est de toute façon opaque au JavaScript.

Restait l'extension, qui vit *dans* le navigateur. Deux contraintes MV3 ont
façonné [background.js](../browser-recorder/src/background.js) :

- **le service worker meurt** après ~30 s d'inactivité, y compris en pleine
  démonstration. Tout l'état vit donc dans `chrome.storage.session` — numéro de
  séquence compris, sans quoi un compteur réinitialisé ferait silencieusement
  rejeter les gestes suivants par la contrainte d'unicité ; une alarme de 30 s
  ressuscite le worker pour pousser, bien en deçà des 90 s de tolérance de l'app.
- **l'instrumentation est injectée à la demande** (`chrome.scripting`), pas
  déclarée dans le manifeste : hors enregistrement, `content.js` n'existe dans
  aucune page. Enregistrer dans les onglets de quelqu'un n'est acceptable qu'à
  ce prix.

Les deux écrivent dans **la même table** (`skill_recording_events`), avec un
`at_ms` mesuré depuis `skill_recordings.started_at`. C'est tout le mécanisme :
une fois les deux flux sur la même règle graduée, associer une phrase au geste
qu'elle décrit n'est plus qu'un `order by at_ms`.

Aucun des deux capteurs ne pilote l'autre. Le **statut de la ligne** est le seul
canal :

```
pending ──(le recorder réclame)──> recording ──(l'app demande l'arrêt)──> stopping
                                                                            │
                                              (le recorder referme le navigateur)
                                                                            ↓
                                                    processing ──> ready | failed
```

Conséquence pratique : chaque moitié peut redémarrer sans casser l'autre, et
l'app n'a qu'une seule ligne à observer pour connaître l'état du monde.

## Pourquoi les timestamps sont ce qu'ils sont

Un résultat final Deepgram **arrive en retard sur la parole** — stabilisation +
réseau, parfois plus d'une seconde. Dater un segment à sa réception le placerait
systématiquement *après* le geste qu'il annonce (« maintenant je clique sur
Créer » atterrirait après le clic).

D'où l'usage de `start` / `duration`, que Deepgram exprime en secondes depuis le
début du flux audio ([useNarration.ts](../src/lib/useNarration.ts)) : on date la
phrase au moment où elle a été **prononcée**, pas reçue.

Côté serveur, le rattachement tolère les deux sens de la parole
([skill-synthesis.ts](../supabase/functions/_shared/skill-synthesis.ts)) : une
narration couvre un geste survenu pendant qu'elle était prononcée, jusqu'à 2,5 s
avant (on annonce) et 4 s après (on commente ce qu'on vient de faire).

Les deux producteurs tournent sur la même machine et calculent leur `at_ms` de
la même façon (`Date.now() - Date.parse(started_at)`), donc un décalage
d'horloge avec le serveur s'annule au lieu de désaligner les flux.

## Ce que le LLM voit

Pas un journal brut. La synthèse fait d'abord le travail ingrat :

1. **fusion** des deux flux dans l'ordre chronologique ;
2. **compression** — les saisies successives sur un même champ s'effondrent en
   une ligne (la valeur finale, pas la frappe), les scrolls consécutifs aussi ;
3. **rattachement** de chaque geste à la phrase qui le couvre.

Le prompt reçoit donc un récit déjà structuré :

```
[00:12] cliquer sur button « Nouveau devis »
        ↳ dit : « on part toujours du bouton en haut à droite »
[00:19] saisir "ACME SARL" dans textbox « Client »
[00:24] 🗣  « attention, si le devis dépasse dix mille euros il faut l'accord
             de la direction avant de l'envoyer »
```

La règle donnée au modèle est explicite : **la narration prime pour
l'intention, les gestes priment pour les détails techniques**. Une règle métier
énoncée mais non démontrée doit figurer dans la procédure ; une étape ni
démontrée ni énoncée ne doit pas être inventée (elle part dans
`open_questions`).

## Ce qui est produit

Une skill multi-fichiers ordinaire — rien de spécifique au mode d'acquisition,
elle s'édite comme les autres dans [SkillEditor](../src/features/internal-agents/SkillEditor.tsx) :

| Fichier | Rôle |
|---|---|
| `SKILL.md` (`system_prompt_extension`) | le playbook : objectif, prérequis, variables, procédure, vérification, points d'attention |
| `steps.json` | les étapes rejouables (action, cible, valeur, résultat attendu) |
| `demonstration.md` | la trace brute, gardée comme source de vérité |

`agent_skills.config` porte `{origin: "recording", variables, open_questions}`,
et `source_recording_id` remonte à la démonstration. Si un agent était choisi au
départ, la skill lui est activée d'office.

**Les valeurs de la démo deviennent des variables.** Une démonstration est un
exemple, pas une constante : `"ACME SARL"` devient `{{client}}`. Les valeurs
caviardées le deviennent d'office.

## Vie privée

Le caviardage a lieu **dans la page**, avant tout envoi réseau
([instrument.js](../skill-recorder/src/instrument.js)) : un champ est jugé
sensible par son `type`, son `autocomplete`, ou son vocabulaire (nom, id,
placeholder, libellé associé — mot de passe, CVV, IBAN, clé d'API, OTP…).

Le champ reste enregistré — l'agent doit savoir qu'il faut le remplir — mais sa
valeur ne quitte jamais la machine et devient une variable marquée `secret`.

Les faux positifs sont assumés : une variable de trop coûte moins cher qu'un mot
de passe en base.

Le reste est enregistré tel quel. Le profil navigateur persistant
(`skill-recorder/.profile`) contient les cookies de session de l'utilisateur : à
traiter comme un secret.

## Les endpoints, et pourquoi ils sont là où ils sont

Le projet est **au plafond de 100 edge functions**. Aucune fonction n'a été
ajoutée ; les modes sont repliés dans les deux fonctions qui portaient déjà
exactement la même relation de confiance :

| Appelant | Fonction | Modes |
|---|---|---|
| recorder, non encore appairé | `test-runner-poll` | `rec_pair_start`, `rec_pair_poll` — **avant** la barrière d'auth |
| recorder appairé (`X-Recorder-Token`) | `test-runner-poll` | `rec_claim`, `rec_events`, `rec_finish` |
| app (JWT utilisateur) | `test-run-orchestrate` | `pair_recorder`, `synthesize_recording` |

Le découpage n'est pas arbitraire : `test-runner-poll` est déjà *ce à quoi un
runner local parle*, `test-run-orchestrate` est déjà *ce à quoi l'app parle*.

### L'identité du recorder

Le recorder a d'abord emprunté le token du test-runner. C'était une erreur : ce
token est l'identité d'un **serveur d'exécution partagé**, à portée projet,
qu'il fallait copier à la main depuis un écran d'ailleurs retiré de la nav. Un
recorder, lui, tourne sur le poste d'**une** personne, pour **son** workspace.

Il a donc sa propre identité, obtenue par un flux *device code* (migration
`0203`, table `recorder_devices`) :

1. le recorder démarre sans rien et appelle `rec_pair_start` — ces deux modes
   passent **avant** `authenticate()`, par construction : un appareil neuf n'a
   aucun secret à présenter ;
2. il affiche un code de 8 caractères (alphabet sans `O`/`0` ni `I`/`1` — il est
   lu sur un terminal et retapé dans un navigateur) ;
3. l'utilisateur le saisit dans l'app ; ce geste, fait depuis une session
   authentifiée, écrit `workspace_id` + `user_id` sur la ligne ;
4. `rec_pair_poll` remet le jeton **une seule fois**, puis l'appareil
   l'enregistre dans `.auth.json`.

Ce qui protège l'étape 1 n'est pas un secret mais le fait que le code ne vaut
rien sans quelqu'un capable de s'authentifier dans l'app. Il expire en 10 min,
est à usage unique, et le `device_id` ne permet de retirer un jeton que dans les
2 minutes suivant l'appairage — assez pour un réessai réseau, trop peu pour
servir de clé de rechange.

L'appareil porte son workspace **dans son identité** : le corps de la requête ne
peut pas l'élargir, et `rec_claim` / `rec_events` / `rec_finish` sont bornés par
`recordingInScope()`.

L'ordre d'arrêt voyage dans la **réponse** à `rec_events`, pas dans un poll
séparé : le recorder pousse déjà toutes les 1,2 s, autant s'en servir.

## Les pannes prévues

| Panne | Ce qui se passe |
|---|---|
| Le recorder n'est pas lancé | après 15 s d'attente, l'app affiche la commande à lancer |
| Des demandes s'empilent pendant que le recorder est absent | `rec_claim` sert la **plus récente** et ignore tout ce qui dépasse 15 min : un recorder qui démarre rejoint la personne qui attend devant son écran, pas une démo abandonnée le matin |
| Le recorder meurt en cours | le battement de cœur (`heartbeat_at`) se tarit ; après 90 s l'app propose **« Créer la skill avec ce qui est enregistré »** → `synthesize_recording` |
| Un lot d'événements se perd | remis en tête de file et réessayé ; l'upsert sur `(recording_id, source, seq)` rend le renvoi idempotent |
| La synthèse LLM échoue | la trace est intacte en base, le bouton **Relancer la synthèse** rejoue la synthèse seule |
| L'utilisateur ferme le navigateur | traité comme un arrêt propre : dernier lot poussé, puis synthèse |

Le fil conducteur : **une démonstration de vingt minutes ne doit jamais être
perdue par un incident survenu à la fin.**

## L'agent agit à son tour

Apprendre une procédure sans pouvoir l'exécuter n'aurait qu'un intérêt
documentaire. L'extension porte donc un second canal, en sens inverse : l'outil
d'agent **`user_browser`** (migration `0205`).

Il est complémentaire de `sandbox_browser`, pas redondant. Le Chromium du
sandbox n'a **aucune session** — l'agent y arriverait déconnecté de tout. Ici il
agit dans le navigateur de la personne, avec ses accès déjà ouverts, c'est-à-dire
exactement là où la procédure a été démontrée.

Les cibles se décrivent dans **le même vocabulaire que l'enregistreur**
(`{label, role, testid, css, name}`), et [executor.js](../browser-recorder/src/executor.js)
les relit dans le même ordre de fiabilité. C'est ce qui referme la boucle : une
skill apprise par démonstration est rejouable telle quelle.

### Tous les onglets, pas seulement celui du dessus

Un agent doit pouvoir comparer deux fiches, recopier d'un outil vers un autre,
surveiller un onglet pendant qu'il travaille dans un second. L'action `tabs`
liste les onglets ouverts avec leur `tab_id`, et **chaque** action accepte ce
`tab_id` — l'agent agit donc dans un onglet sans en voler le focus. `switch`,
`open` et `close` complètent la manipulation.

`navigate` ne détourne jamais la page qu'on est en train de lire. Son ordre de
préférence : un `tab_id` explicite, sinon **un onglet déjà ouvert sur le même
hôte**, sinon un nouvel onglet. La première version chargeait l'URL dans
l'onglet actif — aller sur LinkedIn écrasait la conversation en cours alors
qu'un onglet LinkedIn attendait deux crans plus loin.

L'onglet FounderOS, lui, est reconnu par un **marqueur statique** dans
`index.html` que [bridge.js](../browser-recorder/src/bridge.js) lit sur chaque
page, et dont l'origine est mémorisée durablement. Se fier à une déclaration
active de la page ne suffisait pas : seule la page d'enregistrement se
déclarait, si bien qu'un agent lancé depuis le chat détournait l'onglet où on
lui parlait.

Le périmètre autorisé s'applique aussi à la **lecture** : `tabs` ne montre que
les onglets dans le périmètre, et compte les autres sans les nommer. Armer « ce
site uniquement » ne doit pas laisser fuiter le reste d'une navigation.

### Le consentement porte sur l'armement, pas sur l'action

Un agent qui pilote un navigateur connecté peut faire tout ce que son
propriétaire peut faire. Demander une approbation **par action** serait
inutilisable — une procédure fait vingt clics — et pousserait à tout approuver
sans lire : le pire des deux mondes.

L'autorisation est donc explicite, **bornée dans le temps et en périmètre**,
donnée depuis la popup de l'extension (« Autoriser 15 minutes », « ce site
uniquement » / « tous les sites »), et coupable d'un clic.

Ce qui en découle :

- hors fenêtre d'armement, `rec_control_poll` **ne remet aucun ordre** — il ne
  les refuse pas poliment, il ne les livre jamais ;
- le périmètre est vérifié sur l'**URL réelle de l'onglet**, pas sur ce que
  l'ordre prétend viser ;
- une commande expire en 2 minutes : un ordre émis pendant que le navigateur
  dormait ne doit pas s'exécuter au réveil, hors de tout contexte ;
- désarmer périme immédiatement les ordres en vol ;
- le badge de l'extension affiche `⚡` tant que le pilotage est autorisé, et
  `browser_commands` garde le journal de tout ce qui a été fait.

Quand rien n'est armé, l'outil ne tente rien : il dit à l'agent de demander à
l'utilisateur d'autoriser, et de ne pas contourner.

## Limites

- Seul le navigateur ouvert par le recorder est observé — pas le navigateur
  quotidien, ni les applications bureau. Une extension Chrome lèverait cette
  limite en réutilisant tel quel le reste de la chaîne : le contrat d'ingestion
  (`rec_events`) ne suppose rien de Playwright.
- Le glisser-déposer et les canvas (éditeurs graphiques, tableurs en canvas) ne
  produisent pas de gestes exploitables ; la narration reprend la main.
- Un enregistrement à la fois par recorder.
- La skill produite décrit une procédure navigateur ; la rejouer suppose que
  l'agent dispose de `sandbox_browser`.

## Fichiers

| | |
|---|---|
| Migration | [0202_skill_recordings.sql](../supabase/migrations/0202_skill_recordings.sql) |
| Synthèse | [_shared/skill-synthesis.ts](../supabase/functions/_shared/skill-synthesis.ts) |
| Ingestion | [test-runner-poll/index.ts](../supabase/functions/test-runner-poll/index.ts) |
| Rattrapage | [test-run-orchestrate/index.ts](../supabase/functions/test-run-orchestrate/index.ts) |
| Recorder | [skill-recorder/](../skill-recorder/) |
| Micro horodaté | [useNarration.ts](../src/lib/useNarration.ts) |
| Écran | [SkillRecorder.tsx](../src/features/internal-agents/SkillRecorder.tsx) |
