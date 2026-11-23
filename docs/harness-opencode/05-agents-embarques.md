# Agents embarqués : analyse et plan

Un **agent embarqué** est un agent conçu dans FounderOS, puis construit en une image de conteneur qui contient tout ce qu'il lui faut pour travailler seul : le harnais OpenCode, les plugins FounderOS, sa configuration figée, ses outils, ses skills et son propre système de fichiers. L'image tourne où l'on veut (poste, serveur du client, VM cloud, machine près des données) et reste **pilotée et surveillée depuis FounderOS**.

## 0. Fait le 23/11/2026 (E0 à E2, en local)

Un agent embarqué est la **troisième sorte d'agent**, à côté des collaborateurs internes et publics : un `internal_agents` avec `deployment = 'embedded'`. Ses consignes, pools, skills et modèles se règlent sur sa fiche comme pour un collaborateur ; seul l'endroit où il tourne change.

| Pièce | Où |
|---|---|
| Base : `deployment`, réglages, versions, instances, clés (sha256), ordres ; `internal_agent_runs.instance_id` | `supabase/migrations/0316_embedded_agents.sql` |
| Le manifeste (profil, outils des pools sans `team_*`, skills, machine, modèle) et son empreinte | `backend/src/embedded/manifest.ts` |
| L'archive : Dockerfile, compose.yaml, .env.example sans clé, manifest.json, README, `workspace/` | `backend/src/embedded/bundle.ts` |
| La passerelle `/embedded/v1` (clé d'API) : hello, heartbeat, manifest, tools, tools/call (pools, garde-fous, mémoire de recherche), search, llm (proxy et crédits), store (borné à l'agent, selon `sync_level`), commands | `backend/src/embedded/gateway.ts` |
| Le SDK FounderOS (`new FounderOS({ url, apiKey })` : tools, connectors, deliverables, memory, knowledge, commands) | `backend/src/embedded/sdk.ts` |
| Le moteur dans le conteneur : OpenCode et les plugins FounderOS, outils de la plateforme par le SDK, shell dans `/workspace`, boucle d'ordres, battement toutes les 15 s | `backend/src/embedded/runtime.ts`, `embedded/Dockerfile` (image `founderos/agent-runtime`) |
| Construire et lancer sur le Docker de l'hôte (plateforme auto-hébergée) | `backend/src/platform/embedded-docker.ts` |
| La fonction : list, create, update_config, export, create_key, revoke_key, command, run_local, stop_local | `backend/src/edge/embedded-agents/index.ts` |
| Un chat ou une mission d'un agent embarqué : préparé par la plateforme (garde-fous, contexte, contrat), confié à l'instance par un ordre `run` | `forwardToInstance` dans `backend/src/harness/runs.ts` |
| L'interface : onglet **Agents embarqués** (section Équipe), menu « Deploy collaborator », galerie « Agents embarqués » du roster | `src/features/embedded-agents/` |
| Test de bout en bout (PGlite) : manifeste, accès direct, archive, passerelle, clés, ordres | `backend/src/embedded/embedded.e2e.test.ts` |

**Limites connues :**
- Un run exécuté dans le conteneur suit le chemin par défaut du pont : il écrit le message de l'agent et le statut du run. Les finaliseurs côté plateforme (canaux, vérification du contrat) ne s'appliquent pas encore.
- Les salles, workflows et échanges entre agents sont refusés à un agent embarqué (409).
- La connaissance embarquée (instantané des collections) est réglable, mais l'instantané n'est pas encore copié dans l'image : la recherche passe par la passerelle.
- Le moteur (`founderos/agent-runtime`) se construit depuis le dépôt ; il n'est pas encore publié sur un registre.

## 1. Pourquoi c'est faisable maintenant

| Ce qui existe | Ce que ça apporte |
|---|---|
| Le harnais OpenCode tourne déjà **dans un processus Node long-vivant avec un disque** (`backend/src/harness/host.ts`) | C'est exactement ce qu'est un conteneur. Le cœur de l'agent embarqué est déjà écrit |
| Le toolkit passe par deux interfaces : `LegacyToolset { defs, run(name, args, signal) }` et `search` (grep) | Il suffit d'en écrire une version **distante** pour que les outils marchent hors de la plateforme, sans toucher aux façades |
| **Pools uniquement** (0310) : tout ce qu'un agent peut atteindre est une liste fermée | Cette liste est le manifeste de construction. Sans les pools, on ne saurait pas quoi mettre dans l'image |
| La machine d'équipe (`team-machine/`) : superviseur HTTP, signature HMAC, nonces, jobs, isolement Linux | Modèle d'authentification et de supervision à réutiliser |
| La flotte de machines (0304, section Machines) | Inscription, état, dernier contact, erreurs : la page de surveillance a déjà sa place |
| `internal_agent_runs` et `internal_agent_run_events` | Si l'agent embarqué y écrit ses runs, toutes les vues existantes (tableau de bord, runs, fiabilité) marchent sans changement |

**Différence avec la machine d'équipe :** la machine d'équipe est une paire de mains (le cerveau reste dans FounderOS et y envoie des commandes). L'agent embarqué emporte le cerveau et les mains ; FounderOS garde la conception, la gouvernance et la surveillance.

## 2. À quoi ça sert

1. **Sur site chez un client** (piste entreprise Generix) : les données et les conversations ne sortent pas, le LLM peut être celui du client (Azure privé, modèle local).
2. **Près des données** : un agent posé à côté d'un ERP, d'une base ou d'un système de fichiers qu'on ne veut pas exposer.
3. **Isolement** : un agent qui a le shell ou installe des paquets tourne dans sa boîte, pas sur l'hôte du backend.
4. **Produit** : un agent vendu ou livré comme une image versionnée, avec mises à jour depuis FounderOS.

## 3. Les questions de conception

### 3.1 Où s'exécutent les outils

| Classe | Exemples | Où | Comment |
|---|---|---|---|
| Locaux | lire, écrire, éditer, glob, shell, code | dans le conteneur | outils natifs d'OpenCode, dossier `/workspace` |
| Connaissance | `grep`, `build_context` | dans le conteneur, ou à distance | **instantané** de `search_index` limité aux collections de ses pools, embarqué dans l'image (SQLite ou PGlite), resynchronisable ; sinon appel distant |
| Plateforme | livrables, équipe, mission, mémoire partagée | à distance | **SDK FounderOS** (section 3.2), avec contrôle des pools côté plateforme |
| Applications | Composio, MCP, connecteurs maison | à distance par défaut | **SDK FounderOS** : **les secrets ne quittent jamais FounderOS**. Un serveur MCP sans secret peut être appelé en direct |

### 3.2 Le SDK FounderOS et la clé d'API

L'agent embarqué n'appelle pas FounderOS « à la main » : il embarque un **SDK FounderOS** (`@founderos/agent-sdk`), qui lui donne les outils de la plateforme comme s'ils étaient locaux, et une **clé d'API** propre à l'instance.

- **La clé d'API** (`FOUNDEROS_API_KEY`) est créée dans FounderOS pour une instance donnée, affichée une seule fois, hachée en base, révocable et renouvelable depuis la flotte. Elle porte l'identité de l'agent et la version de sa construction : la plateforme sait toujours **quel agent**, **quelle version** et **quels pools** sont derrière un appel. Elle est passée au conteneur par l'environnement au lancement, jamais écrite dans l'image.
- **Le SDK** expose les mêmes familles d'outils que le harnais du backend (les façades du toolkit : connecteurs et applications, livrables, mémoire, équipe, missions, recherche dans la connaissance), découvertes à la connexion depuis les pools de la construction. Chaque appel part signé avec la clé vers `/embedded/v1/tools/call` ; FounderOS déchiffre les secrets du connecteur, exécute l'action et renvoie le résultat. Le connecteur Slack, GitHub ou Composio de l'espace s'utilise donc depuis l'instance **sans qu'aucun jeton de connecteur n'y entre**.
- **Dans le harnais**, le SDK est simplement l'implémentation distante de l'interface que le toolkit utilise déjà (`LegacyToolset { defs, run }` et `search`) : les façades, les lots et `build_context` ne changent pas.
- **Hors du harnais**, le même SDK peut servir à un développeur qui écrit son propre code dans l'instance (un script, un service) : `const fos = new FounderOS({ apiKey })`, puis `fos.connectors.call("slack", "post_message", { … })`, `fos.knowledge.grep(…)`, `fos.deliverables.create(…)`. Les mêmes contrôles de pools s'appliquent.
- **Ce que la clé ne permet pas :** lire un secret, sortir des pools de la construction, agir pour un autre agent, ou administrer l'espace.

### 3.3 Le modèle de langage

| Mode | Effet |
|---|---|
| Via FounderOS (par défaut) | Clés centrales, crédits et coûts comptés comme aujourd'hui |
| Direct (point d'accès du client) | Données jamais vues par FounderOS ; l'instance déclare sa consommation (déclaratif, non vérifiable) |

### 3.4 Les modes de connexion

| Mode | Ce qui marche | Pour qui |
|---|---|---|
| **Connecté** (par défaut) | Tout, en temps réel | Cas général |
| Intermittent | Outils locaux et instantané ; événements mis en file et rejoués au retour du réseau ; les outils plateforme échouent proprement | Sites à réseau instable |
| Isolé | Outils locaux et instantané seulement ; journaux exportés en fichier puis importés dans FounderOS | Réseaux fermés |

### 3.5 Liaison avec FounderOS

L'agent embarqué **ouvre lui-même** la connexion vers FounderOS (WebSocket, ou HTTPS en attente longue en repli). Aucun port entrant n'est nécessaire, ce qui passe les NAT et les pare-feux clients.

- **Il envoie :** battement de cœur (version, empreinte du manifeste, santé, disque, mémoire), événements de run au format de `internal_agent_run_events`, consommation, journaux.
- **Il reçoit :** démarrer un run, message de chat, réponse à une approbation, pause, reprise, arrêt, mise à jour de configuration, demande de resynchronisation de l'instantané.

### 3.6 Identité et sécurité
- La **clé d'API de l'instance** (section 3.2) l'identifie. Révocation immédiate depuis FounderOS (arrêt d'urgence) ; la liaison échange cette clé contre un jeton de session de courte durée, renouvelé à chaque battement de cœur.
- Requêtes signées comme pour la machine d'équipe (HMAC, fraîcheur, nonces).
- **Aucun secret dans l'image** : ni clés LLM, ni jetons d'applications. L'image se partage sans risque.
- Image signée (cosign) avec sa liste de composants (SBOM).
- Conteneur durci : utilisateur non root, système de fichiers en lecture seule sauf `/workspace` et `/data`, limites CPU et mémoire, sortie réseau restreinte à FounderOS, au LLM et aux hôtes déclarés par les pools.
- La plateforme refuse tout appel du SDK hors des pools de la version construite, même si l'instance est compromise.

### 3.7 Versions et mises à jour

| Changement | Effet |
|---|---|
| Instructions, règles, modèle | **à chaud** : poussé par la liaison, enregistré comme nouvelle révision |
| Pools, outils, skills, version du harnais | **nouvelle construction** : image versionnée, déploiement, retour arrière possible |

L'empreinte du manifeste envoyée à chaque battement de cœur signale toute dérive entre ce que FounderOS croit et ce qui tourne.

### 3.8 Données et conversations

La session vit dans l'instance (`/data/opencode.db`). Le niveau de synchronisation vers FounderOS se choisit à la construction :
- **complet** : messages et événements, comme un agent interne ;
- **résumé** : événements, titres et résumés de runs, sans le contenu ;
- **métadonnées** : statut, durées, coûts, erreurs seulement (sur site strict).

## 4. Architecture

```
FounderOS (backend)                                  Instance (conteneur)
┌──────────────────────────────┐                     ┌──────────────────────────────────┐
│ Assistant « Embarquer »      │                     │ superviseur (santé, mises à jour)│
│ Compilateur de manifeste     │── image signée ───▶ │ hôte OpenCode (host.ts)          │
│ Constructeur d'image         │                     │ plugins : agent, toolkit         │
│ Passerelle /embedded/v1      │◀── liaison sortante │   LegacyToolset distant ─────────┼──┐
│   battement, événements,     │    (WebSocket)      │   grep sur instantané local      │  │
│   outils, LLM, commandes     │                     │ /workspace  /data  /knowledge    │  │
│ Flotte : instances, runs     │                     └──────────────────────────────────┘  │
└──────────────────────────────┘◀──────────────── appels d'outils plateforme ─────────────┘
```

### 4.1 Le manifeste

Produit par le compilateur depuis l'agent, ses pools, ses skills, ses règles et son profil. Il est immuable, et son empreinte identifie la version.

```json
{
  "manifest_version": 1,
  "agent": { "id": "…", "name": "…", "instructions": "…", "language": "fr" },
  "harness": { "opencode": "2.3.2", "toolkit": "…", "plugins": ["agent", "toolkit", "governance"] },
  "model": { "route": "founderos", "tiers": { "fast": "…", "smart": "…" } },
  "resources": { "pools": ["…"], "tools": ["…"], "collections": ["…"], "apps": ["…"] },
  "skills": [{ "slug": "…", "path": "skills/….md" }],
  "permissions": { "rules": ["…"], "unattended": "deny" },
  "connectivity": "connected",
  "sync": "full",
  "limits": { "cpus": 2, "memory_mb": 2048, "disk_mb": 4096 },
  "egress": ["…"]
}
```

### 4.2 L'image
- **Image de base** `founderos/agent-runtime:<version du harnais>` : Node, OpenCode SDK, plugins FounderOS, superviseur. Construite une fois par version.
- **Couche agent** : `manifest.json`, skills, fichiers d'amorce de `/workspace`, instantané de connaissance. Petite et rapide à construire.

### 4.3 Base de données (migration à numéroter, provisoire)

| Table | Rôle |
|---|---|
| `embedded_agent_builds` | agent, version, manifeste, empreinte, référence d'image, statut, SBOM, journal de construction, auteur |
| `embedded_agent_instances` | construction, machine (lien vers `machines`), nom, statut, dernier contact, version et empreinte annoncées, métriques |
| `embedded_agent_api_keys` | clés d'API d'instance (SDK FounderOS) : empreinte, préfixe affichable, instance, construction, création, dernier usage, révocation |
| `embedded_agent_commands` | file des commandes vers une instance, avec accusé de réception |
| `internal_agent_runs.instance_id` | colonne ajoutée : un run sait sur quelle instance il a tourné |

### 4.4 Dans l'interface
- **Sur la page de l'agent, section « Embarquer »** : cible (Docker, Kubernetes, machine isolée), mode de connexion, route du modèle, niveau de synchronisation, ressources (aperçu des pools figés), fichiers d'amorce, limites. Puis « Construire ».
- **Onglet « Constructions »** : versions, statut, journal, empreinte, téléchargement de l'image ou de la commande `docker run`.
- **Section Machines, flotte** : les instances à côté des machines, avec état en direct, version, dérive signalée, runs, coûts, approbations en attente, journaux, et les commandes pause, reprise, arrêt, mise à jour, révocation.

## 5. Prérequis

1. **R0 du plan de retrait** (`04-retrait-ancien-moteur.md`) : `prepareAgentToolset` et le contexte d'outil sortis de `internal-agent-run`. Sans ça, impossible de séparer les outils de la base.
2. **R2 (gouvernance dans un plugin)** avant toute instance sans surveillance : sinon une instance pourrait agir sans approbation.
3. Le toolkit doit pouvoir démarrer **sans accès direct à la base** : `Kit.legacy` et `Kit.search` injectés, ce qui est déjà le cas dans la structure actuelle.

## 6. Les phases

### E0 : preuve de concept (4 jours)
- Paquet `embedded-runtime/` : lance `host.ts` et les plugins à partir d'un `manifest.json`.
- Premier jet du **SDK FounderOS** (`packages/agent-sdk/`) : clé d'API, `tools.list`, `tools.call`, `knowledge.grep`, et son adaptateur `LegacyToolset` pour le toolkit.
- Côté FounderOS : création et révocation des clés d'API, routes `/embedded/v1/tools/list`, `/embedded/v1/tools/call` et `/embedded/v1/llm`.
- **Porte :** un conteneur local répond à un chat, appelle un outil plateforme, et le run apparaît dans FounderOS.

### E1 : liaison et surveillance (1,5 semaine)
- Inscription d'une instance par sa clé d'API, jeton de session, battement de cœur, événements écrits dans `internal_agent_run_events`.
- Instances visibles dans la flotte, avec statut et runs.
- **Porte :** couper le réseau de l'instance la fait passer « injoignable » ; la rebrancher rejoue les événements.

### E2 : construction (1 semaine)
- Compilateur de manifeste, construction de l'image (base plus couche agent), versions, signature.
- Assistant « Embarquer » et onglet « Constructions ».
- **Porte :** deux constructions successives d'un même agent donnent deux versions, avec retour arrière.

### E3 : pilotage et gouvernance (1 semaine)
- Approbations depuis FounderOS, pause, reprise, arrêt, révocation, mise à jour à chaud.
- **Porte :** une action à approuver bloque l'instance jusqu'à la réponse dans FounderOS ; une révocation coupe tout appel en moins de 30 secondes.

### E4 : modes de connexion (1 à 2 semaines)
- Instantané de connaissance et resynchronisation, file hors ligne, export et import des journaux en mode isolé.

### E5 : durcissement et distribution (1 semaine)
- Sortie réseau filtrée, SBOM, signature vérifiée au démarrage, quotas par instance, chart Helm.

**Total : environ 6 à 8 semaines**, après R0, et en parallèle de R3 à R5.

## 7. Risques

| Risque | Parade |
|---|---|
| Fuite de secrets par l'image | Aucun secret embarqué ; tout passe par la passerelle |
| Instance compromise qui dépasse ses droits | La passerelle applique les pools de la version, pas ceux que l'instance déclare |
| Dérive entre FounderOS et ce qui tourne | Empreinte du manifeste à chaque battement de cœur, alerte dans la flotte |
| Coûts non vérifiables en mode LLM direct | Affiché comme « déclaré » ; facturation au forfait par instance si besoin |
| Compatibilité entre versions du harnais et de la passerelle | API `/embedded/v1` versionnée ; l'instance annonce sa version, la passerelle refuse les versions trop anciennes |
| Instantané de connaissance périmé | Date de l'instantané visible ; resynchronisation planifiée ou à la demande |
| Le harnais embarqué dépend d'OpenCode (Effect v4, API expérimentales) | Même version figée que le backend, montée avec les évals |

## 8. Décisions à prendre

1. **Mode de connexion par défaut** : connecté seulement au départ, ou intermittent dès E1.
2. **Route du modèle** : via FounderOS seulement, ou direct dès le départ pour la piste sur site.
3. **Connaissance** : instantané embarqué (recommandé) ou toujours à distance.
4. **Niveau de synchronisation par défaut** : complet, résumé ou métadonnées.
5. **Où construire** : Docker local du backend, un constructeur dédié, ou la CI.
6. **Offre** : les instances comptent-elles dans les limites d'agents du plan, ou sont-elles facturées à part.
