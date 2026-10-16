# Serveurs MCP de la plateforme agentique interne

Un serveur MCP par cluster expose les outils de ce cluster à l'orchestrateur de FounderOS. FounderOS tourne sur le Hub et joint chaque serveur par sa Route interne, en mTLS, avec le jeton que ce serveur lui livre. L'architecture complète, avec les flux à ouvrir et l'ordre d'installation, est dans [docs/architecture-hub.md](../docs/architecture-hub.md).

Six modules, 25 tools. Un serveur regroupe les modules de son cluster (`MCP_SERVER=openshift,argocd`, Helm `servers:`). Il tourne dans le namespace `ai-mcp`, derrière une Route en passthrough.

| Module | Clusters | Tools |
| --- | --- | --- |
| `observability` | Hub | `metrics_query`, `logs_query`, `alerts_list`, `dashboard_find`, `db_health`, `alert_silence_create` |
| `fleet` | Hub | `fleet_search`, `policy_compliance` |
| `openshift` | Tous | `pods_list`, `pod_logs`, `events_list`, `deployment_status`, `namespace_overview`, `resource_list`, `resource_get`, `rollout_history`, `pod_metrics`, `deployment_restart`, `deployment_scale` |
| `argocd` | Tous | `app_status`, `app_diff`, `app_history`, `app_sync` (absent en PRD) |
| `git` | IPS | `pr_create` |
| `prtg` | IPS | `sensors_down` |

| Cluster | Valeurs Helm | Modules |
| --- | --- | --- |
| Hub | [cluster-hub.yaml](deploy/values/cluster-hub.yaml) | observabilité, flotte, OpenShift, Argo CD |
| IPS | [cluster-ips.yaml](deploy/values/cluster-ips.yaml) | OpenShift, Argo CD, Git, PRTG |
| SDB | [cluster-sdb.yaml](deploy/values/cluster-sdb.yaml) | OpenShift, Argo CD |
| NPR | [cluster-npr.yaml](deploy/values/cluster-npr.yaml) | OpenShift, Argo CD |
| PRD | [cluster-prd.yaml](deploy/values/cluster-prd.yaml) | OpenShift, Argo CD |

## Jeton d'API tournant (mode par défaut)

FounderOS s'authentifie auprès de chaque serveur avec un jeton d'API propre à ce serveur, qui change chaque jour (`AUTH_MODE=rotating`, Helm `auth.mode: rotating`). Le serveur livre lui-même chaque nouveau jeton à FounderOS : personne ne le recopie.

**Comment le jeton tourne** ([rotating-token.ts](src/lib/rotating-token.ts)) :
- Le jeton se calcule : `mcpt_<id>_<HMAC-SHA256(graine, période)>`, la période étant le jour (`MCP_TOKEN_PERIOD`, 24 h par défaut).
- La graine (256 bits) est générée à l'installation et ne quitte jamais le cluster : un Secret monté. Toutes les répliques calculent le même jeton, sans se coordonner ni rien écrire. L'id, tiré de la graine, ne change pas : l'audit suit le même jeton de jour en jour.
- Le serveur accepte le jeton du jour et celui de la veille, le temps que FounderOS reçoive le nouveau.
- **Livraison :** à chaque nouveau jour, le serveur envoie le jeton à FounderOS (`MCP_FOUNDEROS_URL`, `POST /functions/v1/connector-action`, mode `mcp.token_push`). Comme preuve, il présente en `Bearer` le jeton que FounderOS détient : aucun autre secret partagé. FounderOS le remplace, chiffré, sur toutes les connexions qui le détenaient.
- **Rattrapage :** si FounderOS a manqué des livraisons, le serveur réessaie toutes les 10 minutes avec des jetons plus anciens, jusqu'à 7 jours en arrière. Au-delà, il faut réenrôler (`token current`).
- **Suivi :** la métrique `mcp_token_push_total{result}` et la vérification `jeton:livraison` de `/readyz`. Le journal donne l'id du jeton et la période, jamais le jeton.

```bash
# 1. À l'installation : la graine, et le jeton du jour à coller UNE fois dans FounderOS
#    (Ressources → Serveurs MCP → « Jeton d'API du serveur »).
npm run token -- seed --file seed.txt
#    Dans l'image, sans Node local : node dist/token-cli.js seed --file /tmp/seed.txt
oc -n ai-mcp create secret generic mcp-token-seed --from-file=seed=seed.txt && shred -u seed.txt

# 2. Helm : où livrer les jetons, et les rôles du jeton (les scopes s'en déduisent).
#    auth.founderosUrl: https://founderos-api.apps-int.hub.interne.exemple     auth.roles: [ai-ops-reader]

# Réenrôler (FounderOS arrêté plus de 7 jours, ou connexion recréée) :
oc -n ai-mcp exec deploy/mcp-prd -c mcp -- node dist/token-cli.js current --file /etc/mcp-token-seed/seed
```

À chaque appel, FounderOS envoie `Authorization: Bearer mcpt_…`, plus `X-FounderOS-User` (la personne) et `X-FounderOS-Agent` (l'agent).
- Le serveur compare le jeton en temps constant.
- Il donne à l'appelant les rôles et scopes **du jeton**. La personne et l'agent affirmés servent à l'audit et aux quatre yeux des approbations ; ils n'ajoutent aucun droit.
- Le journal porte le `token_id`.

Un jeton par serveur, avec les rôles minimaux : `ai-ops-reader` pour un serveur en lecture seule.

**Autres modes**, désactivés par défaut :
- `AUTH_MODE=token` : jetons d'API fixes (`npm run token -- generate|list|revoke`), empreintes dans le Secret `mcp-tokens`. En mode `rotating`, un `MCP_TOKENS_FILE` reste accepté en plus (jeton de secours).
- `AUTH_MODE=oidc` : jetons d'appel émis par un IdP (`IDP_ISSUER`, `IDP_JWKS_URL`), par échange de jeton ou On-Behalf-Of. Pour les installations qui en ont un.

## Identifiants des outils, sans Vault

Le serveur ne stocke aucun identifiant Kubernetes, et n'a besoin d'aucun coffre ([secrets.ts](src/lib/secrets.ts), [kubernetes.ts](src/lib/kubernetes.ts)).

| Credential | Usage | D'où vient le secret |
| --- | --- | --- |
| `{ type: "k8s-token", serviceAccount: "mcp-prd-reader" }` | API Kubernetes du cluster | Jeton de 10 minutes demandé à l'API TokenRequest avec le jeton du pod ; gardé jusqu'à une minute avant sa fin ; une seule demande pour des appels simultanés |
| `{ type: "file", path: "/etc/mcp-secrets/argocd/token" }` | Argo CD, Loki, Grafana, recherche ACM, PRTG… | Secret monté en lecture seule (Helm `secretMounts`) |
| `{ type: "env", name: "…" }` | Poste de développement | Variable d'environnement |

Le chart crée, par serveur ([rbac.yaml](deploy/helm/mcp-server/templates/rbac.yaml)) :
- deux comptes dédiés, `mcp-<cluster>-reader` et, si `rbac.write.enabled`, `mcp-<cluster>-operator` ;
- leurs RoleBindings dans les seuls namespaces autorisés (`config.openshift.namespaces`, ou `rbac.namespaces`) ;
- pour le compte du pod, un seul droit : `create serviceaccounts/token` sur ces deux comptes (`resourceNames`).

Les ClusterRoles liés ([clusterroles.yaml](deploy/helm/mcp-server/templates/clusterroles.yaml)) n'ouvrent jamais les Secrets, `exec`, `port-forward` ni la suppression. `ai-operator` (SDB, NPR, IPS, Hub) permet de redémarrer un déploiement et d'en changer le nombre de réplicas. `ai-prd-restarter` (PRD) permet la même chose, toujours sous approbation.

Les identifiants `kv` et `vault-k8s` restent acceptés si `vault.enabled` (autres installations).

## Ce que fait chaque appel

Toute la chaîne est dans [src/lib/](src/lib/), commune aux six modules ([tool.ts](src/lib/tool.ts)) :

1. **Connexion :** TLS avec certificat client obligatoire, signé par l'AC interne. Le CN doit figurer dans `MTLS_ALLOWED_CN` (Helm `tls.allowedClientCNs`) ([mtls.test.ts](test/mtls.test.ts)).
2. **Jeton**, vérifié avant toute lecture du corps de la requête : le jeton tournant du jour ou de la veille, ou un jeton fixe connu, ni expiré ni révoqué.
3. **Débit :** 120 appels par minute et par appelant, rafale de 30. Au-delà, `rate_limited` avec `retry_after_seconds`.
4. **Paramètres :** schéma zod, puis listes blanches du tool. Le test de contrat ([contract.test.ts](test/contract.test.ts)) refuse tout paramètre sans borne. Ces contrôles passent avant toute décision, pour qu'un approbateur ne valide jamais une action qui échouerait.
5. **Jeton d'approbation**, s'il y en a un (en-tête `X-Approval-Token`, [approval.ts](src/lib/approval.ts)) :
   - il est signé par FounderOS (JWKS par fichier, `APPROVAL_JWKS_FILE`, ConfigMap `approval-jwks`) et vaut 5 minutes ;
   - il est lié au demandeur, au tool, au cluster cible et à l'empreinte des paramètres ([canonical.ts](src/lib/canonical.ts)) ;
   - avec une règle à quorum, il porte tous les approbateurs. OPA vérifie qu'aucun n'est le demandeur et que leur nombre atteint `approval_quorum[cluster]` ;
   - **il ne sert qu'une fois** : un rejeu est refusé (`approval_replayed`). Une simulation (`dry_run: true`) ne le consomme pas.
6. **Décision OPA** ([policies/ai_tools.rego](policies/ai_tools.rego)), avec OPA en sidecar du pod :
   - le tool doit figurer au catalogue du cluster ;
   - le scope doit être dans le jeton **et** accordé par un rôle ;
   - sur le Hub (où tourne FounderOS) et en PRD, les écritures exigent l'approbation d'une autre personne.
7. **Exécution :** 16 tools à la fois au plus ; au-delà, 10 secondes d'attente, puis `busy`. Chaque tool dispose de 30 secondes, au-delà c'est `timeout`. L'identifiant vient du credential du module ; le jeton d'appel n'est jamais relayé vers l'outil.
8. **Résultat :** masquage des secrets ([redact.ts](src/lib/redact.ts)), taille bornée, balisage « données non fiables ».
9. **Audit :** une ligne JSON par appel sur la sortie standard ([audit.ts](src/lib/audit.ts)), y compris les refus, `rate_limited`, `busy` et `timeout`. Les métriques Prometheus sont sur le port de gestion.

**Codes d'erreur stables** : `invalid_params`, `denied` (avec `reason`), `approval_required` (avec `params_hash`), `rate_limited`, `busy`, `timeout`, `not_found`, `forbidden`, `upstream_error`. Leur sens et la conduite à tenir sont dans [docs/architecture-hub.md](../docs/architecture-hub.md#5-ce-que-garantit-chaque-serveur-mcp).

**Ce que le module OpenShift ne fait jamais** ([openshift.ts](src/servers/openshift.ts)) :
- lire un Secret : `resource_list` et `resource_get` n'acceptent qu'une liste fermée de types ;
- montrer les valeurs des ConfigMaps ni les variables d'environnement littérales (affichées `[masqué]`) ;
- dépasser `maxReplicas` (10 par défaut) ;
- agir hors des namespaces de sa configuration.

**Chaque écriture accepte `dry_run`** (le test de contrat l'exige) : `dryRun=All` pour Kubernetes, simulation d'Argo CD, silence décrit sans être posé, pull request décrite (fichiers créés ou modifiés) avec un jeton GitHub en lecture seule.

**Relancer ne crée pas de doublon**, ce qui compte après un `timeout` : un silence identique encore valable est rendu, une synchronisation Argo CD en cours n'est pas relancée, la même proposition le même jour rend la pull request déjà ouverte (branche tirée du contenu), un nombre de réplicas déjà atteint ne change rien.

Le catalogue [policies/catalog/data.json](policies/catalog/data.json) est la source unique. OPA le lit sous `data.catalog`, et chaque serveur n'enregistre que les tools prévus pour son cluster : ce qui n'est pas enregistré n'existe pas pour l'agent.

## Disponibilité et supervision

Port de gestion (9090) :
- `/healthz` répond 200 tant que le processus vit.
- `/readyz` rend l'état des vérifications : `{ ready, degraded, checks: [{ name, critical, ok, detail }] }`. Il répond 503 seulement si une vérification critique échoue : OPA injoignable.
- Chaque module vérifie au démarrage, puis toutes les 60 secondes, que ses outils répondent avec l'identifiant configuré : droits RBAC par SelfSubjectAccessReview, namespace par namespace (`openshift:lecture`, `openshift:écriture`), Observatorium, Loki, Alertmanager, Grafana, projets Argo CD, GitHub App, PRTG, ACM Search et politiques. La livraison du jeton (`jeton:livraison`) l'est aussi. Un échec rend le serveur « dégradé », sans le retirer du service.
- `/metrics` expose `ai_tool_calls_total`, `ai_tool_denied_total{reason}`, `ai_tool_duration_seconds`, `mcp_token_push_total{result}` et `mcp_check_ok{check}`.

## Développer

```bash
cd MCP
npm install
npm test            # 173 tests : contrat des tools, jetons, mTLS, garde-fous, RBAC, Kubernetes, vérifications des modules, politique, intégration MCP
npm run typecheck
opa test policies -v   # 17 tests de la politique
```

Lancer un serveur en local, sans TLS ni OPA (poste de développement uniquement) :

```bash
npm run token -- seed --file /tmp/seed.txt
MCP_SERVER=argocd MCP_CLUSTER=npr MCP_CONFIG_FILE=config/examples/argocd.prd.json \
MCP_TOKEN_SEED_FILE=/tmp/seed.txt POLICY_ENGINE=builtin MCP_INSECURE_HTTP=1 \
npm run dev
npm run token -- current --file /tmp/seed.txt    # le jeton à présenter en Bearer
```

## Construire et déployer

```bash
# Une image pour tous les modules
docker build -t quay.interne.exemple/ai-platform/mcp-server:0.2.0 .

# Un serveur par cluster (graine, Secrets des outils et ConfigMaps : docs/architecture-hub.md, section 7)
helm upgrade --install mcp-prd deploy/helm/mcp-server -n ai-mcp -f deploy/values/cluster-prd.yaml
```

Une seule release par cluster crée les ClusterRoles (`rbac.clusterRoles.create`).

FounderOS en cloud : le serveur s'installe dans la **passerelle d'entreprise**, avec le relais, sans port entrant. Le serveur n'y écoute que sur 127.0.0.1 (`MCP_HOST`) ; seul le relais du même pod le joint. Voir [docs/install](../docs/install/README.md#mode-cloud--la-passerelle-dentreprise) et le chart `deploy/helm/founderos-gateway`.

## Ajouter un tool

1. Le déclarer dans [policies/catalog/data.json](policies/catalog/data.json) :
   - `scopes` : son scope ;
   - `tools.<cluster>` : les clusters où il existe ;
   - `write_tools` : s'il écrit ;
   - `approval_required` : s'il exige une approbation. Toute écriture sur le Hub ou en PRD doit en exiger une : le test de contrat le vérifie.
2. L'écrire dans le module concerné ([src/servers/](src/servers/)) avec `defineTool` : des paramètres bornés (enum, plafonds, expressions ancrées), un `validate()` pour les listes blanches, et `dry_run` pour une écriture.
3. Ajouter ses tests de paramètres refusés dans [test/tools.test.ts](test/tools.test.ts), et un cas dans [policies/ai_tools_test.rego](policies/ai_tools_test.rego) s'il change la politique.
4. S'il touche une nouvelle ressource Kubernetes, l'ajouter au ClusterRole concerné ([clusterroles.yaml](deploy/helm/mcp-server/templates/clusterroles.yaml)), et à la vérification RBAC du module si c'est une écriture.

Au démarrage, le serveur vérifie que le code et le catalogue sont d'accord (lecture ou écriture, scope connu) : un écart l'empêche de démarrer. Le test de contrat vérifie le reste : tools existants, paramètres bornés, valeurs Helm de chaque cluster.
