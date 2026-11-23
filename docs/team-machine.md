# Machine d'équipe

Une équipe d'agents (les équipes du Live Space, `service_dashboards.settings.teams`) reçoit une vraie machine Linux, partagée. Ses agents y créent des dossiers et des fichiers, lancent des commandes, testent du code et font tourner des serveurs. Chaque agent y travaille sous sa propre identité.

- Code de la machine : `team-machine/`, un conteneur sans dépendance npm.
- Côté plateforme : migration `0296_team_machines.sql`, `_shared/team-machine.ts` (client et annuaire), `_shared/team-machine-tools.ts` (outils des agents), fonction `team-machine` (actions des humains).
- Interface : bouton **Machine** sur chaque carte d'équipe (réglages du service ou tiroir du Live Space).

## Le parc de machines (0304)

Depuis la migration `0304_machines.sql`, une machine est une ressource à part entière de l'espace, gérée dans la section **Machines** du tableau de service (rail de gauche) :

| Sous-onglet | Ce qu'on y fait |
| --- | --- |
| Vue d'ensemble | Les machines, leur état (en ligne, injoignable, en pause), CPU, mémoire, disque, combien d'équipes et d'agents y travaillent. **Ajouter une machine**, **Tester**. |
| Activité | Charge, processus de fond (avec leur journal, et l'arrêt), processus des agents, journal des actions. Rafraîchi toutes les 10 s. |
| Fichiers | Le système de fichiers **vu par un agent** : on choisit par quels yeux on regarde, et on lit ce que cet agent peut lire. Lecture seule ; chaque fichier ouvert par un humain est journalisé (`human_read`). |
| Attributions | Une machine par équipe, et éventuellement une machine propre à un agent, qui passe avant celle de son équipe. |
| Configuration | Nom, type, adresse, jeton propre, paquets système, pause, suppression. |
| Catalogue | Des machines taillées par métier (cyber, data, dev, IA, web, ops, documents) : en créer une, ou y embarquer un agent (voir plus bas). |

Les règles :

- **Une machine** = une ligne de `machines`, avec **son adresse et son jeton**. Il n'y a plus de machine de la plateforme posée par l'environnement : une machine est créée à la demande (0311, un conteneur Docker de l'hôte, en auto-hébergé) ou branchée à la main. Une adresse branchée à la main doit être publique (contrôle SSRF), sauf en auto-hébergé (`PLATFORM=self`), où le réseau interne est celui de l'opérateur.
- **Son jeton** : propre à la machine, 32 caractères au moins, chiffré dans `team_machine_secrets` (kind `machine`) et jamais réaffiché. Sans jeton, la machine ne répond pas : aucune autre ne la remplace.
- **Donner une machine à une équipe** sans en choisir une prend la première machine active du service. Une attribution d'avant 0304, sans machine, n'est plus joignable : on la rattache depuis l'onglet Machines.
- **Une attribution** reste une ligne de `team_machines`, qui gagne `machine_id`, `scope` (`team` ou `agent`) et `agent_id`. Un agent seul est une « équipe d'un » dont l'id est `agent-<uuid>`.
- **Changer de machine** ne déplace pas les fichiers. L'équipe repart d'un dossier vide sur la nouvelle, avec les mêmes agents et les mêmes dossiers protégés (redéclarés au premier appel). L'ancienne garde ce qu'elle avait.
- **Mettre une machine en pause** retire les outils `team_*` à tous ceux qui l'utilisent et suspend leurs équipes sur la machine. Une machine utilisée ne se supprime pas.
- **L'activité** ne montre que les équipes de l'espace qui la demande : une machine de plateforme peut servir plusieurs espaces. Le superviseur rend les commandes (`ps` les montre déjà aux agents), jamais un journal ni un fichier. Pour lire, il faut passer par un agent et ses secrets.

Le superviseur 0.2.0 ajoute deux opérations d'administration : `machine.info` (version, hôte, charge, mémoire, disque, limites) et `activity` (processus et jobs des équipes demandées).

## Le catalogue : des machines taillées par métier (0317)

Le sous-onglet **Catalogue** propose des machines prêtes pour un métier, par catégorie : Cybersécurité (reconnaissance, test d'intrusion web, analyse et réponse à incident), Data (analyse, ingénierie), Développement (web, Python, polyglotte), IA et ML (apprentissage automatique, notebooks), Web et collecte, Ops et cloud, Documents et OCR. Le catalogue est défini dans `backend/src/machines/catalog.ts` (une seule source, servie au front par la fonction `machines`).

- **Une machine du catalogue** est une machine d'équipe (même superviseur, même isolement, un compte Linux par agent) dont l'image ajoute les outils du métier : `founderos/team-machine-<modèle>:<version>`, construite sur l'hôte à la première création (`docker build` depuis un Dockerfile généré, sans contexte), avec les ressources du modèle (CPU, mémoire). Les binaires setuid ajoutés par les paquets sont désarmés comme dans l'image de base.
- **Créer cette machine** la crée à la demande (auto-hébergé) ; `machines.template` garde son modèle, la carte du parc l'affiche. On la donne ensuite à une équipe ou à un agent (Attributions).
- **Embarquer un agent** ouvre l'onglet Agents embarqués avec ce modèle : `embedded_agent_configs.machine_template`, ses paquets entrent dans le conteneur de l'agent (même distribution, Debian bookworm) avant ses paquets propres, et ses ressources deviennent celles du conteneur.
- Les outils de cybersécurité ne s'utilisent que sur des systèmes qu'on est autorisé à tester ; la carte le rappelle.
- Un modèle ne change jamais de sens : on en ajoute, on n'en retire pas.

## Ce que voient les agents

| Lieu | Chemin | Qui peut l'ouvrir |
| --- | --- | --- |
| Dossier perso | `~` = `/teams/<équipe>/home/<agent>` | L'agent seul |
| Commun | `/teams/<équipe>/commun` | Toute l'équipe |
| Dossier protégé | `/teams/<équipe>/dossiers/<nom>` | Ses membres seulement |

Un agent dont l'équipe a une machine active reçoit cinq outils, dans la famille EXECUTION, sans avoir besoin d'un `load_toolset` :

- `team_shell` : une commande bash, ou un job de fond avec `background=true`.
- `team_files` : read, write, append, edit, list, stat, mkdir, delete, move, copy, search.
- `team_folders` : list, create, add_members, remove_members, leave, rotate_secret.
- `team_jobs` : list, logs, stop.
- `team_install` : paquets apt pour toute la machine. Seulement si l'équipe l'autorise **et** que la machine aussi (`MACHINE_ALLOW_APT=1`).

La machine ne dépend pas du mode d'exécution de l'agent (cloud, runner, sandbox ou hybride) : c'est l'équipe qui la possède. Les outils portent le préfixe `team_*` pour qu'on sache toujours où une commande s'exécute.

## Le modèle de sécurité

L'isolement est assuré par le noyau Linux.

- **Un agent = un utilisateur Linux.** Son dossier perso est en `0700`. Ses processus tournent sous son uid, via `setpriv`, avec `no_new_privs`, sans aucune capacité, et avec des limites dures (nombre de processus, taille de fichier). L'umask `007` empêche que ce qu'il écrit soit lisible par « les autres ».
- **Une équipe = un groupe Linux.** `/teams/<équipe>` est en `0750`, donc un agent d'une autre équipe ne peut même pas y entrer.
- **Un dossier protégé = un groupe Linux et un secret.** Le dossier est en `2770`. Le groupe n'est ajouté à un processus que si la requête présente le **secret** du dossier. La machine compare ce secret à son empreinte SHA-256 et ne garde jamais le secret lui-même.

Le secret d'un dossier :

- vit chiffré en base (AES-GCM avec `CREDENTIAL_ENCRYPTION_KEY`), dans `team_machine_secrets`, une table sans aucune politique RLS ;
- n'est déchiffré que pour l'agent qui agit, et seulement pour les dossiers dont il est **membre** au moment de l'appel ;
- n'apparaît **jamais** dans le contexte d'un modèle. Un agent qui verrait un secret pourrait le recopier dans une room, un message A2A ou un livrable, et l'agent qu'on voulait tenir dehors le lirait. L'agent possède le secret par son identité, pas par sa mémoire.

Chaque agent a aussi son propre secret (son identité sur la machine), géré de la même façon.

Les règles d'un dossier protégé :

- Les membres sont pris dans l'équipe.
- Seul le propriétaire (ou un humain) ajoute ou retire des membres, et renouvelle le secret.
- Un membre retiré perd l'accès dès son appel suivant, et ses processus qui tenaient le dossier sont tués.
- Renouveler le secret rend l'ancien inutile.
- Archiver le dossier le déplace dans `/teams/<équipe>/.archives` (`root`, `0700`) : il n'est plus atteignable, mais rien n'est effacé.

Chaque action est inscrite dans `team_machine_audit` et affichée dans le panneau.

La plateforme signe chaque appel (HMAC-SHA256 du jeton de la machine, horodatage à ±120 s, nonce à usage unique). Ce jeton permet d'administrer la machine (créer, suspendre, archiver). Il **ne suffit pas** pour agir au nom d'un agent ni pour ouvrir un dossier : il faut en plus les secrets.

### Limites connues

- **Réseau.** Les agents d'une machine partagent son réseau : un serveur lancé par un agent sur `localhost:3000` est joignable par les autres.
- **Liste des processus.** `ps` montre les lignes de commande des autres agents, parce que `/proc` n'est pas monté en `hidepid`. Les secrets n'y passent jamais, mais une commande d'agent, si.
- **Disque.** Pas de quota par agent. L'usage par équipe est affiché dans le panneau.
- **Processus détachés.** Un `setsid`/`nohup` lancé hors des jobs survit à la commande. Il reste compté dans la limite de processus de l'agent et s'arrête avec la mise en pause de la machine.
- **Mode dry.** `MACHINE_DRY_RUN=1` ne sert qu'aux tests : il n'isole rien.

## Mise en route en local (Docker Desktop)

1. Docker Desktop démarré, puis `npm run dev:local`.
2. Dans FounderOS, onglet **Machines** d'un service : **Ajouter une machine**, puis **Créer une machine**. Le backend construit l'image `founderos/team-machine` si elle manque, lance le conteneur `founderos-tm-<id>` (port 8100 à 8199, volumes nommés, jeton généré) et suit sa création.
3. Vérifier l'isolement dans le conteneur :

   ```powershell
   docker exec founderos-tm-<id> node /opt/team-machine/src/selftest.mjs
   ```

   Le script crée une équipe jetable (sous `/tmp`, avec des uids à part), trois agents et un dossier protégé. Il vérifie notamment qu'un agent ne lit ni le dossier perso d'un autre, ni un dossier protégé sans son secret, ni l'état de la machine ; qu'il ne devient pas root ; qu'il ne tue pas les processus d'un autre ; et qu'une rotation ou un archivage coupe l'accès. Il nettoie derrière lui. Code de sortie 0 = tout passe.

4. Onglet **Attributions** : donner la machine à une équipe ou à un agent.

Réglages facultatifs de la création, dans `backend/.env.self` : `TEAM_MACHINE_IMAGE`, `TEAM_MACHINE_PORTS` (`8100-8199`), `TEAM_MACHINE_HOST` (`localhost`), `TEAM_MACHINE_CPUS`, `TEAM_MACHINE_MEMORY`.

Une machine lancée à la main (`team-machine/compose.yaml`, avec `TEAM_MACHINE_TOKEN` côté conteneur) se branche avec **Brancher une machine** : son adresse (`http://localhost:8091`) et ce même jeton.

Utiliser des **volumes nommés**, comme dans le compose fourni. Un dossier Windows monté ignore `chown` et les droits Unix : l'isolement tomberait avec.

## Installation on-prem (VM, docker compose)

L'installateur génère `TEAM_MACHINE_TOKEN` dans le `.env` : c'est le jeton **du conteneur** de la machine, le backend ne le lit pas. Pour activer la machine :

1. Lancer avec le profil :

   ```bash
   docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env --profile team-machine up -d
   ```

2. Dans FounderOS, onglet **Machines** : **Brancher une machine**, adresse `http://team-machine:8080`, et le jeton du `.env`.

La machine ne publie aucun port : seul le backend lui parle, par le réseau interne.

## Variables

Côté machine :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MACHINE_TOKEN` | (requis) | Clé HMAC partagée avec la plateforme, 32 caractères au moins |
| `MACHINE_ALLOW_APT` | `0` | `1` : les agents peuvent demander des paquets apt |
| `MACHINE_MAX_PROCS` | `512` | Processus et threads par agent |
| `MACHINE_MAX_FILE_MB` | `2048` | Taille maximale d'un fichier écrit |
| `MACHINE_MAX_MEM_MB` | `0` | Mémoire virtuelle par processus (`0` = pas de limite ; Node et les JVM réservent beaucoup) |
| `MACHINE_EXEC_MAX_SECONDS` | `600` | Durée maximale d'une commande |
| `MACHINE_JOB_MAX_HOURS` | `12` | Durée de vie d'un job de fond |
| `MACHINE_JOBS_PER_AGENT` | `8` | Jobs de fond simultanés par agent |

Côté plateforme : aucune variable. L'adresse et le jeton de chaque machine sont en base (le jeton chiffré). En auto-hébergé, la création à la demande se règle avec `TEAM_MACHINE_IMAGE`, `TEAM_MACHINE_PORTS`, `TEAM_MACHINE_HOST`, `TEAM_MACHINE_CPUS` et `TEAM_MACHINE_MEMORY`, tous facultatifs.

## Exploitation

| Besoin | Geste |
| --- | --- |
| Un agent n'a plus accès (« identité ne correspond plus ») | Panneau Machine → l'agent → **Réinitialiser son identité**. Ses fichiers restent les siens. |
| Doute sur qui a eu accès à un dossier | Retirer les membres en trop, puis **Renouveler le secret**. |
| Récupérer un dossier archivé | `docker exec <conteneur> ls /teams/<équipe>/.archives`, puis `docker cp`. |
| Machine recréée, volume d'état perdu | Rien à faire : au premier appel, l'équipe, l'agent et ses dossiers protégés se redéclarent avec leurs secrets. Les dossiers reviennent vides : seul le volume `/teams` contenait les fichiers. |
| Tout arrêter pour une équipe | **Mettre en pause** : les outils `team_*` disparaissent, les processus s'arrêtent, les fichiers restent. |

## Tests

- `team-machine` : `npm test` (signatures, nonces, état, secrets, principal, opérations de fichiers, serveur HTTP). Ces tests tournent hors Linux.
- Backend :
  - `src/shared/team-machine.test.ts` : noms, vecteur de signature partagé avec la machine, intégration dans la boîte à outils.
  - `src/shared/team-machine.e2e.test.ts` : PGlite avec toutes les migrations, plus le vrai superviseur en mode dry. On y vérifie que seuls les membres présentent un secret, que retrait, rotation et archivage prennent effet à l'appel suivant, qu'aucun secret ne sort dans les réponses d'outils ni dans l'API, que RLS bloque les écritures et les secrets, et que l'auto-réparation fonctionne.
- Isolement réel : `selftest.mjs`, dans le conteneur.
