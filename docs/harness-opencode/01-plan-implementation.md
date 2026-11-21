# Harnais OpenCode dans le backend local : plan d'implémentation

Base étudiée : `opencode/` à la racine du dépôt, OpenCode **2.3.0** (commit `656c273`, 21/11/2026), licence MIT. Paquets npm utilisés : `@opencode/sdk` et `@opencode/plugin` **2.3.2**, version épinglée.

## 1. La décision

- **Option A retenue :** le SDK d'OpenCode est embarqué dans un processus Node, et FounderOS s'y branche par des plugins.
- **Ce processus est le backend local (`backend/`)**, et le harnais n'existe **qu'en `PLATFORM=self`**. En `PLATFORM=supabase` (le cloud actuel), rien ne change : l'ancien moteur reste en place.
- Ensuite, **FounderOS passe en mode local** : le front pointe sur le backend local, avec la base, l'auth, le stockage et le temps réel servis par lui (voir `02-plan-migration.md`).

Ce choix tombe juste, parce qu'en `PLATFORM=self` le backend est **un seul processus Node long-vivant**. Il sert déjà les edge functions portées (`backend/src/edge`), le cron et les requêtes HTTP sortantes (`src/platform/workers.ts`), et l'API Supabase sur Postgres ou PGlite. OpenCode exige exactement ça : une session s'exécute dans un seul processus qui dure, avec un disque. Il n'y a donc pas de service supplémentaire à héberger.

```
 Front (React, supabase-js)
   │  /rest/v1  /auth/v1  /storage/v1  /realtime/v1  /functions/v1
   ▼
 backend/  (PLATFORM=self, un seul processus Node)
   ├─ src/platform/        API Supabase sur Postgres / PGlite, cron, net
   ├─ src/edge/            edge functions portées (ancien moteur, inchangé)
   └─ src/harness/         NOUVEAU : harnais OpenCode
        ├─ host.ts         OpenCode.create({ database, plugins, instances })
        ├─ route.ts        intercepte internal-agent-run / -approve si l'agent est en « opencode »
        └─ plugins/        agents, modèles, outils, gouvernance, contexte, contrat, pont
            │
            └─ pont ──▶ mêmes tables (runs, événements, messages, approbations) ─▶ temps réel local ─▶ front
   STORAGE_DIR/opencode/opencode.db   état d'exécution d'OpenCode (SQLite)
   STORAGE_DIR/agents/<agent_id>/     dossier de travail de chaque agent
```

## 2. Ce que l'essai du 21/11 a validé

Essai dans un dossier jetable, sous Node 24.14 / Windows :

| Point | Résultat |
|---|---|
| Installation npm de `@opencode/sdk@2.3.2` | OK : 381 paquets, binaire PTY Windows inclus, en 2 min |
| Démarrage d'un hôte embarqué, base SQLite sur disque | OK en **0,46 s**, avec le SQLite intégré à Node (avertissement « experimental » sous Node 24, sans conséquence) |
| Plugin FounderOS qui ajoute un outil (API Promise) | OK |
| Session dans un dossier, avec métadonnées et modèle OpenRouter | OK |
| Tour complet : file d'entrée, étape, appel au fournisseur, nouvelle tentative programmée, échec propre | OK jusqu'au fournisseur. **Bloqué par OpenRouter** : quota quotidien de modèles gratuits épuisé (429 `free-models-per-day`) |
| Appel de l'outil par le modèle | **Non vérifié**, à cause du quota |

**Phase 0, faite le 21/11 sur la branche `harness-opencode`** : `backend/src/harness/host.ts` et `host.test.ts`. Quatre tests passent, contre une fausse passerelle compatible OpenAI.
- Le modèle appelle un outil FounderOS, en reçoit le résultat, puis répond.
- Une action sous règle `ask` est refusée avec une consigne : l'outil ne part pas, et le modèle reçoit la consigne.
- Après un arrêt du backend pendant un outil, la session reprend seule au redémarrage, et le modèle apprend que l'appel a été interrompu.
- Les dossiers d'agent ne peuvent pas sortir de `agents/`.

Le backend démarre en `PLATFORM=self` avec `HARNESS_OPENCODE=1`. OpenCode est prêt en 17 s au premier démarrage (chargement du catalogue de modèles), et `npm test` reste vert (615 tests).

Trois enseignements pour la suite :
- **Code Mode par défaut :** un outil de plugin n'est appelable directement que s'il est déclaré avec `options: { codemode: false }`. Sinon, il n'est accessible qu'à travers l'outil `execute` (Code Mode).
- **Requêtes de titre :** OpenCode envoie une requête annexe pour titrer chaque session. Elle compte dans la consommation, et le pont devra la distinguer des tours d'agent.
- **Permissions natives :** `permission.reply` avec `decision: "reject"` et un `message` donne le refus avec consigne sans aucun code de notre côté.

Reste à vérifier :
- **Un tour complet avec outil**, une fois le compte OpenRouter crédité : 5 $ débloquent 1 000 requêtes gratuites par jour, ou on passe en modèles payants.
- **Le message de journal « failed to load OpenCode provider config »** : OpenCode cherche sa configuration en ligne. C'est probablement inoffensif, mais à couper par la configuration si possible.
- **Un paquet d'interface terminal (`@opentui/core`) réclame Node 26.** Il n'est pas chargé par l'hôte embarqué, mais il faut le confirmer dans le backend.

## 3. Ce qui constitue le harnais d'OpenCode

### Ce qu'on prend (via npm)

| Source (`opencode/packages/…`) | Rôle | Remplace dans FounderOS |
|---|---|---|
| `sdk` | Hôte embarqué, API Promise, instances par clé | — (point d'entrée de `src/harness/host.ts`) |
| `core/src/session/` + `runner/` | Boucle d'agent : file d'entrée (steer/queue), étapes, flux, outils lancés en cours de flux, arrêt coopératif, relances, reprise après crash, sous-agents | Le moteur de ticks d'`internal-agent-run`, `runToolRounds`, `ToolScheduler`, `subagents.ts`, `background-agents.ts`, `call-ledger.ts` |
| `core/src/session/compaction.ts` | Résumé structuré, calculé en arrière-plan | `compactMessagesIfNeeded`, `context-checkpoint.ts` |
| `core/src/tool*`, `core/src/tool/plugin/` | Registre, validation, troncature avec sortie complète conservée ; outils read, write, edit, grep, glob, shell, patch, webfetch, websearch, todo, question, skill, subagent | La boucle d'exécution d'`ai.ts`, et une partie des outils internes |
| `core/src/permission*` | allow / ask / deny, approbation, refus avec consigne, règles du travail sans humain présent | Le socle des approbations (PolicyGuard s'y branche) |
| `core/src/mcp/` | Client MCP | `mcp-client.ts` |
| `ai` | Client LLM, 50 fournisseurs, dont OpenRouter, Azure, Anthropic et TypeSafe (Jev) | `ai.ts`, `llm-upstream.ts` pour la boucle d'agent |
| `plugin` | API des plugins | — |

Lectures de référence : `opencode/specs/v2/session.md`, `tools.md`, `event-stream-architecture.md`, `provider-policy.md`, `packages/plugin/src/README.md`, `packages/sdk/README.md`. Le dossier `opencode/` reste une **référence de lecture**, pas une dépendance.

### Ce qu'on laisse

Les interfaces d'OpenCode (`tui`, `app`, `desktop`, `cli`, `ui`, `gui-plugins`, `theme`, `session-ui`, `stories`…) et ses services (`services/*`).

## 4. Correspondance FounderOS → OpenCode

| FounderOS | OpenCode | Plugin |
|---|---|---|
| Agent (`internal_agents`) | `Agent.Info` : system, steps, permissions, model | **agents** (`ctx.agent.transform`, prompt repris de `buildSystemPrompt`) |
| Conversation de chat | Une session par conversation | **pont** (métadonnées `workspace_id`, `agent_id`, `conversation_id`) |
| Run de mission | Une session par run | **pont** |
| Message envoyé en cours de run | Inbox `steer` | natif |
| Paliers léger, moyen, lourd ; `model_routes` ; connecteurs AI Ops ; AgentPilot | Fournisseurs (`ctx.provider.transform`) + hook `model.resolve` | **modèles** |
| Outils internes (`internal-agent-tools.ts`) | Outils de plugin (`ctx.tool.transform`) | **outils** : adaptateur générique schéma JSON → outil, autour de l'exécuteur actuel (déjà porté sous Node) |
| Fichiers, shell, todo, ask_user, skills, sous-agents | Outils intégrés | natif (on retire les doublons FounderOS) |
| Approbations, PolicyGuard, règles G3, autonomie | Permissions + hook `permission.evaluate` + `permission.reply` | **gouvernance** |
| Garde-fous (regex + Jev) | Hooks `tool.execute.before/after` et `session.context` | **gouvernance** |
| Mémoire, préférences, entreprise, skills, graphe | Instructions, `ctx.skill.transform`, outils | **contexte** |
| Contrat de succès, affirmations non prouvées | Hook `session.experimental.idle` | **contrat** |
| Timeline, messages, texte en direct, coûts | Événements (`ctx.event.subscribe`) | **pont** : écrit dans les tables actuelles ; le temps réel local les pousse au front |

## 5. Le module `backend/src/harness/`

```
backend/src/harness/
  host.ts          crée l'hôte au démarrage (PLATFORM=self et HARNESS_OPENCODE=1),
                   le ferme à l'arrêt ; base dans STORAGE_DIR/opencode/
  route.ts         monté dans app.ts AVANT edgeRouter (après la vérification JWT) :
                   POST /functions/v1/internal-agent-run     → harnais si agent.harness = 'opencode'
                   POST /functions/v1/internal-agent-approve → permission.reply si l'approbation vient d'OpenCode
                   sinon next() : l'ancien moteur répond, comme aujourd'hui
  tenancy.ts       clé d'instance = agent_id ; vérifie session ↔ workspace à chaque appel
  plugins/
    agents.ts  models.ts  tools.ts  governance.ts  context.ts  contract.ts  bridge.ts
  *.test.ts        tests (node:test, comme le reste du backend)
```

Points de conception :
- **Aucune modification des fichiers générés** (`src/edge` est régénéré par `port:edge`). L'aiguillage se fait par une route Express placée devant.
- **Accès à la base :** le pont et les plugins utilisent le client Supabase de service, comme le code porté. En mode local, ce client parle au backend lui-même, donc à la même base Postgres ou PGlite.
- **Isolation :** la clé d'instance est l'`agent_id`. La documentation d'OpenCode précise que l'instance n'est pas une frontière de sécurité : `tenancy.ts` vérifie l'appartenance d'une session à l'espace de travail de l'appelant.
- **Le shell et les fichiers tournent sur la machine qui héberge le backend.** En local, c'est ta machine : l'agent est enfermé dans son dossier, et toute commande shell ou écriture hors du dossier est en `ask` (approbation) par défaut. Pour passer ensuite par la machine d'équipe Docker, il faudra un `WorkspaceDriver` (phase 6).

## 6. Phases

### Phase 0 : faisabilité dans le backend (3 jours)
- Ajouter `@opencode/sdk` et `@opencode/plugin` (versions exactes) à `backend/package.json`, et créer `src/harness/host.ts` derrière `HARNESS_OPENCODE=1`.
- Un tour complet avec outil sur OpenRouter (compte crédité), une permission `ask` répondue, une reprise après arrêt brutal du backend.
- Vérifier que le backend démarre toujours en `PLATFORM=supabase` sans charger OpenCode (import dynamique).
- **Sortie :** démo locale, et `npm test` toujours vert.

### Phase 1 : aiguillage et pont (1,5 semaine)
- Migration `0307_agent_harness.sql` : `internal_agents.harness` (`legacy` | `opencode`, défaut `legacy`).
- `route.ts` monté dans `app.ts` ; plugin **pont** : `internal_agent_runs` (statut, coût, tokens), `internal_agent_run_events` (format lu par `RunTimeline`), `internal_agent_messages`, `live_output`, `logLlmUsage`.
- **Sortie :** un chat sans outil FounderOS s'affiche dans le front local comme aujourd'hui.

### Phase 2 : agents et modèles (1 semaine)
- Plugins **agents** et **modèles** : OpenRouter et connecteurs AI Ops, paliers par agent et par connecteur, AgentPilot.
- **Sortie :** « Ops Sentinel » répond sur son modèle moyen et passe sur Claude Opus pour une tâche lourde.

### Phase 3 : outils (2 à 3 semaines)
- Adaptateur générique pour les outils internes ; on garde les outils intégrés d'OpenCode pour les fichiers, le shell, la checklist, les questions, les skills et les sous-agents ; Composio et MCP passent par le client MCP natif quand c'est possible.
- **Sortie :** `npm run eval` sur le nouveau harnais, au moins au niveau de l'ancien.

### Phase 4 : gouvernance (1 à 2 semaines)
- Plugin **gouvernance** : règles par agent, PolicyGuard, garde-fous, règles `Unattended` pour les missions planifiées.
- **Sortie :** les tests d'approbation et de garde-fous rejoués sur le harnais.

### Phase 5 : contexte et contrat (1 à 2 semaines)
- Plugins **contexte** et **contrat**.
- **Sortie :** un run dont le contrat échoue reprend tout seul, puis se termine contrat vérifié.

### Phase 6 : extensions (selon les besoins)
- `WorkspaceDriver` vers la machine d'équipe Docker, Code Mode, plugin `goal`.

### Phase 7 : exploitation locale (3 jours)
- Sauvegarde de `STORAGE_DIR/opencode` en même temps que la base locale ; traces OpenTelemetry ; arrêt propre du backend (fermeture de l'hôte, reprise des sessions au redémarrage).

**Total : environ 8 à 11 semaines pour une personne**, phase 6 non comprise.

## 7. Risques

| Risque | Parade |
|---|---|
| OpenCode évolue vite (v2, API « experimental », dont le hook `idle`) | Version exacte, montée volontaire avec les évals en garde-fou, API publique seulement |
| Effect v4 | Plugins écrits avec l'API Promise |
| Le shell de l'agent tourne sur la machine hôte | Dossier par agent, `ask` par défaut hors du dossier, puis `WorkspaceDriver` vers Docker |
| Deux bases : SQLite (OpenCode) et Postgres ou PGlite (FounderOS) | Postgres reste la source de vérité métier, via le pont ; SQLite ne tient que l'état d'exécution ; même sauvegarde |
| Quota OpenRouter gratuit (déjà atteint le 21/11) | Créditer le compte, ou des routes payantes pour les agents qui comptent |
| Le backend devient plus lourd au démarrage | Import dynamique : rien n'est chargé hors `PLATFORM=self` et `HARNESS_OPENCODE=1` |

## 8. Décisions à prendre

1. **OpenRouter :** créditer le compte (5 $ pour 1 000 requêtes gratuites par jour), ou basculer les agents importants sur des modèles payants.
2. **Outils FounderOS à abandonner** au profit des outils intégrés (liste en phase 3).
3. **Shell local :** l'accepter sous approbation en local, ou attendre le pilote Docker (phase 6) avant d'ouvrir le shell aux agents.
