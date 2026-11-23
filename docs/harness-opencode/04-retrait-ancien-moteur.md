# Retirer l'ancien moteur, ne garder que le harnais OpenCode

À lire avec `01-plan-implementation.md` et `02-plan-migration.md` (étape 5). Ce document détaille ce qu'il faut faire, dans quel ordre, et ce qu'on supprime.

## 0. Fait le 23/11/2026

L'ancien moteur est retiré du backend local. Le harnais OpenCode est le seul moteur d'agents, toujours démarré (`HARNESS_OPENCODE=0` l'éteint, les runs répondent alors 503). `supabase/functions/` est gelé : c'est la version de l'ancien cloud ; `backend/src/edge/` est la source.

**Le moteur** (`backend/src/harness/`)

| Fichier | Rôle |
|---|---|
| `runs.ts` | `startAgentRun` : le seul point d'entrée (chat, mission, salle, workflow, collègue). Garde-fous sur la demande, contexte du run, contrat de succès, consigne de mission, principal du tour, apprentissage sur la remarque de la personne. `runAndWait` pour qui attend la réponse |
| `route.ts` | `/functions/v1/internal-agent-run`, tous les modes : chat, mission, room_advance, mobile, design, knowledge_backfill ; `tick` est sans effet |
| `chat.ts` | Le tour sur OpenCode : session de la conversation (chat) ou session neuve (`startTaskRun`), réponse à une question de l'agent dans le même run |
| `lifecycle.ts` | La fin d'un run : contrat et preuves (relance dans le même run, deux fois au plus), garde du rapport, brouillon sauvé, initiatives, fin par mode (conversation et canaux, salle, mission avec Rédacteur, kanban, planning, retour A2A, workflow), graphe de connaissances, tour différé ; échec, annulation, question |
| `bridge.ts` | Les événements OpenCode vers la base, la liste de tâches de l'agent recopiée sur le run, les questions, le plafond de dépense ; les sous-agents écrivent dans le run parent |
| `guard.ts` | Les garde-fous : demande, appel d'outil, résultat d'outil |
| `ephemeral.ts` | Les boucles d'outils hors agents (cockpit, widget public, Rédacteur, vibe-code) sur OpenCode : `callToolLoop` remplace `callAiWithTools` |

**Ce que le moteur assemble** (`backend/src/agents/`) : `context.ts` (outils, pools, skills, MCP, machine, Composio), `prompt.ts` (prompt de l'agent et contexte du run, avec les outils du toolkit), `finalize.ts` (fins de run de l'ancien moteur, sorties telles quelles), `mission.ts` (consigne de mission), `extras.ts` (mobile, conception d'agent, graphe).

**Rebranchés sur `startAgentRun`** : salles (`room-orchestrator`, `service-room-post`), workflows (`workflow-engine`), messages entre agents (`internal-agent-a2a`), mobile. Les deux lancements de mission cassés (`create_mission` avec `start_now`, lancement d'un agent sur un work item) passent par `mission-launch.ts`. Le délai de l'ordonnanceur épargne les runs dont le harnais porte la session.

**Supprimé** : `internal-agent-run` (5 500 lignes), `subagents`, `background-agents`, `call-ledger`, `context-checkpoint`, `harness-hooks`, `run-tool-hooks`, `tool-error-diagnosis`, `tool-ranking`, la moitié « boucle » de `ai.ts` (de 2 545 à 1 347 lignes), `scripts/port-edge.mjs`, leurs tests. Migration `0313` (`internal_agent_runs.run_meta`) et `0314` (file de ticks, tables d'état, colonne `harness`).

**Gardés, contrairement au plan initial** : `prompt-compiler.ts` (sections et sélection, utilisées par le contexte et l'entreprise), `turn-principal.ts` (le principal d'un tour dans les canaux), `tool-arg-repair.ts` (lecture des appels de `callAi`), `agent-loop.ts` (le contrat ; ses fonctions de boucle ne sont plus appelées).

**Pas encore fait** : le plan d'exécution rédigé par un modèle avant le travail (l'agent pose lui-même sa liste avec `todowrite`, recopiée sur le run) ; la détection de boucle sémantique d'AgentPilot (OpenCode a la sienne) ; la mémoire des trouvailles de recherche (`createResearchMemory`) ; l'arrêt d'une mission quand son monde d'exécution est injoignable (une note dans le contexte du run, au lieu d'un échec).

## 1. Où on en est (22/11/2026)

Seul un cas passe aujourd'hui par OpenCode : un **tour de chat** (`mode: "chat"`) d'un agent dont `internal_agents.harness = 'opencode'`, en `PLATFORM=self` avec `HARNESS_OPENCODE=1` (`backend/src/harness/route.ts`). Tout le reste tourne encore sur l'ancien moteur :

| Chemin | Où vit l'ancien moteur |
|---|---|
| Missions, et leur reprise par ticks | `internal-agent-run` : `runMission`, `runMissionTick`, file `agent_run_ticks` (0095, 0096) |
| Chat des agents encore en `legacy` | `internal-agent-run` : `initChatRun`, `runChat` |
| Messages entre agents | `internal-agent-a2a`, avec sa propre boucle `callAiWithTools` |
| Missions planifiées | `internal-agent-scheduler`, qui appelle `internal-agent-run` |
| Salles de mission | `room_advance` dans `internal-agent-run`, `room-orchestrator.ts` |
| Workflows, automatisations | `workflow-engine.ts`, `automation-engine.ts`, qui appellent `internal-agent-run` |
| Canaux | `slack-gateway`, `teams-gateway`, `messaging-gateway`, `channel-approval.ts` |
| Reprise après approbation | `internal-agent-approve`, `approval-exec.ts` |
| Sous-agents, tâches de fond | `subagents.ts`, `background-agents.ts` |
| Mobile, conception d'agent, rattrapage de connaissances | modes `mobile`, `design`, `knowledge_backfill` de `internal-agent-run` |
| Boucles hors agents internes | `ai-agent-chat` (cockpit), `rag-chat` (widget public), `vibe-code`, `reporter.ts` |

Vingt-six fichiers appellent `internal-agent-run` directement (liste en annexe A).

**Point bloquant :** `backend/src/edge/` est **généré** depuis `supabase/functions/` par `backend/scripts/port-edge.mjs`. Supprimer du code dans `backend/src/edge/` sans toucher à la source serait écrasé au prochain `npm run port:edge` ; le supprimer dans `supabase/functions/` casse le cloud.

## 2. La décision préalable : couper le lien avec le cloud

| Option | Effet | Avis |
|---|---|---|
| **A. Le backend devient la source** | `supabase/functions/` est gelé (version cloud figée). On arrête `port:edge` pour les fonctions retouchées, puis complètement. Les suppressions se font dans `backend/src/edge/`. | **Recommandée.** C'est l'étape 4 du plan de migration (cloud gelé). |
| B. Supprimer dans les deux | Le cloud perd ses agents le jour du retrait. | À éviter tant que le cloud sert de filet. |

Concrètement : un commit qui retire l'en-tête « GÉNÉRÉ » des fichiers concernés, et un garde dans `port-edge.mjs` qui refuse d'écraser un fichier modifié à la main.

## 3. Ce qui reste (ce n'est pas le moteur)

| Garder | Pourquoi | Où le ranger |
|---|---|---|
| Les **exécuteurs** d'outils de `internal-agent-tools.ts` | Les façades du toolkit les appellent (`buildInternalToolset().allDefs`) | `backend/src/agents/tools/`, découpés par lot |
| `prepareAgentToolset`, `loadAgentAndTools`, `makeToolContext` | Le toolkit en dépend, et ils vivent aujourd'hui dans `internal-agent-run` | `backend/src/agents/toolset.ts` |
| Chargeurs de sections : mémoire, travail récent, mémoire d'équipe, entreprise, skills activés | Repris par le profil d'agent du plugin | `backend/src/agents/profile/` |
| `callAi` (appel ponctuel) et ses reprises | Résumés, extraction, briefings : ce n'est pas un harnais | `ai.ts`, allégé |
| `metering`, `llm-tracking`, `llm-pricing`, `model-router` | Crédits, coûts, routes de modèle | inchangés |
| `approval-policy`, `policyguard`, `guardrails` | Rebranchés dans le plugin gouvernance (phase 4) | inchangés |
| Orchestration métier : `room-orchestrator`, `mission-planning`, `team-life`, `self-model`, `workflow-engine`, `automation-engine` | Fonctionnalités, pas moteur : elles lancent des runs | inchangées, rebranchées sur `startAgentRun` |
| Tables `internal_agent_runs`, `internal_agent_run_events` | Le front les lit (25 et 12 fichiers) ; le pont y écrit déjà | inchangées |

## 4. Les phases

Chaque phase a une porte : `npm test` vert, `npm run eval` au moins au niveau de l'ancien moteur, et aucune régression visible dans le front.

### R0 : un seul point d'entrée pour lancer un agent (3 jours)
- `backend/src/harness/runs.ts` : `startAgentRun({ agentId, kind, input, conversationId?, missionId?, roomId?, principal, unattended? })`, avec `kind` parmi `chat`, `mission`, `a2a`, `room`, `workflow`, `channel`, `scheduled`.
- `route.ts` accepte tous les modes et appelle `startAgentRun` ; les 26 appelants passent par lui (en local, un appel de fonction et non plus un aller-retour HTTP).
- Extraction de `prepareAgentToolset`, `makeToolContext` et des chargeurs de sections hors de `internal-agent-run` (section 3).
- Tant qu'un agent est en `legacy`, `startAgentRun` délègue encore à l'ancien moteur : rien ne change pour l'utilisateur.

### R1 : les missions sur OpenCode (1,5 à 2 semaines)
- Une mission devient une session OpenCode durable. La reprise après crash d'OpenCode remplace la file de ticks : plus de `runMissionTick`, `kickTickDrainer`, `chainNextTick`.
- Le plan d'exécution (`produceExecutionPlan`) devient une consigne de démarrage plus `todowrite` ; les tâches de la mission se lisent depuis la checklist.
- `verifyMissionOutcome` et `salvageReportDraft` passent dans le plugin **contrat** (phase 5) : un run dont le contrat échoue reprend tout seul.
- Les finalisations (`finalizeMissionSuccess`, rapport vers le canal, todos, blocs UI) sont faites par le pont à la fin de session.
- `internal-agent-scheduler` devient une tâche du cron local qui appelle `startAgentRun({ kind: "scheduled", unattended: true })`.

### R2 : gouvernance et approbations (1 à 2 semaines, phase 4)
- Plugin gouvernance : règles par agent, PolicyGuard, garde-fous, règles `unattended` pour les missions planifiées.
- Approbation liée au vrai `runId` ; `internal-agent-approve` et `channel-approval.ts` répondent à la permission OpenCode en attente au lieu de relancer l'ancien moteur.
- Persistance du lot ouvert et du contexte épinglé (`SessionContextState`) pour qu'une reprise retrouve son état.

### R3 : agents entre eux, salles, sous-agents (1 semaine)
- Un message A2A devient un message déposé dans la session du destinataire (ou une session dédiée à l'échange), avec le contrôle de pools actuel.
- `subagents.ts` et `background-agents.ts` laissent la place à l'outil natif `subagent` et aux spécialistes du toolkit.
- `room_advance` : l'orchestrateur de salle appelle `startAgentRun({ kind: "room" })`.

### R4 : les autres portes d'entrée (1 semaine)
- Canaux (Slack, Teams, messagerie), `service-room-post`, `mcp-gateway`, mobile, `test-run-orchestrate`, `test-runner-poll`, `simulation-prepare`, workflows et automatisations : tous via `startAgentRun`.
- Les modes `design` et `knowledge_backfill` sortent de `internal-agent-run` vers deux routes du backend (ce sont des appels ponctuels, pas des runs).

### R5 : les boucles hors agents internes (1 à 1,5 semaine)
Trois choix possibles par fonction ; recommandation entre parenthèses.
- `ai-agent-chat`, le cockpit : un **agent système** OpenCode, défini dans le code et non en base (oui).
- `rag-chat`, le widget public : agent système avec un jeu de permissions minimal (visiteur anonyme, outils MCP autorisés par le marchand, plafond de tours) (oui, en dernier : c'est exposé sur Internet).
- `vibe-code` : agent système avec les outils fichiers natifs sur un clone du dépôt (oui).
- `reporter.ts` : un spécialiste « rédacteur » appelé en sous-agent (oui).

### R6 : la bascule générale (3 jours, puis trois vagues de trois jours)
- Valeur par défaut `harness = 'opencode'`, puis conversion de tous les agents par vagues : chat, puis missions planifiées, puis machine d'équipe.
- Comparaison sur la page Fiabilité du harnais : runs réussis, coût par run, erreurs d'outil, temps avant le premier texte.

### R7 : la suppression du code (3 jours)
Liste complète en section 5. On supprime, on relance `tsc`, les tests et les évals, et on cherche les importeurs restants (`grep`) avant chaque fichier.

### R8 : la migration de nettoyage (1 jour)
Voir section 5.4. On la garde **réversible** pendant un mois : renommage des tables en `_legacy_*` d'abord, suppression ensuite.

**Total : environ 7 à 9 semaines pour une personne.** R2 et R5 sont les plus incertaines.

## 5. Ce qu'on supprime

Les chemins sont ceux de `backend/src/edge/` (option A). `supabase/functions/` reste intact pour le cloud gelé.

### 5.1 Fonctions entières

| Fonction | Remplacée par |
|---|---|
| `internal-agent-run` | `startAgentRun` + harnais. Les modes `design` et `knowledge_backfill` deviennent deux routes |
| `internal-agent-a2a` | message dans la session du destinataire (R3) |
| `internal-agent-scheduler` | tâche du cron local (R1) |

### 5.2 Dans `internal-agent-run/index.ts` (pour mémoire, tout part)

| Groupe | Fonctions |
|---|---|
| Boucle de chat | `runChat`, `initChatRun`, `learnFromChatMessage`, `finalizeChatSuccess`, `isCompanionConversation`, `collapseStalePageContexts` |
| Missions | `runMission`, `runMissionTick`, `kickTickDrainer`, `chainNextTick`, `reconcileZombieRuns`, `nextRunAt`, `verifyMissionOutcome`, `finalizeMissionSuccess`, `gatherRunMaterial`, `autoSaveMemory`, `salvageReportDraft`, `postMissionReportToChannel`, `postReplyToBoundChannel`, `completeRunTodos`, `collectUiBlocks`, `runCards` |
| Salles | `closeRoomMessage`, `finalizeRoomSuccess` |
| Planification | `produceExecutionPlan`, `planToMarkdown`, `safeParsePlan`, `planMessages` |
| Prompt | `buildSystemPrompt`, `rankSkills`, `selectLines`, `isSecurityAgent` |
| Contexte | `compactMessagesIfNeeded`, `sealDigest`, `sanitizeToolPairs` |
| Modèle | `resolveAgentEndpoint`, `platformEndpointForAgent`, `providerFor`, `agentModelForTier`, `agentModelForRequest`, `resolveRunStateModel`, `estimateCost`, `isProviderFailure`, `modelRefusal`, `permanentModelRefusal` (le plugin modèle les remplace) |
| Exécution distante | `probeSandbox`, `probeRunner`, `gateHybridHealth`, `loadRuntimeConfig` (à reprendre dans le `WorkspaceDriver` si le mode hybride est conservé) |
| **Extraits avant (R0), pas supprimés** | `prepareAgentToolset`, `loadAgentAndTools`, `makeToolContext`, `loadComposioApps`, `loadMemorySection`, `loadRecentWorkSection`, `loadTeamMemorySection`, `loadCompanySection`, `loadActivatedSkills` |

### 5.3 Modules partagés (`_shared/`)

| Fichier | Lignes | Sort | Remplacé par |
|---|---|---|---|
| `agent-loop.ts` | 953 | supprimé, sauf la vérification de contrat | plugin contrat |
| `subagents.ts` | 242 | supprimé | outil `subagent`, spécialistes |
| `background-agents.ts` | 234 | supprimé | sous-agents en fond d'OpenCode |
| `call-ledger.ts` | 113 | supprimé | événements OpenCode écrits par le pont |
| `context-checkpoint.ts` | 194 | supprimé | compaction d'OpenCode |
| `harness-hooks.ts` | 189 | supprimé | hooks de plugin |
| `run-tool-hooks.ts` | 364 | supprimé | `tool.transform`, hook `context` |
| `tool-arg-repair.ts` | 242 | supprimé | validation des schémas d'OpenCode |
| `tool-error-diagnosis.ts` | 286 | supprimé | à vérifier : à reprendre dans le pont si le diagnostic est affiché dans le front |
| `tool-ranking.ts` | 117 | supprimé | lots du toolkit |
| `prompt-compiler.ts` | 565 | supprimé | `agent-profile.ts` du harnais |
| `turn-principal.ts` | 152 | supprimé | `principal` porté par `startAgentRun` |
| `agent-context.ts` | 439 | en partie | les parties lues par le profil vont dans `backend/src/agents/profile/` |
| `reply-format.ts` | 71 | à vérifier | gardé s'il sert encore au rendu des messages |

Dans `ai.ts` (2 545 lignes, environ 1 500 partent) : `callAiWithTools`, `runToolRounds`, `executeToolCalls`, `repairToolPairing`, `shrinkOldToolResults`, `toolDescVariant`, `parseToolArgs`, `validateToolArgs`, `schemaLookup`, `toolNames`, `parseEmbeddedToolCalls`, `sanitizeLeakedToolCalls`, `hasToolCallMarkers`, `addHarnessStats`, `fitOutputBudget` et les types `ToolLoopOpts`, `ToolRoundsOpts`, `HarnessStats`. On garde `callAi`, `routeAiRequest`, `retryDelayMs`, `isRetryableStatus`, `truncateMiddle`, `safeParseJson`.

Volume total retiré : de l'ordre de **9 000 lignes** (5 500 pour `internal-agent-run`, 3 000 de modules partagés, 1 500 dans `ai.ts`), plus `internal-agent-a2a` et les tests associés.

### 5.4 Base de données (migration de nettoyage)

| Objet | Migration d'origine | Sort |
|---|---|---|
| `internal_agent_run_state` | ancien moteur | supprimée (lue par 9 fonctions, toutes retirées) |
| `internal_agent_run_inbox` | 0305 | supprimée |
| `internal_agent_tool_outputs` | 0297 | supprimée |
| `internal_agent_call_ledger` | 0299 | supprimée (le pont garde les appels dans `internal_agent_run_events`) |
| File `agent_run_ticks` et sa tâche cron de vidage | 0095, 0096 | supprimées |
| Colonne `internal_agents.harness` | 0307 | supprimée une fois tous les agents convertis |
| `internal_agent_runs`, `internal_agent_run_events` | | **gardées** |

### 5.5 Configuration et front
- `HARNESS_OPENCODE` disparaît : en `PLATFORM=self`, le harnais est toujours actif. `HARNESS_TOOLKIT` peut rester comme interrupteur de secours pendant un mois.
- Front : le filtre par moteur de la page Fiabilité du harnais et tout sélecteur de moteur sur l'agent partent avec la colonne.

## 6. Risques

| Risque | Parade |
|---|---|
| Les exécuteurs d'outils dépendent de la forme du `ToolContext` de l'ancien moteur | Extraction en R0, avec des tests sur `makeToolContext` avant toute suppression |
| Missions longues : les ticks survivaient à un redémarrage, OpenCode reprend dans le même processus | Phase 7 : arrêt propre et reprise des sessions au démarrage, testée en R1 |
| Approbation contournée pendant la bascule | R2 avant R6 : aucun agent planifié ne bascule sans le plugin gouvernance |
| Le widget public (`rag-chat`) est exposé à des anonymes | Dernier converti, permissions minimales, tests d'abus |
| Le local diverge définitivement du cloud | Assumé par l'option A ; cloud gardé en lecture un mois |

## Annexe A : les appelants de `internal-agent-run`

Fonctions : `internal-agent-scheduler`, `mcp-gateway`, `messaging-gateway`, `service-room-post`, `simulation-prepare`, `slack-gateway`, `teams-gateway`, `test-run-orchestrate`, `test-runner-poll`, `vibe-code`.

Modules partagés : `agent-dashboards`, `assistant-ops`, `automation-engine`, `channel-approval`, `company-context`, `context-checkpoint`, `harness-hooks`, `internal-agent-tools`, `mcp-servers`, `room-orchestrator`, `run-tool-hooks`, `subagents`, `team-architect`, `teams`, `turn-principal`, `workflow-engine`.
