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

Les règles :

- **Une machine** = une ligne de `machines`. Sans adresse, c'est la machine de la plateforme (`app_config.team_machine_url`, puis `TEAM_MACHINE_URL`). Avec une adresse, elle doit être publique (contrôle SSRF).
- **Son jeton** : celui de la plateforme (`TEAM_MACHINE_TOKEN`) par défaut, ou un jeton propre, chiffré dans `team_machine_secrets` (kind `machine`) et jamais réaffiché.
- **Une attribution** reste une ligne de `team_machines`, qui gagne `machine_id`, `scope` (`team` ou `agent`) et `agent_id`. Un agent seul est une « équipe d'un » dont l'id est `agent-<uuid>`.
- **Changer de machine** ne déplace pas les fichiers. L'équipe repart d'un dossier vide sur la nouvelle, avec les mêmes agents et les mêmes dossiers protégés (redéclarés au premier appel). L'ancienne garde ce qu'elle avait.
- **Mettre une machine en pause** retire les outils `team_*` à tous ceux qui l'utilisent et suspend leurs équipes sur la machine. Une machine utilisée ne se supprime pas.
- **L'activité** ne montre que les équipes de l'espace qui la demande : une machine de plateforme peut servir plusieurs espaces. Le superviseur rend les commandes (`ps` les montre déjà aux agents), jamais un journal ni un fichier. Pour lire, il faut passer par un agent et ses secrets.

Le superviseur 0.2.0 ajoute deux opérations d'administration : `machine.info` (version, hôte, charge, mémoire, disque, limites) et `activity` (processus et jobs des équipes demandées).

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

La plateforme signe chaque appel (HMAC-SHA256 de `TEAM_MACHINE_TOKEN`, horodatage à ±120 s, nonce à usage unique). Ce jeton permet d'administrer la machine (créer, suspendre, archiver). Il **ne suffit pas** pour agir au nom d'un agent ni pour ouvrir un dossier : il faut en plus les secrets.

### Limites connues

- **Réseau.** Les agents d'une machine partagent son réseau : un serveur lancé par un agent sur `localhost:3000` est joignable par les autres.
- **Liste des processus.** `ps` montre les lignes de commande des autres agents, parce que `/proc` n'est pas monté en `hidepid`. Les secrets n'y passent jamais, mais une commande d'agent, si.
- **Disque.** Pas de quota par agent. L'usage par équipe est affiché dans le panneau.
- **Processus détachés.** Un `setsid`/`nohup` lancé hors des jobs survit à la commande. Il reste compté dans la limite de processus de l'agent et s'arrête avec la mise en pause de la machine.
- **Mode dry.** `MACHINE_DRY_RUN=1` ne sert qu'aux tests : il n'isole rien.

## Mise en route en local (Docker Desktop)

1. Choisir un jeton de 32 caractères au moins, et le poser des deux côtés :

   ```powershell
   $env:TEAM_MACHINE_TOKEN = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
   docker compose -f team-machine/compose.yaml up -d --build
   supabase secrets set "TEAM_MACHINE_TOKEN=$env:TEAM_MACHINE_TOKEN" --project-ref <ref>
   ```

2. Vérifier l'isolement dans le conteneur :

   ```powershell
   docker exec team-machine node /opt/team-machine/src/selftest.mjs
   ```

   Le script crée une équipe jetable (sous `/tmp`, avec des uids à part), trois agents et un dossier protégé. Il vérifie notamment qu'un agent ne lit ni le dossier perso d'un autre, ni un dossier protégé sans son secret, ni l'état de la machine ; qu'il ne devient pas root ; qu'il ne tue pas les processus d'un autre ; et qu'une rotation ou un archivage coupe l'accès. Il nettoie derrière lui. Code de sortie 0 = tout passe.

3. Exposer la machine aux fonctions cloud. Ajouter un tunnel à `ngrok.yml` :

   ```yaml
   team-machine:
     proto: http
     addr: 8091
   ```

   `scripts/start-agents-infra.ps1` démarre ensuite le conteneur s'il existe, repère le tunnel vers `:8091` et écrit `app_config.team_machine_url`, que la plateforme relit à chaque run.

4. Dans FounderOS, ouvrir **Machine** sur la carte d'une équipe, puis **Donner une machine à l'équipe**.

Utiliser des **volumes nommés**, comme dans le compose fourni. Un dossier Windows monté ignore `chown` et les droits Unix : l'isolement tomberait avec.

## Installation on-prem (VM, docker compose)

L'installateur génère `TEAM_MACHINE_TOKEN` dans le `.env`. Pour activer la machine :

1. Ajouter `TEAM_MACHINE_URL=http://team-machine:8080` au `.env`.
2. Lancer avec le profil :

   ```bash
   docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env --profile team-machine up -d
   ```

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

Côté plateforme :

| Variable | Rôle |
| --- | --- |
| `TEAM_MACHINE_TOKEN` | Le même jeton que `MACHINE_TOKEN` |
| `TEAM_MACHINE_URL` | L'URL de la machine. `app_config.team_machine_url` l'emporte s'il est posé ; une URL propre à une équipe (réservée aux owners et admins, contrôlée contre le SSRF) l'emporte sur les deux. |

## Exploitation

| Besoin | Geste |
| --- | --- |
| Un agent n'a plus accès (« identité ne correspond plus ») | Panneau Machine → l'agent → **Réinitialiser son identité**. Ses fichiers restent les siens. |
| Doute sur qui a eu accès à un dossier | Retirer les membres en trop, puis **Renouveler le secret**. |
| Récupérer un dossier archivé | `docker exec team-machine ls /teams/<équipe>/.archives`, puis `docker cp`. |
| Machine recréée, volume d'état perdu | Rien à faire : au premier appel, l'équipe, l'agent et ses dossiers protégés se redéclarent avec leurs secrets. Les dossiers reviennent vides : seul le volume `/teams` contenait les fichiers. |
| Tout arrêter pour une équipe | **Mettre en pause** : les outils `team_*` disparaissent, les processus s'arrêtent, les fichiers restent. |

## Tests

- `team-machine` : `npm test` (signatures, nonces, état, secrets, principal, opérations de fichiers, serveur HTTP). Ces tests tournent hors Linux.
- Backend :
  - `src/shared/team-machine.test.ts` : noms, vecteur de signature partagé avec la machine, intégration dans la boîte à outils.
  - `src/shared/team-machine.e2e.test.ts` : PGlite avec toutes les migrations, plus le vrai superviseur en mode dry. On y vérifie que seuls les membres présentent un secret, que retrait, rotation et archivage prennent effet à l'appel suivant, qu'aucun secret ne sort dans les réponses d'outils ni dans l'API, que RLS bloque les écritures et les secrets, et que l'auto-réparation fonctionne.
- Isolement réel : `selftest.mjs`, dans le conteneur.
