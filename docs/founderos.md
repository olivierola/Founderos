# FounderOS — écrit détaillé sur le produit

*Rédigé le 6 août 2026, à partir du code de la branche `main` (176 migrations, 99 edge functions, ~545 fichiers TS/TSX côté app).*

---

## 1. Ce que FounderOS est devenu

Le `README.md` du dépôt décrit encore le produit d'origine :

> « SaaS Cockpit code-aware pour développeurs SaaS, indie hackers et fondateurs. Connecte ton repo, on comprend ton SaaS, on génère ton cockpit d'administration. »

Ce n'est plus le produit. Le code raconte une autre histoire, et elle est écrite noir sur blanc dans [navigation.ts:73-79](src/lib/navigation.ts#L73-L79) :

> « RUN = where the AI workforce does the work · CONTROL = the governance/control plane an enterprise buyer (RSSI / Head of AI) signs off on · CONNECT = the hands (integrations). »

**FounderOS est aujourd'hui une plateforme d'AI workforce d'entreprise** : on y crée des agents IA autonomes, on leur donne des outils, des compétences et des accès, on les fait travailler dans des espaces dédiés par service, et on garde au-dessus un plan de contrôle (gouvernance, coûts, sécurité, modèles) qu'un RSSI ou un Head of AI peut signer.

Le glissement est net dans la nav elle-même : les dashboards « Outils IA » et « Data & Simulations » ont été retirés, et le commentaire explique pourquoi ([navigation.ts:100-107](src/lib/navigation.ts#L100-L107)) — *les outils qu'ils exposaient comme modules appartiennent désormais à des agents spécialisés*. On ne va plus dans « Vibe Code » ; on demande à l'agent Vibe Coder. Les pages survivent comme surfaces de configuration (`HIDDEN_MODULES`), pas comme destinations.

C'est le choix de design le plus fort du produit, et le plus risqué : **l'agent remplace le module**.

---

## 2. L'architecture produit

### 2.1 Deux niveaux de dashboard

Le produit a deux entrées distinctes, et elles ne s'adressent pas aux mêmes gens.

**Le dashboard « AI Workforce »** ([navigation.ts:119-121](src/lib/navigation.ts#L119-L121)) — l'AppShell complet, deux sidebars, organisé en trois zones :

| Zone | Modules | À qui ça parle |
|---|---|---|
| **RUN** | AI HQ, AI Workforce, CRM, Office | Les opérationnels — là où le travail se fait |
| **CONTROL** | DevOps, AI Governance, AI Ops, Fine-tuning Studio | Le RSSI / Head of AI — le plan de contrôle |
| **CONNECT** | Connecteurs (replié dans AI Workforce) | Les mains de l'agent |

**Les dashboards de service** ([features/service-dashboards/](src/features/service-dashboards/), migration `0133`) — un espace épuré, hors AppShell, créé par l'utilisateur pour une équipe : Home / Agents / Schedules / Memory / Artifacts. Chacun a ses propres réglages ([model.ts:44-52](src/features/service-dashboards/model.ts#L44-L52)) : onglet d'atterrissage, onglets masqués, **thème visuel parmi 17 palettes**, valeurs par défaut des agents (modèle, mode sandbox, max_steps, plafond de coût par run, swarm, approbation obligatoire) et comportement des rooms.

Cette dualité est un vrai atout commercial : le dashboard de service se vend à une équipe métier (« votre espace, vos agents »), le dashboard Workforce se vend à la DSI. Même backend, deux narratifs.

### 2.2 Les rooms — la surface de travail

Les rooms (migrations `0135`, `0137`, `0144`) sont l'endroit où humains et agents se parlent. Concrètement : un fil type Slack, avec mention `@agent`, commandes `/`, réponses en thread, et surtout des **artifacts** — les livrables produits par les agents s'accrochent au fil et se rendent avec leur bon renderer (rapport, session de code, session de test, simulation).

Le composer a été refondu récemment : `PromptInput` animé, mentions `@` et slashes colorés, dictée vocale Deepgram, blocs de code Shiki, séparateurs de date. C'est le point de contact quotidien du produit — il méritait ce soin.

---

## 3. Le cœur : le runtime d'agents

C'est là que se trouve la vraie propriété intellectuelle. [internal-agent-tools.ts](supabase/functions/_shared/internal-agent-tools.ts) fait **4 332 lignes**, [internal-agent-run/index.ts](supabase/functions/internal-agent-run/index.ts) **2 918 lignes**. À eux deux, c'est un quart du backend.

### 3.1 La boucle comme système de contrôle

Le fichier [agent-loop.ts](supabase/functions/_shared/agent-loop.ts) (migration `0164`) est la pièce la plus mature du système. Son en-tête pose la thèse : *« ce que ce module ajoute, c'est ce qui fait d'une boucle un SYSTÈME DE CONTRÔLE plutôt qu'un tas de retries »*. Cinq mécanismes :

1. **Le contrat de réussite** (`deriveContract`) — l'objectif traduit en checks *typés*, du plus déterministe au plus subjectif : `deliverable_exists`, `deliverables_min`, `todos_all_done`, `http_ok`, `file_exists`, `command_exits_zero`, `text_contains`, et seulement en dernier recours `judge` (juge LLM). Le commentaire dit l'essentiel : *« c'est ce qui empêche une boucle de corriger sa propre copie »*.
2. **La vérification** (`evaluateContract`) qui renvoie des *gaps* machine-vérifiés, réinjectables comme feedback — pas une impression.
3. **L'empreinte de progression** (`fingerprintProgress`) : todos fermés, livrables produits, signatures d'outils distinctes. Comparée d'un tick à l'autre, elle détecte la **stagnation** — un agent qui brûle des tours en variant ses arguments sans rien produire, ce que l'ancienne garde « signature identique » ne voyait pas.
4. **Un contrôleur unique** (`decideNext`) qui lit tous les signaux et rend une décision typée : `continue` / `replan` / `finalize` / `abort`. Le tick handler applique, il ne décide plus rien.
5. **Une trace** écrite comme événement `loop`, auditable dans la timeline live.

Le tout est *best-effort by design* : un contrat non dérivable ne bloque jamais un run, il dégrade vers le comportement précédent. C'est la bonne décision d'ingénierie — la vérification n'est pas un point de panne.

### 3.2 62 outils natifs

Le catalogue d'outils exposé aux agents, extrait du code :

- **Système de fichiers / exécution** — `file_read`, `file_write`, `file_edit`, `file_search`, `list_files`, `manage_files`, `download_file`, `shell_exec`, `python_exec`, `nodejs_exec`, `jupyter_exec`, `run_background`, `process_logs`, `process_stop`, `list_processes`, `machine_info`
- **Web & recherche** — `web_search`, `browse_web`, `read_url`, `http_get`, `http_request`, `deep_research`, `sandbox_browser`
- **Mémoire & contexte** — `save_memory`, `search_memory`, `team_memory`, `search_context`, `search_history`, `search_past_work`, `search_knowledge`
- **Travail collectif** — `create_agent`, `list_team_agents`, `send_message_to_agent`, `delegate_mission`, `spawn_parallel_agents`, `create_mission`, `propose_mission`, `move_mission`, `list_missions`, `create_task`
- **Production** — `create_deliverable`, `create_artifact`, `report_section`, `render_ui`, `ask_user`, `say`, `update_todos`
- **Métier & données** — `crm`, `query_table`, `list_assets`, `send_email`, `simulation`, `testing`, `vibe_code`
- **Sécurité** — `security_scan`, `pentest_scope`
- **Extensibilité** — `use_skill`, `read_skill_file`, `load_toolset`, `need_tools`, `list_connectors`, `sandbox_env`

À quoi s'ajoutent, dynamiquement, les outils MCP (`mcp_<server>_<tool>`) et les actions Composio par toolkit.

Deux outils méritent d'être soulignés parce qu'ils sont rares ailleurs : `need_tools` (l'agent déclare ce qui lui manque au lieu d'échouer en silence) et `ask_user` couplé à `render_ui` (l'agent produit une UI dans le chat et attend une réponse — migration `0129`).

### 3.3 Quatre mondes d'exécution

Un agent tourne en `cloud`, `runner`, `sandbox` ou `hybrid` ([model.ts:25](src/features/service-dashboards/model.ts#L25), migration `0117`). Le mode hybride expose simultanément les outils préfixés `runner_*` et `sandbox_*`, avec un orchestrateur LLM et un routeur de santé. Trois runtimes externes vivent dans le dépôt : [runner/](runner/), [ops-runner/](ops-runner/), [test-runner/](test-runner/), plus un [sandbox/](sandbox/) dockerisé.

C'est un différenciateur réel face aux plateformes d'agents « cloud only » : un agent peut agir *dans l'infrastructure du client*, ce qui est exactement l'argument de la home (« running inside your own stack, no exposed data »).

### 3.4 Compétences : 891 skills système

Les migrations `0165` à `0176` importent **891 skills** depuis [skills_repo/](skills_repo/) : 24 engineering, 17 productivité, 33 data-analytics et 817 cybersécurité (packs Anthropic). Les skills sont multi-fichiers (`agent_skill_files`, migration `0118`) avec divulgation progressive via `read_skill_file` — l'agent ne charge le détail que quand il en a besoin, ce qui protège le contexte.

Le volume cybersécurité déséquilibre franchement le catalogue. C'est cohérent avec les templates d'agents (Red Team Operator, AppSec Code Auditor, AI Red-Teamer, Vulnerability Watcher) et le périmètre pentest autorisé (`0130`), mais ça oriente le produit vers un positionnement sécurité qui n'est pas encore assumé dans le marketing.

### 3.5 Les 19 templates d'agents

[agentTemplates.ts](src/features/internal-agents/agentTemplates.ts) livre des agents prêts à l'emploi, chacun avec ses outils, ses instructions et un cron suggéré : Support Resolver, SDR, Revenue Guardian, Executive Briefer, AI Secretary, Market Watcher, Content Engine, Data Analyst, Feedback Synthesizer, Ops Sentinel, Vulnerability Watcher, Red Team Operator, AppSec Code Auditor, AI Red-Teamer, Vibe Coder, QA Pilot, Scenario Analyst, Shop Manager.

Les trois derniers sont les « agents studio » (`0148`) : ils *possèdent* un moteur (`vibe_code`, `testing`, `simulation`) et produisent des artifacts structurés rendus comme de vraies vues de session. C'est le mécanisme par lequel un module entier devient un agent.

### 3.6 Gouvernance de l'exécution

- **Approbations inline** (`0145`) — les écritures sont gated, les lectures gratuites ; le run reste vivant pendant l'attente (poll, pas d'arrêt) ; auto-approbation des répétitions et « Tout autoriser {toolkit} ».
- **Sous-agents parallèles** (`0143`/`0144`) — `spawn_parallel_agents` répartit les sous-tâches indépendantes vers des runs enfants éphémères, plafonnés à 8, avec cartes d'instances et drawer de flux.
- **Scheduler cron** (`0126`, `0146`) + file de ticks (`0095`) + réconciliation des zombies (`0097`).
- **Plafond de coût par run**, tiering de modèle automatique (cheap → reasoner, escalade sur replan), compaction du contexte et des définitions d'outils.
- **Canaux** — les agents sont joignables depuis Slack et Microsoft Teams (`0100`/`0121`), avec post-back du finalizer dans le thread.

---

## 4. Le plan de contrôle

Trois modules distincts partagent le même espace de pages :

**AI Governance** — guardrails, accès agents, inspection des prompts, dépenses, incidents ops, sécurité. Le registre IA se synchronise automatiquement depuis `internal_agents` (`0106`), avec risques, politiques, contrôles, approbations HITL, incidents, actifs de données et audit. C'est explicitement construit pour un dossier de conformité type EU AI Act.

**AI Ops** — serveurs, temps réel, incidents infra, modèles, déploiement, monitoring, coûts. Télémétrie réelle des runs (`0107`), providers (`0108`), entraînement réel (`0110`), intégration RunPod pour héberger un modèle vLLM vers lequel les agents peuvent router leur inférence (`0111`, `0154`).

**Fine-tuning Studio** — 10 onglets, du dataset au registry : Datasets, Data Prep, Labeling, Experiments, Entraînements, Évaluation, Playground, Registry, Settings.

C'est la partie qui justifie le prix face à un acheteur entreprise. C'est aussi la partie la plus susceptible d'être partiellement en façade — je n'ai pas audité le taux de pages réellement branchées sur des données vivantes par rapport aux pages de démonstration.

---

## 5. Architecture technique

**Frontend** — Vite + React 18 + TypeScript, Tailwind + shadcn/ui, Phosphor icons, TanStack Query, Zustand, React Router. Le stack UI est lourd et assumé : Plate.js (~40 plugins) pour l'éditeur de documents, Excalidraw pour le whiteboard, ReactFlow + dagre + d3 pour les canvas d'assets et les graphes de rooms, Recharts pour la dataviz, Three.js / React Three Fiber / ogl / Spline pour les avatars et orbes d'agents, rrweb pour le session replay, Shiki pour le code.

**Backend** — Supabase intégral : Postgres + RLS, Auth, Storage, Realtime, Edge Functions Deno. **176 migrations**, **99 edge functions**.

**IA** — Groq (rapide) et DeepSeek (raisonnement) via [ai.ts](supabase/functions/_shared/ai.ts), avec un routage par tâche (`routeAiRequest`) et surcharge possible vers un endpoint auto-hébergé. Deepgram pour la voix (STT + streaming), fal / OpenAI pour l'image et la vidéo dans les studios Office.

**Multi-tenancy** — `profiles` → `workspaces` → `workspace_members` → `projects` → `repositories` (`0001`), avec RBAC (`0022`), invitations d'organisation (`0159`) et RLS partout.

**Paiement** — Stripe, checkout par plan (`create-checkout`).

### Le mur à 99 fonctions

**99 edge functions sur un plafond de 100.** Ce n'est pas une remarque de style : c'est déjà une contrainte d'architecture active. Les endpoints de simulation ont tous été repliés dans une seule fonction `simulation-prepare` en dispatch d'actions ; `support-engine` et `support-voice` ont subi la même consolidation. Chaque nouvelle capacité doit maintenant se négocier contre une fusion.

---

## 6. Modèle économique et positionnement

Le pitch de la home est clair et bien calibré pour un acheteur entreprise :

> « We make it easy to put agents to work — secured, governed, and running inside your own stack. No exposed data, no lost control. »

Le triptyque **secured / governed / in your own stack** est cohérent avec ce que le code fait réellement : les runners externes, le périmètre pentest autorisé, les approbations sur écriture, le registre IA. Ce n'est pas du marketing décorrélé du produit — c'est rare et ça vaut d'être protégé.

La monétisation passe par Stripe avec des plans. Le vecteur d'expansion naturel est le **dashboard de service** : une équipe l'adopte, puis une deuxième, puis la DSI demande le plan de contrôle. Land-and-expand par équipe, upsell par gouvernance.

---

## 7. Lecture honnête de l'état

### Ce qui est solide

- **La boucle d'agents.** Le contrat de réussite vérifiable, le contrôleur unique, la détection de stagnation et la trace auditable placent le runtime au-dessus de la plupart des frameworks d'agents open source. C'est défendable techniquement et racontable commercialement.
- **La profondeur d'exécution.** Quatre modes, runners auto-hébergés, sous-agents parallèles, approbations qui ne tuent pas le run. Ce sont des problèmes que les équipes rencontrent en production, pas en démo.
- **Le plan de contrôle comme argument de vente.** Peu de plateformes d'agents amènent le registre IA, les guardrails et les coûts dans le même produit.
- **Le soin de l'interface.** L'attention portée au composer, aux orbes, aux thèmes, aux artifacts crée une qualité perçue qui compte réellement dans un cycle de vente.

### Ce qui inquiète

1. **L'étendue fonctionnelle.** CRM, Office (documents, tableurs, présentations, whiteboard, studios image/vidéo, copywriter), DevOps, Fine-tuning, simulations, testing, supply chain, finance/PSA, RH/ATS, support omnicanal… Une partie de ces modules a déjà été supprimée le 17 juillet (Support, PM) après évaluation, ce qui est un bon signal — mais la surface reste très large pour ce qui est probablement une équipe très réduite. Chaque module non essentiel est un coût de maintenance permanent et une dilution du récit.
2. **Le plafond des 100 fonctions.** À traiter comme une dette d'architecture, pas comme un détail d'infra. Une passerelle de dispatch unique par domaine repousserait le mur durablement.
3. **Le README.** Il vend encore le produit de 2025 et décrit un « Sprint 1 » avec des sprints à venir déjà tous dépassés. C'est le premier fichier que lit un investisseur, un candidat ou un partenaire technique.
4. **Le déséquilibre du catalogue de skills.** 817 skills cybersécurité sur 891 : soit le produit assume un positionnement sécurité IA, soit il faut rééquilibrer. L'entre-deux actuel envoie un signal confus.
5. **Le verrouillage sur DeepSeek/Groq.** Le choix est documenté et volontaire (coût), et l'abstraction `ep` permet déjà un endpoint personnalisé. Mais aucun acheteur entreprise ne signera sans pouvoir router vers son propre fournisseur — Azure OpenAI, Bedrock, ou Claude. L'abstraction existe ; il manque le chemin de configuration côté produit.
6. **Les modules cachés.** `HIDDEN_MODULES` (simulations, test-runs, repos, vibe-code) sont routés mais invisibles. C'est un pari élégant — l'agent remplace le module — mais il faut vérifier que les utilisateurs *trouvent* la configuration quand ils en ont besoin. Un chemin explicite depuis la fiche de l'agent studio vers sa page de config lèverait le doute.

---

## 8. Les quatre choses que je ferais ensuite

1. **Réécrire le README** pour qu'il dise ce qu'est FounderOS aujourd'hui : plateforme d'AI workforce gouvernée, exécutable dans votre infrastructure. Une heure de travail, effet immédiat sur toutes les premières impressions.
2. **Décider du positionnement sécurité.** Soit « la plateforme d'agents pour les équipes sécurité » avec les 817 skills en tête de gondole, soit rééquilibrer le catalogue. Le déséquilibre actuel n'est pas un choix, c'est un accident d'import.
3. **Casser le mur des 100 fonctions** avant qu'il ne bloque une fonctionnalité qui compte. Le motif de dispatch par domaine est déjà éprouvé deux fois dans le dépôt.
4. **Élaguer.** Choisir les trois modules qui portent le récit et geler explicitement les autres. Ce qui rend le produit crédible, ce n'est pas sa surface — c'est la profondeur de la boucle d'agents, et elle mérite tout le temps disponible.

---

## Annexe — repères chiffrés

| Élément | Valeur |
|---|---|
| Migrations SQL | 176 |
| Edge functions Deno | 99 (plafond : 100) |
| Fichiers TS/TSX applicatifs | ~545 |
| Backend Deno (lignes) | ~33 000 |
| Outils natifs d'agents | 62 (+ MCP et Composio dynamiques) |
| Skills système | 891 |
| Templates d'agents | 19 |
| Modes d'exécution | 4 (cloud, runner, sandbox, hybrid) |
| Thèmes de dashboard | 17 |
| Modules dans la nav | 8 visibles, 4 cachés-mais-routés |
