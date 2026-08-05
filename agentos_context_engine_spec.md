# AgentOS — Context Engine & Prompt Compiler

**v1.0 — spécification technique**
Périmètre : construction du contexte et compilation du prompt. Ne couvre ni l'exécution durable, ni les outils métier, ni la mémoire longue (specs séparées).

---

## 0. Position dans le kernel

```
Run State ──┐
Agent Config ┤
Memory ──────┼──►  CONTEXT ENGINE  ──►  PROMPT COMPILER  ──►  Model Runtime
Knowledge ───┤     (quoi inclure)       (comment assembler)
History ─────┤
Tools ───────┘
                          │
                          └──►  Compile Manifest  ──►  télémétrie / eval
```

Le Context Engine décide **ce qui entre**. Le Prompt Compiler décide **dans quel ordre et sous quelle forme**. La séparation compte : le premier est une question de pertinence et de coût, le second de cache et de contrat.

---

## 1. Principes

1. **Deny by default.** Rien n'entre dans le prompt sans avoir été sélectionné. L'inverse du système actuel, où tout entre et où on tronque après.
2. **Le budget est déclaré avant la sélection**, jamais constaté après. Un fragment sait ce qu'il coûte avant d'être rendu.
3. **Le préfixe est immuable.** Toute mutation au milieu du transcript invalide le cache fournisseur. On n'ajoute jamais qu'en fin.
4. **La compression est un contrat de l'outil**, pas une fonction globale. Seul l'outil sait où est le signal dans sa sortie.
5. **Tout fragment porte sa provenance.** Un prompt compilé doit être explicable ligne par ligne.
6. **Ne pas inclure > référencer > compresser déterministe > résumer par LLM.** Dans cet ordre, toujours.

---

## 2. Contrats

```ts
type Stability = "static" | "per_run" | "per_turn";

type FragmentKind =
  | "identity" | "doctrine" | "capability" | "tool_schema"
  | "memory" | "knowledge" | "history" | "focus" | "task" | "nudge";

interface Fragment {
  id: string;
  kind: FragmentKind;
  stability: Stability;

  /** 0 = épinglé, jamais éjecté ni compressé. */
  priority: number;

  /** Coût en tokens SANS rendre le contenu (lecture d'un compteur stocké,
   *  jamais d'appel réseau). La sélection doit pouvoir chiffrer des candidats
   *  sans payer leur matérialisation. */
  estimate(): number;

  /** Rendu au niveau de compression demandé. level 0 = intégral. */
  render(level: 0 | 1 | 2 | 3): string;

  /** Interdit toute compression (schémas, contrats de sortie). */
  incompressible?: boolean;

  provenance: { source: string; ref?: string; incident?: string };
}

interface Budget {
  total: number;                       // tokens d'entrée visés
  floor: Record<FragmentKind, number>; // minimum garanti
  ceil:  Record<FragmentKind, number>; // plafond
}

interface CompileResult {
  messages: ChatMessage[];
  tools: ToolDef[];
  manifest: CompileManifest;
}
```

`estimate()` séparé de `render()` est le point non négociable : sans lui, la sélection doit matérialiser tous les candidats pour les chiffrer, ce qui annule le gain.

---

## 3. Pipeline

```
1. CLASSIFY    déterministe, 0 appel réseau        → classe + modificateurs
2. BUDGET      table par classe                     → Budget
3. COLLECT     candidats lazy (estimate seulement)  → Fragment[]
4. RETRIEVE    lexical → sémantique, si la classe l'exige
5. SELECT      sac à dos par priorité sous budget
6. COMPRESS    par fragment, niveau progressif
7. ASSEMBLE    ordre imposé par `stability`
8. VERIFY      invariants (§9)
9. EMIT        messages + tools + manifest
```

---

## 4. Étage 1 — Classification

Aucun LLM, aucun embedding. Signaux : longueur, regex, présence d'historique, continuation, mode (chat/mission/room), mention explicite d'un nom d'outil, outils déjà utilisés dans le fil, présence de critères d'acceptation.

| Classe | Outils | Mémoire | Plan | Retrieval | Budget cible |
|---|---|---|---|---|---|
| `social` | **1** (`need_tools`) | aucune | non | non | ~300 tok |
| `qa` | noyau (6) | épinglées | non | lexical si identifiants détectés | ~2 000 |
| `task` | noyau + famille primaire | oui | oui | hybride | ~8 000 |
| `deep` | noyau + familles pertinentes | oui | oui | hybride + travaux passés | plein |

Modificateurs cumulables : `resume` (continuation), `recovery` (le run a replanifié), `security` (skill cybersécurité activée).

### Échappatoire d'escalade

La classe `social` n'envoie **pas zéro outil** — elle en envoie exactement un :

```ts
{ name: "need_tools",
  description: "Appelle-moi si cette demande exige une action (fichier, web, données, envoi…) plutôt qu'une simple réponse.",
  parameters: { reason: "string" } }
```

Si le modèle l'appelle, le tour est **recompilé en `task`** et rejoué. Coût : ~60 tokens de schéma au lieu de ~10 000, et aucun mode d'échec silencieux. C'est ce qui rend la classification agressive acceptable.

---

## 5. Étage 2 — Budget

Le budget n'est pas un plafond de sécurité, c'est une **allocation**. Chaque `kind` a un plancher garanti et un plafond.

Exemple pour `task`, cible 8 000 tokens :

| kind | plancher | plafond |
|---|---|---|
| `identity` | 150 | 300 |
| `doctrine` | 0 | 500 |
| `tool_schema` | 1 200 | 3 500 |
| `capability` | 200 | 600 |
| `task` | 800 | 1 500 |
| `focus` | 200 | 400 |
| `memory` | 0 | 800 |
| `knowledge` | 0 | 1 200 |
| `history` | 0 | 1 000 |

Un plancher non finançable est une **erreur de compilation**, pas une troncature silencieuse.

---

## 6. Étage 3 — Sélection des outils

C'est le premier poste de coût : 59 schémas ≈ 7–11 k tokens par round dans l'implémentation actuelle.

### Noyau permanent (6)

| Outil | Rôle |
|---|---|
| `ask_user` | clarification / blocage |
| `update_todos` | état du plan |
| `create_deliverable` | sortie durable |
| `search_context(scope)` | **unifie** `search_history`, `search_memory`, `search_past_work`, `search_knowledge` |
| `load_toolset(family)` | divulgation progressive |
| `say` | progression (chat/room uniquement) |

`search_context` remplace quatre outils par un paramètre `scope: "run" | "agent" | "team" | "kb" | "past_runs"`. Gain double : trois schémas en moins, et disparition de l'hésitation du modèle entre quatre outils quasi synonymes.

### Familles à la demande

Les 8 familles existantes (`EXECUTION`, `WEB`, `DATA`, `PLAN`, `DELIVER`, `MEMORY`, `TEAM`, `INTEGRATIONS`) restent le découpage. La famille **primaire de l'agent** (déduite de sa config : `sandbox_mode`, `kind` des outils accordés, spécialisation) est préchargée ; les autres arrivent via `load_toolset`.

**La sélection d'outils par embedding est écartée** : rater le bon outil rend la tâche impossible et l'échec est muet. Le chargement explicite est déterministe, débuggable, et sans appel supplémentaire par tour.

---

## 7. Étage 4 — Retrieval (« grep »)

Un agent cherche `src/foo.ts`, `ECONNREFUSED`, un id de run. C'est de l'**exact match**, pas du concept — le vecteur y est mauvais.

### Voie lexicale (par défaut)

```sql
alter table internal_agent_run_events
  add column search_tsv tsvector generated always as (
    to_tsvector('simple',
      coalesce(payload->>'tool','') || ' ' ||
      coalesce(payload->>'preview','') || ' ' ||
      coalesce(payload->>'message',''))
  ) stored;

create index on internal_agent_run_events using gin (search_tsv);
create index on internal_agent_run_events using gin ((payload->>'preview') gin_trgm_ops);
```

- `websearch_to_tsquery` pour les mots.
- `similarity()` (pg_trgm) pour les identifiants, chemins, messages d'erreur.
- Coût : une requête indexée. Aucun appel externe.

### Voie sémantique

pgvector, **uniquement** si la voie lexicale ne rend rien ou si la requête est conceptuelle (absence de token identifiant : pas de `/`, `.`, `_`, majuscules internes, code d'erreur).

### Fusion

RRF (`1/(60+rank)`) quand les deux voies tournent. Déduplication par hash de contenu.

### Placement

Le retrieval est **une étape de compilation**, pas seulement un outil. L'agent ne devrait pas dépenser un round pour retrouver ce que le compilateur pouvait poser sur la table. `search_context` reste exposé pour les recherches que le compilateur ne pouvait pas anticiper.

---

## 8. Étage 5 — Compression

### Niveaux

| Niveau | Sémantique |
|---|---|
| 0 | intégral |
| 1 | boilerplate retiré |
| 2 | structurel : tête + **queue** conservées, statut/exit code préservés |
| 3 | verdict en une ligne |

La conservation de la **queue** est un correctif : une stack trace porte l'information à la fin, et la troncature actuelle coupe par la tête à 350 caractères.

### Contrat par outil

```ts
interface InternalTool {
  def: ToolDef;
  run(args): Promise<string>;
  /** Compression déclarée. Défaut = générique. */
  compress?(result: string, level: 1 | 2 | 3): string;
}
```

Exemples : `shell_exec` garde exit code + fin de stderr ; `web_search` garde titres + URLs ; `file_read` garde la structure ; `query_table` garde le schéma + N lignes.

### Passes génériques

1. déduplication par hash des résultats identiques ;
2. effondrement des échecs répétés (`× N`) ;
3. troncature tête+queue ;
4. **LLM en dernier recours uniquement**, calculé une fois, mis en cache par hash de contenu, jamais recalculé par tick.

### Interdit de compression

Tout fragment `incompressible: true` — schémas de sortie, contrats JSON, énumérations. C'est l'invariant qui empêche la régression observée en production (§11).

---

## 9. Étage 6 — Assemblage, cache et scellement

### Disposition imposée

```
[STATIC]     identité · doctrines · schémas d'outils      immuable pour la config d'agent
[PER_RUN]    objectif · snapshot mémoire · index skills   figé au démarrage du run
[SEALED]     résumés de segments scellés                  append-only
[LIVE]       messages récents                             append-only
[EPHEMERAL]  FOCUS · nudges · retrieval du tour           ajouté à l'ENVOI, jamais stocké
```

**Invariant de cache** : seuls `SEALED` et `LIVE` croissent, et uniquement par ajout en fin. `EPHEMERAL` est concaténé au moment de l'envoi, après `LIVE` — il coûte ses propres tokens chaque tour mais n'invalide rien avant lui.

### Scellement (remplace la compaction par découpe)

Quand `LIVE` dépasse le seuil :

1. choisir une **frontière sûre** — jamais entre un `assistant(tool_calls)` et ses réponses ;
2. résumer les messages en amont **une fois** ;
3. ajouter le résumé à `SEALED` ;
4. retirer les messages scellés de `LIVE`.

Le cache est invalidé **au scellement uniquement**, pas à chaque tick. Amorti : une fois toutes les *N* itérations au lieu de chaque tour.

### Ce que ça corrige

| Aujourd'hui | Effet |
|---|---|
| FOCUS stocké puis retiré du milieu au tick suivant | invalide ~1 tick de contexte à chaque tour |
| `compactMessagesIfNeeded` splice le milieu | invalide tout ce qui suit |

Les deux disparaissent : FOCUS devient `EPHEMERAL`, la compaction devient un scellement par ajout.

---

## 10. Étage 7 — Vérification

Invariants évalués avant émission. Une violation est une **erreur**, pas un avertissement.

1. Appariement `tool_calls` / `tool` valide (garder l'implémentation existante).
2. Total ≤ `budget.total`.
3. Aucun fragment de priorité 0 éjecté.
4. Aucun fragment `incompressible` rendu à un niveau > 0.
5. `prefix_hash` inchangé depuis le dernier scellement (sinon : télémétrie de manque de cache).
6. Tout plancher de budget est financé.

---

## 11. Régression que ces invariants ferment

`create_deliverable` porte dans sa description les 4 schémas structurés (report + coding_session + test_session + simulation_session), soit **4 663 caractères**. `compactToolDefs` tronque uniformément toute description à **140 caractères**. Le paramètre `content` renvoie à *« the JSON string described above »* — une description qui n'existe plus à l'envoi.

Le modèle doit donc produire un JSON conforme à un schéma qu'il ne reçoit jamais. Toute la machinerie de rattrapage en aval (coercition objet→string, dégradation silencieuse en markdown, sauvetage de `report_draft`, garde-fou « livrable revendiqué », matérialisation serveur) compense cette seule cause.

Invariant 4 rend la régression impossible par construction.

---

## 12. Manifeste de compilation

Chaque compilation émet un manifeste persisté :

```json
{
  "run_id": "…", "tick": 7, "class": "task",
  "budget": { "total": 8000 },
  "fragments": [ { "id": "tools.core", "kind": "tool_schema", "tokens": 1180, "level": 0 } ],
  "dropped":   [ { "id": "memory.semantic", "reason": "budget", "tokens": 640 } ],
  "retrieval": { "lane": "lexical", "hits": 3, "ms": 12 },
  "prefix_hash": "sha256:…", "cache_expected": true,
  "total_tokens": 7420
}
```

Ce manifeste est simultanément : la surface de debug, la source de la télémétrie de coût, et le dataset de la couche Eval. Sans lui, aucune régression de prompt n'est détectable.

---

## 13. Correspondance avec l'existant

| Aujourd'hui | Devient |
|---|---|
| `buildSystemPrompt` (concaténation) | fragments `identity` + `doctrine` gatés par capability |
| `SECURITY_DOCTRINE` / `ORCHESTRATOR_DOCTRINE` (`if` en dur) | fragments `doctrine`, activés par capability déclarée |
| `buildCapabilityTree` | fragment `capability`, généré depuis les familles chargées |
| `compactToolDefs` (140 uniforme) | compression par fragment + `incompressible` |
| `loadMemorySection` (top 25 + rerank, 3 500 c.) | fragment `memory` `per_run` + retrieval par tour |
| FOCUS poussé dans le transcript | fragment `focus`, `EPHEMERAL`, injecté à l'envoi |
| `compactMessagesIfNeeded` (splice) | scellement par ajout |
| `shrinkOldToolResults` (350 c., par la tête) | compresseurs déclarés par outil, tête+queue |
| `search_history` / `search_memory` / `search_past_work` / `search_knowledge` | `search_context(scope)` |
| `classifyTier` (choisit le modèle) | classifieur → classe + budget + modèle |

**Conservé tel quel** : le moteur de ticks (pgmq + bail + `agent_tick_next`), les 8 familles d'outils, le principe du header FOCUS, la divulgation progressive des skills, l'appariement `tool_calls`.

---

## 14. Effets attendus

| Scénario | Aujourd'hui | Cible |
|---|---|---|
| « salut » | ~10–15 k tokens d'entrée | ~300 (×40) |
| Question courte sur le fil | ~12 k | ~2 000 |
| Tâche outillée, tick 1 | ~12 k | ~8 000 |
| Tâche outillée, tick 20 | ~12 k **sans cache** | ~8 000 **majoritairement en cache** |
| Rapport structuré | schéma jamais transmis | schéma garanti transmis |

Le gain le plus important n'est pas la réduction par tour : c'est le **cache de préfixe sur les runs longs**, aujourd'hui perdu à chaque tick par la mutation du milieu du transcript.

---

## 15. Ce que ceci ne règle pas

Les règles contradictoires du prompt actuel (« ASK only when truly blocked » vs « ASK a brief clarifying question ») relèvent de la **curation**, pas de la compilation. Un compilateur recompile fidèlement une incohérence.

Règle associée, à tenir dès le rebuild : **toute règle de prompt est attachée à une capability, porte une provenance (l'incident qui l'a produite) et possède un test**. Sans quoi la sédimentation reprend, simplement mieux rangée.
