# Outillage par lots, contexte progressif et spécialistes

Branche `harness-opencode`, backend local seulement (`PLATFORM=self`, `HARNESS_OPENCODE=1`). Code : `backend/src/harness/toolkit/`.

## Le problème

L'ancien moteur donnait à un agent jusqu'à 105 outils fixes, plus un outil par connecteur, action Composio ou outil MCP. Deux défauts :

- **Trop d'outils à la fois.** Le modèle sature : choix lents, mauvais outil, arguments inventés.
- **Des doublons.** Six outils allaient chercher du contexte (`search_context`, `search_memory`, `search_knowledge`, `knowledge_search`, `search_past_work`, `recall_findings`), quatre écrivaient en mémoire, dix géraient des artefacts. Leurs descriptions se ressemblaient et induisaient le modèle en erreur.

## Les trois principes

1. **Un outil par famille.** Chaque famille devient un seul outil avec un paramètre `action` (ou `type`, `target`, `language`), dont chaque valeur est décrite. Derrière, ce sont les handlers de l'ancien moteur, inchangés. `prepareAgentToolset` les prépare dans `internal-agent-run`.
2. **Des lots.** Le modèle voit un noyau de 8 outils et la liste des lots. Il ouvre un lot (`open_lot`) et voit alors ses outils. S'il s'est trompé, il en ouvre un autre : un seul lot est ouvert à la fois. Le filtrage passe par le hook `context` d'OpenCode, appelé à chaque requête. Un outil retiré n'est ni montré ni exécutable.
3. **Des spécialistes.** L'agent confie une tâche délimitée à un sous-agent (outil `subagent` d'OpenCode). Ce sous-agent ne voit que ses instructions, les données passées dans la consigne, les outils de son métier et les skills de son métier.

## Le noyau (toujours visible)

| Outil | Rôle |
|---|---|
| `build_context` | Aller chercher du contexte, d'un ou plusieurs `types` à la fois |
| `context_page` | Lire progressivement ce que `build_context` a trouvé ; `keep` / `drop` |
| `remember` | Enregistrer : `kind` = fact, preference, team ou knowledge |
| `open_lot` | Ouvrir un lot (et fermer le précédent) |
| `todowrite` | Liste de tâches (natif OpenCode, activé par `experimental.todo`) |
| `question` | Demander à la personne (natif) |
| `skill` | Charger un skill de l'agent (natif ; skills FounderOS enregistrés) |
| `subagent` | Lancer un spécialiste (natif ; seuls les spécialistes FounderOS existent) |

### build_context et context_page

`build_context({ query, types, limit?, filter? })` interroge les sources en parallèle. Chaque résultat est découpé en morceaux (`c1`, `c2`…), et chaque morceau est rangé dans une balise à son type :

```
<context query="Acme" pieces="9" size="5214">
<memory count="2">
[c1] Acme : contact Léa Martin (61 car.)
[c2] Acme préfère le vouvoiement (48 car.)
</memory>
<documents count="7">
[c3] Contrat cadre Acme 2026, article 4 (812 car.)
…
</documents>
<facts count="0">rien trouvé</facts>
</context>
```

Le résultat prend deux formes selon sa taille :
- **Court** (2 500 caractères au plus) : le texte vient directement, `<memory id="c1" source="search_memory">…</memory>`.
- **Long** : un index, comme ci-dessus.

`context_page` lit ensuite les morceaux par identifiant (`ids`), ou un type page par page (`type`, `page` ; 8 000 caractères par page). `keep` garde des morceaux : ils reviennent à chaque requête de la session dans `<working_context>` (6 000 caractères au plus), jusqu'à `drop`.

| Type | Contenu | Ancien outil |
|---|---|---|
| `conversation` | Étapes plus anciennes de ce travail | `search_history` |
| `memory` | Mémoire durable de l'agent | `search_memory` |
| `team` | Mémoire partagée de l'équipe | `team_memory` (search) |
| `past_work` | Livrables des travaux précédents | `search_past_work` |
| `findings` | Trouvailles notées pendant ce travail | `recall_findings` |
| `documents` | Base de connaissances (passages) | `search_knowledge` |
| `facts` | Graphe de connaissances (entités, faits) | `knowledge_search` |
| `company` | Objectifs et organisation | `company_objectives` + `explore_company_graph` |
| `artifacts` | Artefacts déjà produits | `list_artifacts` |
| `resources` | Applications, collections, automatisations | `my_resources` |
| `table` | Lignes d'une table, en lecture seule (`filter.table`) | `query_table` |

Un type n'est proposé que si l'agent a l'outil qui le lit.

## Les lots

Un outil regroupé ne montre que les actions que l'agent possède. Un lot vide n'est pas listé.

| Lot | Outils | Anciens outils regroupés |
|---|---|---|
| `web` | `web` (search, read, research, download, get, request), `browser` (runner, sandbox, user) | web_search, read_url, deep_research, download_file, http_get, http_request, browse_web, sandbox_browser, user_browser |
| `livrables` | `document` (deliver, section, create, update, add_block, publish, read, list, assets, link), `report`, `generate` (pdf, image), `interface` (render, guide, page) | 16 outils |
| `applications` | `apps` (list, describe, call) | crm, send_email, run_automation, dashboard, list_connectors, et **tous** les outils dynamiques : `mcp_*`, `ext_*`, Composio |
| `metier` | Un outil par produit de l'agent, tel quel | tracker, vibe_code, lead_sense, support_desk, sentinel, security_scan, pentest_scope, testing, simulation, training, policy_audit |
| `equipe` | `team` (list, message, delegate, handoff), `mission` (create, list, move, propose, task, workflow, new_agent), `workflow` (list, create, configure, add_block, link, activate) | 17 outils |
| `execution` | `run_code` (shell, python, node, jupyter), `remote_files`, `process`, `machine`, avec `world` = runner, sandbox ou team quand l'agent a plusieurs machines | 24 outils, dont les variantes `runner_*` / `sandbox_*` / `team_*` |
| `fichiers` | `read`, `write`, `edit`, `glob`, `grep` (natifs, dossier de l'agent) | file_read, file_write, file_edit, list_files, file_search |
| `admin` | `admin` (agents, projects, connectors, teams, dashboards). Assistant de service seulement | manage_* |

Les **applications** suivent le même principe en trois temps : `list` (une ligne par application), `describe` (le schéma complet d'une seule), puis `call`. Le modèle ne reçoit jamais d'un coup les schémas de cinquante outils MCP.

### Retirés

Ces outils de l'ancien moteur disparaissent :
- **remplacés par le noyau OpenCode :** `load_toolset`, `need_tools`, `list_skills`, `use_skill`, `read_skill_file`, `use_procedure`, `update_todos`, `ask_user`, `say`, `spawn_parallel_agents`, `message_subagent`, `read_tool_output` ;
- **remplacés par `build_context` :** `search_context` et les dix outils de lecture du tableau des types ;
- **remplacés par `remember` :** `save_memory`, `remember_preference`, `knowledge_save`, `team_memory`.

Au démarrage, `uncovered()` signale tout ancien outil qu'aucun outil ne sert. Un outil ajouté à l'ancien moteur ne peut donc pas disparaître en silence.

**Ordre de grandeur.** Un agent très équipé voit 8 outils au départ, puis 8 + 1 à 4 avec un lot ouvert. Avant, c'était 60 à 120.

## Les spécialistes

| Spécialiste | Outils | Types de contexte | Skills retenus (catégorie, slug ou nom) |
|---|---|---|---|
| `chercheur` | web, browser | documents, facts, findings | research, veille, seo, marché… |
| `redacteur` | document, report, generate | documents, past_work, artifacts | rédaction, rapport, contenu, brand… |
| `analyste` | run_code, remote_files | table, company, documents | data, analyse, finance, kpi… |
| `integrateur` | apps | resources | intégration, crm, mail, api… |
| `operateur` | run_code, remote_files, process, machine | conversation, documents | code, devops, infra, test… |

Un spécialiste n'existe que si l'agent a au moins un de ses outils. Il voit :
- **son prompt** : ses instructions et la consigne de compte rendu, sans le prompt de l'agent, sa personnalité ni son entreprise ;
- **ses outils** : `build_context` (limité à ses types), `context_page`, `todowrite`, `skill` et ses outils métier ;
- **ses skills** : ceux de son métier, par permissions (`skill` refusé sauf ses slugs).

Il n'a ni `subagent`, ni `question`, ni `remember`, ni `open_lot`. Les sous-agents livrés avec OpenCode (general, explore…) sont retirés.

## Limites connues (à traiter en phase 4)

- Les handlers tournent avec un run nul : les approbations humaines (`requires_approval`) et `search_history` (lié au run) ne marchent pas encore sur ce chemin.
- Le lot ouvert et le contexte gardé vivent en mémoire, par session : un redémarrage les vide, et le modèle rouvre le lot.
- Le tri des skills entre spécialistes se fait par mots-clés. Une table de spécialistes par agent (instructions, outils, skills choisis dans l'application) reste à faire.
- Changer les outils à chaque étape casse le cache du bloc d'outils chez le fournisseur ; le prompt système reste en cache.

## Tests

`backend/src/harness/toolkit.test.ts`, 12 tests. Ils couvrent :
- le catalogue ;
- le découpage, l'index, la pagination et `keep` ;
- dans une vraie instance OpenCode avec la fausse passerelle : le noyau seul au départ, l'ouverture et la fermeture des lots avec le vrai schéma, le contexte balisé et épinglé ;
- un spécialiste qui ne voit que ses outils, ses instructions et ses skills.
