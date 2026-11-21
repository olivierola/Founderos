# Passer en mode local avec le harnais OpenCode : plan de migration

À lire avec `01-plan-implementation.md`. Ce document décrit comment on passe de « FounderOS sur Supabase cloud, ancien moteur » à « FounderOS en local (`backend/` en `PLATFORM=self`), moteur OpenCode », sans perdre de données et avec un retour possible à chaque étape.

## 1. Branche et dépôt

État de départ, au 21/11/2026 :
- La branche de travail est `founderos_generix`, avec beaucoup de travail **non commité**. Ce qui est déployé sur Supabase et Vercel vient de cet arbre de travail.
- Le dossier `opencode/` (clone complet d'OpenCode) est **non suivi** par Git.

Étapes :
1. **Commiter l'état actuel** sur `founderos_generix`. C'est le point de retour : la version cloud qui tourne aujourd'hui.
2. Ajouter `opencode/` au `.gitignore`. Le code d'OpenCode arrive par npm, le dossier reste une référence de lecture.
3. Créer la branche **`harness-opencode`** depuis ce commit, et la pousser sur GitHub. Tout le travail des deux plans s'y fait.
4. Les correctifs urgents de la version cloud continuent sur `founderos_generix` et sont reportés dans `harness-opencode` au moins une fois par semaine.
5. Fusion de `harness-opencode` dans `founderos_generix` quand l'étape 4 de la section 3 est franchie.

## 2. Ce qui coexiste pendant la migration

| | Cloud (`PLATFORM=supabase`) | Local (`PLATFORM=self`) |
|---|---|---|
| Base, auth, stockage, temps réel | Supabase | backend (Postgres ou PGlite) |
| Edge functions | Supabase (Deno) | backend (portées, Node) |
| Moteur d'agent | **ancien, toujours** | **par agent** : colonne `internal_agents.harness` (`legacy` ou `opencode`) |

- Le cloud ne voit jamais le harnais OpenCode. Il continue de fonctionner tel quel tant qu'on ne l'éteint pas : c'est le filet de sécurité.
- En local, un agent en `legacy` tourne sur l'ancien moteur porté (moteur de ticks sur le cron local). Un agent en `opencode` tourne sur l'hôte embarqué.
- L'interrupteur général `HARNESS_OPENCODE=0` dans `backend/.env.self` désactive l'hôte : tous les agents reviennent sur l'ancien moteur au redémarrage du backend.

## 3. Les étapes

Chaque étape a une **porte** : on ne passe à la suivante que si elle est franchie.

### Étape 1 : plateforme locale opérationnelle, ancien moteur
Avant de toucher au harnais, on s'assure que FounderOS tourne entièrement en local.

1. `backend/.env.self` complété (voir `.env.self.example`), avec les clés LLM (OpenRouter et les autres) et les secrets des connecteurs.
2. Base locale : PGlite pour essayer (`npm run dev:self`), puis PostgreSQL 15+ avec pgvector pour l'usage réel (`DATABASE_URL`).
3. **Import des données** depuis Supabase (comptes, sessions, tout `public`, storage, vault) :
   ```bash
   npm run platform -- import --from "postgresql://postgres:<mdp>@db.<ref>.supabase.co:5432/postgres" --storage --source-url https://<ref>.supabase.co --source-key <service_role>
   ```
4. Front local branché sur le backend : `npm run platform -- keys`, puis les trois variables dans le `.env` de la racine, puis `npm run dev`.
5. Runners, relais, machine d'équipe et webhooks pointés vers le backend local (liste dans `backend/README.md`, section « Basculer, et revenir »).
- **Porte :** connexion avec ton compte habituel, tes agents, conversations et livrables visibles, un chat et une mission qui fonctionnent sur l'**ancien** moteur en local, et `npm test` vert.

### Étape 2 : harnais OpenCode sur des agents de test
- Phases 0 à 2 du plan d'implémentation livrées ; migration `0307_agent_harness.sql` appliquée en local (premier démarrage, ou `npm run platform -- migrate`).
- Deux ou trois agents de test passent en `opencode`.
- **Porte :** chat, outils, approbation avec consigne et reprise après redémarrage fonctionnent, et le front affiche tout comme avec l'ancien moteur.

### Étape 3 : tous tes agents de chat, puis les missions
- Phases 3 à 5 livrées.
- On bascule les agents par vagues (`harness = 'opencode'`) : les agents de chat d'abord, puis ceux qui ont des missions planifiées, et en dernier ceux qui utilisent la machine d'équipe. Chaque vague tourne trois jours avant la suivante.
- On compare sur la page Fiabilité du harnais (filtre par moteur, à ajouter) : runs réussis, coût par run, erreurs d'outil, temps avant le premier texte.
- **Porte :** sur chaque vague, au moins aussi bon que l'ancien moteur, et aucun incident (approbation contournée, fuite entre espaces de travail).

### Étape 4 : le local devient le mode principal
- Valeur par défaut de `harness` : `opencode` pour les nouveaux agents.
- Le cloud Supabase est **gelé** : on n'y déploie plus rien, mais on le garde en lecture et comme retour possible pendant un mois.
- Fusion de `harness-opencode` dans `founderos_generix`.
- **Porte :** deux semaines d'usage normal en local, sans retour arrière.

### Étape 5 : retrait de l'ancien moteur (en local)
- Suppression du moteur de ticks, de `runToolRounds` et `callAiWithTools`, de `subagents.ts`, `background-agents.ts`, `call-ledger.ts`, `context-checkpoint.ts`, `harness-hooks.ts` et `run-tool-hooks.ts`, de la partie d'`agent-loop.ts` non reprise par le plugin contrat, et de la file `agent_run_ticks` avec sa tâche cron.
- Migration de nettoyage des tables propres à l'ancien moteur (`internal_agent_run_state`, `internal_agent_run_inbox`, `internal_agent_tool_outputs`, registre des appels).
- Les appels ponctuels au LLM (`callAi` : résumés, extraction, briefings) restent sur `ai.ts`, ou passent par la génération ponctuelle d'OpenCode : à décider à ce moment-là.
- **Attention :** une fois cette étape faite, la branche ne peut plus servir le cloud tel qu'il est aujourd'hui.

## 4. Les données

| Donnée | Ce qu'on en fait |
|---|---|
| Comptes, agents, outils, skills, mémoires, connecteurs, règles, garde-fous, livrables | Importés de Supabase à l'étape 1, puis lus tels quels par les plugins |
| Conversations et messages | Restent la référence affichée. Au premier message d'une conversation après la bascule de son agent, la session OpenCode est créée et amorcée avec l'historique récent (import `SessionTransfer`, ou un résumé si l'historique est long) |
| Runs, événements, approbations | Écrits par le pont dans les mêmes tables : l'historique ancien et nouveau reste lisible au même endroit |
| Runs en cours sur l'ancien moteur | Pas de transfert : un agent ne bascule que sans run actif |
| État d'exécution d'OpenCode | `STORAGE_DIR/opencode/opencode.db`, sauvegardé avec la base locale |
| Fichiers de travail des agents | `STORAGE_DIR/agents/<agent_id>/` |

Après l'étape 1, **le local diverge du cloud** : ce qui est fait en local n'existe pas sur Supabase. Revenir au cloud après plusieurs jours en local signifie perdre ce travail, ou faire un import en sens inverse (non outillé aujourd'hui, à prévoir si ce retour doit rester possible longtemps).

## 5. Retour arrière

| Situation | Geste | Délai |
|---|---|---|
| Un agent se comporte mal sur OpenCode | `harness = 'legacy'` sur cet agent | immédiat |
| Le harnais OpenCode pose problème | `HARNESS_OPENCODE=0`, puis redémarrage du backend | une minute |
| Le mode local pose problème (étapes 1 à 3) | Le front repointe sur Supabase (anciennes variables) ; le cloud n'a jamais été coupé | quelques minutes, mais le travail fait en local entre-temps n'y est pas |
| Après l'étape 5 | Revenir au commit d'avant le retrait | une heure |

## 6. À préparer avant l'étape 1

- [ ] Commit de l'état actuel et branche `harness-opencode` (section 1)
- [ ] `backend/.env.self` complet : secrets LLM, connecteurs, SMTP, OAuth
- [ ] PostgreSQL 15+ avec pgvector pour l'usage réel (PGlite suffit pour les essais)
- [ ] Connexion directe à la base Supabase et clé de service, pour l'import
- [ ] Compte OpenRouter crédité (quota gratuit épuisé le 21/11)
- [ ] Jeu d'évals de référence lancé sur l'ancien moteur, pour pouvoir comparer
