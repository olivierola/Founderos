# FounderOS Skill Recorder

Apprendre une compétence à un agent **en la lui montrant**.

Vous lancez un enregistrement depuis FounderOS, un navigateur s'ouvre, vous faites
votre travail normalement **en expliquant à voix haute ce que vous faites**. À
l'arrêt, la trace (gestes + narration, alignés dans le temps) part en synthèse et
devient une skill dans votre bibliothèque.

## Ce qui est capturé

| Côté navigateur (ce paquet) | Côté FounderOS (l'app) |
| --- | --- |
| clics, saisies, sélections, cases cochées | narration dictée au micro (Deepgram) |
| soumissions de formulaire, téléversements | segments horodatés, alignés sur les gestes |
| navigations, ouverture/fermeture d'onglets | notes texte ajoutées en cours de route |
| touches significatives (Entrée, Échap, Ctrl+…) | |
| vignettes sur les gestes structurants | |

Chaque événement porte de quoi re-cibler l'élément plus tard : `data-testid`, id
stable, rôle ARIA, nom accessible, chemin CSS de repli.

## Vie privée

Le caviardage a lieu **dans la page**, avant tout envoi réseau : la valeur d'un
champ mot de passe, carte bancaire, IBAN, OTP ou clé d'API ne quitte jamais votre
machine. Le champ est bien enregistré (l'agent doit savoir qu'il faut le remplir),
mais sa valeur est marquée `secret` et devient une **variable** dans la skill.

Le reste est enregistré tel quel : n'enregistrez que ce que vous accepteriez de
voir dans une procédure d'équipe.

## Installation

```bash
cd skill-recorder
npm install          # installe aussi Chromium
cp .env.example .env # renseignez SUPABASE_URL — c'est tout
npm start
```

**Il n'y a aucun secret à copier.** Au premier démarrage, le recorder affiche un
code d'appairage :

```
         Code d'appairage :   7KQ2-M4XB
```

Saisissez-le dans FounderOS (*Skills → Enregistrer une démonstration*). C'est ce
geste, fait depuis une session déjà authentifiée, qui lie l'appareil à votre
workspace. Le jeton obtenu est écrit dans `.auth.json`, vous ne le verrez jamais,
et l'appairage ne se refait plus.

Conséquence utile : un appareil ne voit que les démonstrations de **son**
workspace. Le serveur le déduit de son identité — le recorder ne peut pas
élargir sa portée en la demandant.

Pour dépairer un poste : supprimez `.auth.json`, ou révoquez l'appareil côté
base (`recorder_devices.revoked_at`). Le recorder se réappaire tout seul au
prochain démarrage.

## Le profil navigateur

Le Chromium ouvert utilise un profil **persistant** (`./.profile` par défaut).
Conséquence directe : **la première fois, connectez-vous à vos outils** dans ce
navigateur. Les sessions sont conservées, les enregistrements suivants partent
directement de votre espace de travail réel.

C'est ce qui distingue ce recorder d'un simple navigateur d'automatisation : sans
profil persistant, on ne pourrait démontrer que des parcours publics.

Le profil contient vos cookies de session : traitez `./.profile` comme un secret,
il est déjà dans `.gitignore`.

## Déroulé d'un enregistrement

1. Dans FounderOS : **Skills → Enregistrer une démonstration**, donnez un titre,
   l'objectif et l'URL de départ, puis démarrez.
2. Le recorder réclame l'enregistrement (jusqu'à 3 s) et ouvre le navigateur.
   Un bandeau `● Enregistrement 00:00` reste visible en haut à droite.
3. Faites votre travail **en le commentant** : « je filtre sur les clients actifs »,
   « attention, si le devis dépasse 10 000 € il faut l'accord de la direction ».
   Les phrases sont rattachées aux gestes qu'elles décrivent.
4. Cliquez **Arrêter** dans FounderOS. Le navigateur se ferme, la synthèse démarre.
5. La skill apparaît dans la bibliothèque, ouvrable dans l'éditeur de skills.

Fermer la fenêtre du navigateur arrête aussi proprement l'enregistrement.

## Ce que produit la synthèse

- `SKILL.md` — le playbook (objectif, prérequis, variables, procédure, vérification,
  points d'attention), en variables `{{...}}` plutôt qu'en valeurs de la démo ;
- `steps.json` — les étapes rejouables (action, cible, valeur, résultat attendu) ;
- `demonstration.md` — la trace brute, gardée comme source de vérité.

Si un agent était sélectionné au départ, la skill lui est activée d'office.

## Dépannage

| Symptôme | Cause probable |
| --- | --- |
| « En attente d'un recorder » ne se dénoue pas | le paquet n'est pas lancé, ou l'appareil n'est pas encore appairé |
| « Appairage indisponible sur ce projet » | les edge functions ne sont pas déployées : `supabase functions deploy test-runner-poll test-run-orchestrate` |
| « Code expiré » | un code vit 10 minutes ; le recorder en génère un nouveau tout seul |
| Aucune vignette dans la timeline | `SUPABASE_SERVICE_ROLE_KEY` non renseignée |
| Il faut se reconnecter à chaque fois | `RECORDER_PROFILE_DIR` pointe sur un dossier temporaire |
| La synthèse échoue en « démonstration vide » | aucun geste capturé — vérifiez que vous avez travaillé dans la fenêtre ouverte par le recorder, pas dans votre navigateur habituel |

## Limites connues

- Seul le navigateur lancé par le recorder est observé — pas votre navigateur
  quotidien, ni les applications bureau.
- Le glisser-déposer et les canvas (éditeurs graphiques, tableurs en canvas) ne
  produisent pas de gestes exploitables : commentez-les à voix haute, la narration
  reprend la main.
- Un seul enregistrement à la fois par recorder.
