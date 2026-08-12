# Limitation d'usage & pricing

Référence opérationnelle du système introduit par la migration
`0194_billing_metering.sql`. Trois questions y trouvent une réponse : comment la
marge est garantie, comment brancher un nouveau fournisseur d'IA, et où le
système bloque réellement.

---

## 1. L'unité : le crédit

Le produit ne coûte pas « une requête ». Il coûte des tokens chez DeepSeek, des
tokens chez Jina, des minutes chez Deepgram. Facturer un nombre de requêtes
laisse la marge dériver dès qu'un agent boucle quarante tours sur un modèle de
raisonnement. On mesure donc le **coût fournisseur réel** de chaque appel, et on
le convertit à taux fixe :

| Constante (`billing_config`) | Valeur | Signification |
|---|---|---|
| `credit_cogs_micro_eur` | 200 | 1 crédit absorbe 0,000200 € de coût fournisseur |
| `credit_list_micro_eur` | 1 000 | 1 crédit vaut 0,001 € au catalogue (1 000 crédits = 1 €) |

**Marge plancher = 1 − 200/1000 = 80 %.**

Ce n'est pas une hypothèse commerciale, c'est une conséquence arithmétique de la
conversion : un fournisseur plus cher consomme davantage de crédits, jamais de
marge. Chaque tarif porte en plus un `margin_multiplier` (≥ 1) pour monter
au-dessus du plancher là où le risque le justifie (génération d'images, GPU).

---

## 2. Les offres

Règle de construction : **la valeur catalogue des crédits inclus reste sous le
prix du plan.** Le forfait paie donc la plateforme *et* laisse la marge au-dessus
du plancher, même si le client consomme la totalité de son allocation.

| Offre | Prix/mois | Crédits inclus | Valeur catalogue | COGS max | Marge si tout consommé |
|---|---|---|---|---|---|
| Découverte (`free`, non commercialisée) | 0 € | 2 000 | 2 € | 0,40 € | coût d'acquisition borné |
| Individual | 29 € | 12 000 | 12 € | 2,40 € | **91,7 %** |
| Pro | 99 € | 60 000 | 60 € | 12,00 € | **87,9 %** |
| Agencies | 349 € | 220 000 | 220 € | 44,00 € | **87,4 %** |
| Enterprise | devis | négocié | — | — | plancher 80 % contractuel |

`free` n'est pas vendue : c'est l'état par défaut d'un workspace tant qu'aucune
offre n'est souscrite. Sans elle, créer un espace de travail poserait le client
sur un plan payant qu'il n'a pas acheté.

**Dépassement** : 1,50 € / 1 000 crédits (marge 86,7 %), uniquement si
`overage_enabled` et dans la limite de `overage_cap_credits`. Sinon on bloque.

**Packs prépayés** (n'expirent pas, consommés après l'allocation mensuelle) :

| Pack | Crédits | Prix | € / 1 000 | Marge |
|---|---|---|---|---|
| `pack_50k` | 50 000 | 60 € | 1,20 € | 83,3 % |
| `pack_200k` | 200 000 | 220 € | 1,10 € | 81,8 % |
| `pack_1m` | 1 000 000 | 1 000 € | 1,00 € | **80,0 % (plancher)** |

### Limites non-token

Portées par `billing_plans.limits` (jsonb, `-1` = illimité) :

| Clé | Individual | Pro | Agencies | Enterprise |
|---|---|---|---|---|
| `services` | 1 | 3 | 15 | ∞ |
| `agents` | 3 | 10 | 50 | ∞ |
| `seats` | 1 | 5 | 20 | ∞ |
| `storage_mb` | 2 048 | 20 480 | 204 800 | ∞ |
| `projects` | 2 | 10 | 50 | ∞ |
| `knowledge_collections` | 3 | 15 | 75 | ∞ |
| `mcp_servers` | 1 | 5 | 25 | ∞ |
| `scheduled_agents` | 2 | 10 | 50 | ∞ |
| `concurrent_runs` | 1 | 3 | 10 | 50 |
| `max_run_credits` | 800 | 4 000 | 15 000 | 100 000 |

---

## 3. Ajouter un fournisseur d'IA

Aucun DDL, aucun code de plomberie. Deux étapes.

**a. Déclarer ses tarifs** (coût réel, en euros par unité) :

```sql
insert into public.ai_provider_rates (provider, sku, unit, unit_cost_eur, match_mode, notes) values
  ('mistral','mistral-large','token_in',  0.00000200, 'contains','2,00 €/M tokens'),
  ('mistral','mistral-large','token_out', 0.00000600, 'contains','6,00 €/M tokens'),
  ('mistral','*','token_in',              0.00000300, 'wildcard','modèle inconnu — tarif prudent'),
  ('mistral','*','token_out',             0.00000900, 'wildcard','modèle inconnu — tarif prudent');
```

**b. Mesurer à l'appel** :

```ts
import { meterLlm } from "../_shared/metering.ts";

await meterLlm({
  workspace_id, project_id, run_id, agent_id,
  provider: "mistral", model: res.model, usage: res.usage,
  feature: "internal-agent-chat",
});
```

Pour un fournisseur non tokenisé (image, audio, stockage), `meterUnits` prend
n'importe quelle unité déclarée : `request`, `second`, `minute`, `image`,
`character`, `gb_month`.

> Un fournisseur branché **sans** tarif tombe sur le joker global
> (`provider = '*'`), délibérément 3 à 10× au-dessus du marché. Une intégration
> oubliée sur-facture le client — visible immédiatement en support — au lieu de
> creuser la marge en silence. C'est un choix : l'erreur bruyante plutôt que
> l'erreur invisible.

Tout appel LLM passant déjà par `logLlmUsage` est métré automatiquement : le
branchement se fait dans `_shared/llm-tracking.ts`, pas dans les ~15 appelants.

---

## 4. Où le système bloque

| Point | Mécanisme | Effet |
|---|---|---|
| Démarrage d'un run (chat/mission) | `assertCredits(min 60)` + `assertQuota('concurrent_runs')` | HTTP **402** avec `quota` exploitable par l'UI |
| Chaque tour de boucle d'agent | `checkRunBudget` + `checkQuota` → `decision.action = "abort"` | Le run se termine proprement : livrables sauvegardés, message explicite |
| Ingestion RAG (`rag-ingest`, `rag-extract-file`) | `assertQuota('storage_mb')` + `assertCredits` | 402 avant d'écrire la source |
| Création d'agent / service / projet / collection / serveur MCP / siège | Trigger `billing_enforce_limit` | L'`INSERT` échoue avec le message de l'offre |

Le contrôle est **fail-open** : si la base ne répond pas au contrôle de quota, on
laisse passer et on trace. Un système de facturation ne doit pas devenir un point
de panne du produit ; le journal rattrape la consommation réelle.

Le métrage, lui, ne bloque jamais : perdre une ligne de journal coûte moins cher
que perdre le travail déjà payé chez le fournisseur.

---

## 5. Contrôle de marge

```sql
select * from public.billing_margin_report(30);
```

Revenu reconnu (forfait + crédits au prix catalogue) contre COGS réel, par
workspace. Sert d'alerte : si un tarif fournisseur a bougé sans que
`ai_provider_rates` soit mis à jour, la colonne `margin_pct` décroche sous 80 %.
Réservée au `service_role`.

Les lignes marquées `billable = false` sont exclues : le runtime d'agent écrit
une ligne par tick (la dépense réelle) **puis** une ligne de synthèse par run
pour le monitoring. Facturer les deux doublerait la note.

---

## 6. Dette assumée

- **Pas de webhook Stripe.** L'achat est appliqué au retour navigateur
  (`create-checkout` action `confirm`), rendu idempotent par
  `billing_checkout_sessions`. Les renouvellements et les échecs de paiement
  demandent un webhook signé — il prendra un slot de fonction Edge dès qu'il y en
  aura un de libre (le projet est à 99/100).
- **`storage_mb` est un scan** de `storage.objects` filtré par projet, mis en
  cache une heure. À revoir si le volume d'objets devient important.
- **Pas de proratisation** au changement d'offre : la période redémarre avec la
  nouvelle allocation.
