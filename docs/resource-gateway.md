# Passerelle de ressources : registre, pools, cohérence

Livrée le 10/11/2026 (migration `0291_resource_registry_pools.sql`), étendue le 12/11/2026 aux connecteurs maison (`0293_app_connector_registry.sql`). Elle remplace l'attribution granulaire des moyens d'un agent par des **pools** : des lots de ressources donnés en une fois, que l'agent ne peut pas dépasser.

## 1. Le registre

`resource_registry` recense tout ce qu'un agent peut atteindre. Des triggers SQL le tiennent à jour dès qu'une source est connectée, modifiée ou retirée : aucun appel applicatif n'est nécessaire.

| Source | Ligne « source » (`toolset`) | Lignes « outil » (`tool`) | Statut |
| --- | --- | --- | --- |
| Serveur MCP (`mcp_servers`) | le serveur | chaque outil de `cached_tools` ; risque d'après les annotations MCP, sinon d'après le nom | `unavailable` si le serveur est désactivé |
| App Composio (`connectors`, `source = composio`) | la connexion du projet ou du service (jamais une connexion personnelle) | les actions mises en cache par la découverte (`metadata.tools`) ; risque d'après les indications de Composio (`readOnlyHint`, `destructiveHint`), sinon d'après le nom | `unavailable` si elle n'est pas connectée |
| Connecteur maison (`connectors`, `source = in_house`), source `app_connector` | la connexion du projet ou du service, si son fournisseur a un catalogue d'actions | chaque action du catalogue (`connector_action_catalog`), lecture ou écriture | `unavailable` si elle n'est pas connectée |
| Outil customisé (`custom_connectors`) | le connecteur | chaque opération, avec son risque déclaré | `unavailable` sauf `status = active` |
| Capacité intégrée | une ligne par famille (`web_search`, `tracker`, `crm`…) | — | toujours `active` |
| Collection RAG, compétence, guardrail | une ligne chacune (`knowledge`, `skill`, `guardrail`) | — | selon `enabled` |
| Procédure, automatisation (`agent_workflows`) | une ligne, avec dans `metadata` les agents, serveurs MCP, apps et collections qu'elle fait intervenir | — | `unavailable` si archivée |
| Agent (`internal_agents`) | une ligne `agent`, pour l'A2A | — | `unavailable` si archivé ou sans collaboration |

Un outil qui disparaît de sa source passe `removed` au lieu d'être effacé : le pool qui le contient le signale. `resource_registry_rebuild(projet)`, appelé par le bouton « Resynchroniser », rejoue toute la synchronisation et purge les lignes disparues qu'aucun pool ne cite plus.

### Les actions des connecteurs d'applications

Une app ne se donne action par action que si ses actions sont au registre.

- **Apps Composio.** Leurs actions viennent de Composio et sont gardées dans `connectors.metadata.tools` (`_shared/composio-discovery.ts`, 300 actions au plus par connexion). La découverte se fait :
  - quand une app partagée vient d'être connectée (`composio-connect` pour une app à clé, `composio-connection-status` à la fin d'une connexion OAuth) ;
  - quand on clique « Resynchroniser » dans l'onglet Pools : `composio-action` en mode `discover_all` découvre toutes les apps connectées du projet avant de rejouer le registre ;
  - quand un agent ou l'interface liste les actions d'une app.

  Le cache s'enrichit et ne rétrécit jamais : une découverte plafonnée n'est pas la liste complète. Le SDK n'a pas de pagination : une app de plus de 300 actions (GitHub en a plusieurs centaines) n'en a que 300 au registre. Les autres restent atteignables en donnant l'app entière.
- **Connecteurs maison.** Leurs actions sont celles du catalogue de `_shared/connector-actions.ts` (30 fournisseurs, 66 actions au 12/11/2026). Le registre, écrit par des triggers SQL, les lit dans `connector_action_catalog`. `backend/src/shared/connector-catalog-sql.ts` produit le bloc qui synchronise cette table, et `connector-catalog.test.ts` échoue dès que le TypeScript et la dernière migration divergent. Une action ajoutée côté TypeScript demande donc une nouvelle migration, avec ce bloc suivi de la resynchronisation qu'il imprime. Un fournisseur sans catalogue (une connexion de scan, par exemple) n'entre pas au registre : il ne donne aucun outil à un agent.

`composio-action` en mode `describe` rend aussi le schéma d'une action Composio : c'est ce que la fiche `my_resources` montre à l'agent.

## 2. Les pools

- `resource_pools` : un pool est soit réservé à un service, soit ouvert à tout le projet.
- `resource_pool_items` : son contenu. Un item est soit une source entière (tous ses outils, y compris les futurs), soit un outil précis.
- `agent_resource_pools` : l'attribution d'un pool à un agent.

Gardes appliquées en base, par trigger :

- une ressource réservée à un service n'entre que dans un pool de ce service. Les agents et les workflows échappent à cette règle, puisque l'A2A et la passation traversent les services ;
- une ressource disparue n'entre pas dans un pool ;
- un pool ne se donne qu'à un agent du même projet, et du même service s'il est réservé ;
- **un pool en erreur de cohérence ne se donne pas.**

### Mode pools

Un agent qui a au moins un pool est en mode pools : il n'atteint que l'union de ses pools. `_shared/resource-pools.ts` applique cette règle à chaque porte :

| Porte | Effet en mode pools |
| --- | --- |
| Lignes `internal_agent_tools` | Une ligne survit si un pool la couvre. Ce que les pools donnent sans ligne correspondante est synthétisé. Les familles qui exigent une configuration (`db_read`, `edge_function`, `connector_action`, `vault_connector`, `custom`) ne sont jamais synthétisées : le pool en fixe seulement la limite. |
| Serveurs MCP | Les serveurs des pools, limités aux outils accordés. Les activations de l'agent et les accès ouverts par un workflow (`mcp_grants`) n'ajoutent rien. |
| Outils customisés | Les connecteurs des pools, avec leurs seules opérations accordées. L'appel brut est coupé dès qu'un pool ne donne qu'une partie des opérations. |
| Apps Composio | Seules les actions accordées. La découverte indique à l'agent ce qui lui est ouvert. |
| Connecteurs maison (`connector_action`) | L'app des pools est donnée sans ligne sur l'agent (la clé est sur la connexion du projet). L'outil `use_<app>` n'annonce que les actions accordées et refuse les autres à l'appel. Pour un pool d'avant 0293 qui donne la famille `connector_action`, elle reste une limite : la ligne configurée sur l'agent décide. |
| Compétences, collections | Celles des pools. Une ligne `rag_search` est restreinte à l'intersection avec les pools. |
| Guardrails | Ceux des pools **s'ajoutent** à ceux de l'espace. Un pool ne retire jamais un garde-fou. |
| A2A (`list_team_agents`, `send_message_to_agent`, `delegate_mission`, `create_mission` confiée à un collègue) | Seuls les collègues des pools, et seulement si c'est réciproque : un collègue en mode pools qui n'a pas l'émetteur dans ses pools est refusé. |
| Procédure | L'assistant qui l'exécute doit l'avoir dans ses pools, ainsi que tout ce qu'elle fait intervenir. Sinon le lancement échoue, et l'échec est tracé dans `agent_workflow_runs`. `use_procedure` ne liste et ne rend que les procédures des pools, celles d'un autre service comprises. |
| Automatisation | `run_automation` ne lance que celles des pools, actives, et dont tout ce qu'elles font intervenir est aussi dans les pools. |
| Passation d'une automatisation | Chaque agent destinataire doit avoir l'automatisation dans ses pools. Sinon l'étape échoue, avant qu'une seule mission ne soit confiée. |
| Réponse à un collègue (`internal-agent-a2a`) | Les mêmes lignes d'outils que dans un run. Avant le 12/11/2026, les lignes hors pools y revenaient. |
| Prompt d'une room ou d'une procédure | La boîte à outils annoncée est celle que le tick donnera, pools appliqués. |

Un agent sans pool garde le comportement d'avant. En revanche, si ses pools sont connus mais que leur contenu ne peut pas être lu, l'accès est **fermé** : un mode strict ne retombe pas en grand ouvert sur une erreur.

### Ce que l'agent voit de ses pools

Fermer ce qui est hors des pools ne suffit pas : l'agent doit savoir ce qui est dedans, et comment s'en servir. Un agent en mode pools reçoit pour cela trois choses.

**Une consigne dans son prompt.** Elle nomme ses pools et compte ce qu'ils contiennent, par exemple « MODE POOLS — tes pools : « Support », « Infra » (5 sources d'outils, 1 collection, 2 automatisations, 2 collègues). Tu n'atteins QUE leur contenu ».

**L'outil `my_resources`**, toujours appelable (`_shared/pool-discovery.ts` pour la présentation, `loadPoolInventory` pour la lecture) :

- sans argument, il rend l'inventaire groupé par nature : outils, connaissances, compétences, procédures, automatisations, collègues, garde-fous. Chaque ressource vient avec le geste qui la sert, sous le vrai nom de l'outil dans ce run ;
- `query` filtre par mot-clé (accents ignorés), `kind` par nature, `pool` par pool ;
- `id` rend la fiche d'une ressource. L'agent peut donner le nom d'un outil, l'id du registre, l'id de la source ou un nom. La fiche porte le schéma des paramètres d'un outil MCP, les opérations d'un outil maison, les actions ouvertes d'une app ou le texte complet d'un garde-fou.

| Ressource | Geste indiqué |
| --- | --- |
| Outil MCP | `mcp_<serveur>_<outil>(…)` |
| App Composio | `use_<app>()` pour lister ses actions, puis `use_<app>(action, params)` |
| Connecteur maison | `use_<app>(action, params)` |
| Outil maison | `ext_<slug>(operation, params)` |
| Famille intégrée | ses outils (`web_search`, `tracker`…) |
| Collection | `search_context(scope="kb", collection_id=…)` |
| Compétence | `use_skill(slug)` |
| Procédure | `use_procedure(id)` : la lire, puis la suivre |
| Automatisation | `run_automation(id, payload)` : la lancer |
| Collègue | `send_message_to_agent` ou `delegate_mission` |
| Garde-fou | rien à appeler : il s'applique d'office |

L'inventaire dit aussi ce qui ne marchera pas, pour que l'agent ne le cherche pas : une source désactivée, un outil que le serveur n'expose pas à ce run, une famille que le pool autorise mais qui n'est pas configurée sur l'agent, une automatisation en pause, un collègue qui n'a pas l'agent dans ses pools.

**Le déverrouillage outil par outil.** La famille INTEGRATIONS (outils MCP, apps, outils maison) ne part pas d'office avec ses schémas. Ouvrir la fiche d'une ressource rend appelable son seul outil, sans charger toute la famille : un serveur de quarante outils ne coûte pas quarante schémas pour en utiliser un. L'inventaire rend appelables d'office les gestes génériques (`search_context`, `use_procedure`, `run_automation`, A2A, outils intégrés), qui sont peu nombreux. Le moteur garde ces outils d'un tick à l'autre (`run_state.meta.unlocked_tools`, 60 au plus), et la sélection de schémas de chaque tour ne les écarte jamais. Une fiche qui dit « ne l'utilise pas » ne déverrouille rien : A2A non réciproque, automatisation qui sortirait des pools.

**`run_automation`**, quand les pools contiennent au moins une automatisation :

- sans `id`, il liste les automatisations et dit si chacune est lançable ;
- avec `id`, il vérifie qu'elle est dans les pools, active, et que tout ce qu'elle fait intervenir est aussi dans les pools (`namedWorkflowViolations`, la même lecture que le moteur) ;
- il passe ensuite par PolicyGuard comme une écriture. Hors pilote automatique, il demande une approbation inline, rejouée par le chemin `edge_function` vers `run-workflow` ;
- il rend le résultat étape par étape, lu dans `agent_workflow_run_steps`. Le moteur exécute une automatisation en ligne : quand `run-workflow` répond, elle est terminée ;
- garde-fou contre les boucles : une même automatisation ne se lance pas plus de 5 fois en 10 minutes par des agents (`trigger = 'agent'`).

## 3. La cohérence

Trois fonctions SQL, appelées par l'interface :

- `resource_pool_issues(pool)` : les problèmes d'un pool ;
- `agent_resource_issues(agent)` : ceux d'un agent en mode pools ;
- `resource_coherence_report(projet)` : la surveillance du projet entier.

| Code | Gravité | Sens |
| --- | --- | --- |
| `workflow_agent_outside_pool` | erreur | Une procédure ou une automatisation du pool fait intervenir un agent absent du pool. |
| `workflow_tool_outside_pool` | erreur | Elle utilise un serveur MCP, ou certains de ses outils, absents du pool. |
| `workflow_app_outside_pool` | erreur | Elle utilise une app ou une action absente du pool, ni en app Composio, ni en connecteur maison. |
| `workflow_knowledge_outside_pool` | erreur | Elle consulte une collection absente du pool. |
| `item_removed` | erreur | Une ressource du pool a disparu de sa source. |
| `scope_mismatch` / `pool_scope` | erreur | Une ressource ou un pool appartient à un autre service. |
| `a2a_not_reciprocal` | erreur | L'agent peut solliciter un collègue en mode pools qui ne l'a pas, et qui ne pourra donc ni lui répondre ni lui rendre compte. |
| `item_unavailable` | avertissement | La source est désactivée, déconnectée ou archivée. |
| `granular_ignored` | avertissement | Un accès granulaire de l'agent est absent de ses pools ; il est ignoré. |
| `procedure_outside_pool` | avertissement | Une procédure du service est confiée à l'assistant, qui ne l'a pas dans ses pools : elle échouera. |
| `workflow_targets_agent` | avertissement | Un workflow passe la main à l'agent, qui ne l'a pas dans ses pools : l'étape échouera. |
| `empty_pool` | info | Le pool est vide. |

La lecture des références d'un workflow existe deux fois : en SQL (`resource_workflow_refs`) et en TypeScript (`workflowRefsOf`). Les deux doivent rester d'accord ; les tests le vérifient sur le même graphe.

## 4. L'interface

- **Onglet Pools** du dashboard de service (`/service/:id/pools`). Une bande d'indicateurs (pools, agents en mode pools, ressources du registre, erreurs de cohérence) ouvre sur trois vues :
  - **la liste** : des cartes, rangées par portée (« ce service » ou « tout le projet »), qui montrent la composition de chaque pool par famille, les avatars de ses agents et son état ;
  - **l'éditeur d'un pool** : le contenu par famille, l'ajout depuis le registre (une source entière ou outil par outil), la cohérence en direct et les agents ;
  - **le registre**, groupé par famille avec les outils repliés sous leur source, avec « Resynchroniser » et « Découvrir ses actions » pour une app Composio, et **le rapport de cohérence**, groupé par gravité.
- **Onglet Outils d'un agent** : son mode, ses pools en cartes, l'ajout ou le retrait d'un pool, ses problèmes de cohérence, et « Créer un pool depuis ses accès actuels » (`resource_pool_from_agent`). Ce pool reprend ses accès granulaires, les collègues de son service et le travail qu'on lui confie. Il ne lui est donné que s'il est cohérent.

L'habillage (`src/features/resource-pools/visuals.tsx`) reprend les briques du dashboard : `StatisticsCard7`, `Card`, `EmptyState`, `AgentIdentity` pour les agents, les logos du catalogue Composio pour les apps, et le kit des outils customisés (`Pill`, `Segmented`, `Drawer`, `Field`, `RISK_META`).

## 5. Hors périmètre de cette livraison

- Aucun point d'entrée MCP n'expose un pool à un client externe (l'équivalent d'un « serveur virtuel ») : la passerelle sert les agents de FounderOS.
- Les agents publics (`rag_agents`) ne lisent pas les pools. Un tour de room passe par le moteur à ticks, qui les applique, et le prompt de la room les applique aussi depuis le 12/11/2026. En revanche, le planificateur de la room choisit ses intervenants sans les consulter.
- Une famille intégrée qui exige une configuration se configure toujours sur l'agent ; le pool n'en fixe que la limite.
