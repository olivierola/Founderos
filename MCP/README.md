# Serveurs MCP de la plateforme agentique interne

Six modules, 19 tools : le catalogue de la doc d'architecture, et rien d'autre. Un serveur par cluster regroupe les modules de ce cluster (`MCP_SERVER=openshift,argocd`). Il tourne dans le namespace `ai-mcp`, derrière une Route interne en passthrough, avec une audience Keycloak `mcp-<cluster>`. Un module peut aussi être déployé seul (`MCP_SERVER=argocd`, audience `mcp-argocd-<cluster>`).

| Module | Cluster | Tools |
| --- | --- | --- |
| `observability` | Hub | `metrics_query`, `logs_query`, `alerts_list`, `dashboard_find`, `db_health`, `alert_silence_create` |
| `fleet` | Hub | `fleet_search`, `policy_compliance` |
| `openshift` | SDB, NPR, PRD, IPS | `pods_list`, `pod_logs`, `events_list`, `deployment_status`, `deployment_restart` |
| `argocd` | SDB, NPR, PRD, IPS | `app_status`, `app_diff`, `app_history`, `app_sync` (absent en PRD) |
| `git` | IPS | `pr_create` |
| `prtg` | IPS (à confirmer) | `sensors_down` |

La mise en place complète (Keycloak, Vault, OpenShift, FounderOS) est décrite dans [docs/openshift-implementation.md](../docs/openshift-implementation.md).

## Jeton d'API tournant (mode par défaut)

FounderOS s'authentifie auprès du serveur avec un jeton d'API qui change chaque jour (`AUTH_MODE=rotating`, Helm `auth.mode: rotating`). Le serveur livre lui-même chaque nouveau jeton à FounderOS : personne ne le recopie. Le modèle et ses garanties sont dans [docs/enterprise-generalisation.md](../docs/enterprise-generalisation.md), section 5 bis.

**Comment le jeton tourne** ([rotating-token.ts](src/lib/rotating-token.ts)) :
- Le jeton se calcule : `mcpt_<id>_<HMAC-SHA256(graine, période)>`, la période étant le jour (`MCP_TOKEN_PERIOD`, 24 h par défaut).
- La graine (256 bits) est générée à l'installation et ne quitte jamais le serveur : un Secret monté. Toutes les répliques calculent le même jeton, sans se coordonner ni rien écrire. L'id, tiré de la graine, ne change pas : l'audit suit le même jeton de jour en jour.
- Le serveur accepte le jeton du jour et celui de la veille, le temps que FounderOS reçoive le nouveau.
- **Livraison :** à chaque nouveau jour, le serveur envoie le jeton à FounderOS (`MCP_FOUNDEROS_URL`, `POST /functions/v1/connector-action`, mode `mcp.token_push`). Comme preuve, il présente en `Bearer` le jeton que FounderOS détient : aucun autre secret partagé. FounderOS le remplace, chiffré, sur toutes les connexions qui le détenaient.
- **Rattrapage :** si FounderOS a manqué des livraisons, le serveur réessaie toutes les 10 minutes avec des jetons plus anciens, jusqu'à 7 jours en arrière. Au-delà, il faut réenrôler (`token current`).
- **Suivi :** la métrique `mcp_token_push_total{result}` ; le journal donne l'id du jeton et la période, jamais le jeton.

```bash
# 1. À l'installation : la graine, et le jeton du jour à coller UNE fois dans FounderOS
#    (Ressources → Serveurs MCP → « Jeton d'API du serveur »).
npm run token -- seed --file seed.txt
#    Dans l'image, sans Node local : node dist/token-cli.js seed --file /tmp/seed.txt
kubectl -n ai-mcp create secret generic mcp-token-seed --from-file=seed=seed.txt && shred -u seed.txt

# 2. Helm : où livrer les jetons, et les rôles du jeton (les scopes s'en déduisent).
#    auth.founderosUrl: https://founderos-api.<domaine>     auth.roles: [ai-ops-reader]

# Réenrôler (FounderOS arrêté plus de 7 jours, ou connexion recréée) :
kubectl -n ai-mcp exec deploy/mcp-prd -c mcp -- node dist/token-cli.js current --file /etc/mcp-token-seed/seed
```

**Jetons fixes** (`AUTH_MODE=token`, Helm `auth.mode: token`) : l'ancien modèle reste disponible, par exemple pour un serveur qui ne peut pas joindre FounderOS.

```bash
# Il s'affiche une seule fois ; tokens.json ne garde que son empreinte SHA-256.
# Sans --scope, les scopes sont ceux que le catalogue accorde aux rôles. Expiration : 90 jours (--expires).
npm run token -- generate --label founderos --role ai-ops-operator --file tokens.json
kubectl -n ai-mcp create secret generic mcp-tokens --from-file=tokens.json=tokens.json --dry-run=client -o yaml | kubectl apply -f -
npm run token -- list --file tokens.json
npm run token -- revoke --id <id> --file tokens.json      # puis republier le Secret
```

En mode `rotating`, un `MCP_TOKENS_FILE` reste accepté en plus du jeton tournant (jeton de secours).

À chaque appel, FounderOS envoie `Authorization: Bearer mcpt_…`, plus `X-FounderOS-User` (la personne) et `X-FounderOS-Agent` (l'agent).
- Le serveur compare le jeton en temps constant ([rotating-token.ts](src/lib/rotating-token.ts), [api-tokens.ts](src/lib/api-tokens.ts)).
- Il donne à l'appelant les rôles et scopes **du jeton**. La personne et l'agent affirmés servent à l'audit et aux quatre yeux des approbations ; ils n'ajoutent aucun droit.
- Le journal porte le `token_id`.
- Tout le reste de la chaîne (OPA, catalogue, approbations, Vault) est inchangé.

Un jeton par serveur, avec les rôles minimaux : `ai-ops-reader` pour un serveur en lecture seule.

## Mode oidc : qui émet le jeton d'appel

Avec `AUTH_MODE=oidc` (Helm `auth.mode: oidc`), le serveur ne connaît qu'un émetteur et son JWKS (`IDP_ISSUER`, `IDP_JWKS_URL`). Trois cas :
- **Keycloak, Okta…** (échange de jeton) : l'IdP de l'entreprise.
- **Entra ID** (On-Behalf-Of) : `https://login.microsoftonline.com/<tenant>/v2.0`, avec `CALL_TOKEN_MAX_LIFETIME=5460` et `APPROVAL_AUDIENCE`. La personne est lue dans `oid`.
- **Contexte signé par FounderOS** : l'émetteur des approbations et `/functions/v1/approval-jwks`. `ALLOWED_AGENTS` liste les noms des agents, plus `founderos-discovery`.

Un serveur derrière le pare-feu se déclare « par le relais » dans FounderOS. Son hôte va dans `RELAY_ALLOWED_HOSTS`, et dans `RELAY_CLIENT_CERT_HOSTS` pour le mTLS (voir `connector-relay/README.md`).

## Ce que fait chaque appel

Toute la chaîne est dans [src/lib/](src/lib/), commune aux six modules :

1. **Connexion :** TLS avec certificat client obligatoire, signé par l'AC interne. Le CN doit figurer dans `MTLS_ALLOWED_CN`.
2. **Jeton**, vérifié avant toute lecture du corps de la requête :
   - jeton d'API : le jeton tournant du jour ou de la veille ([rotating-token.ts](src/lib/rotating-token.ts)), ou un jeton fixe connu, ni expiré ni révoqué ([api-tokens.ts](src/lib/api-tokens.ts)) ;
   - ou, en mode oidc ([auth.ts](src/lib/auth.ts)) : signature (JWKS de l'IdP), `iss`, `aud` (le serveur de ce cluster) et `exp` ;
   - durée de vie de 5 minutes au plus ;
   - `azp` dans la liste des agents autorisés.
3. **Paramètres :** schéma zod (types et plafonds), puis listes blanches du tool. Ces contrôles passent avant toute décision, pour qu'un approbateur ne valide jamais une action qui échouerait.
4. **Jeton d'approbation**, s'il y en a un (en-tête `X-Approval-Token`, [approval.ts](src/lib/approval.ts)) :
   - il est signé par FounderOS (JWKS par URL ou, pour un cluster qui ne joint pas FounderOS, par fichier : `APPROVAL_JWKS_FILE`) et vaut 5 minutes ;
   - il est lié au demandeur, au tool, au cluster cible et à l'empreinte des paramètres ([canonical.ts](src/lib/canonical.ts)) ;
   - avec une règle à quorum (FounderOS, G3), il porte tous les approbateurs (`approvers`). OPA vérifie qu'aucun n'est le demandeur et que leur nombre atteint `approval_quorum[cluster]` du catalogue (1 par défaut).
5. **Décision OPA** ([policies/ai_tools.rego](policies/ai_tools.rego)), avec OPA en sidecar du pod :
   - le tool doit figurer au catalogue du cluster ;
   - le scope doit être dans le jeton **et** accordé par un rôle de l'utilisateur ;
   - en PRD, les écritures exigent une approbation donnée par une autre personne.
6. **Exécution** avec un identifiant éphémère tiré du Vault du cluster ([secrets.ts](src/lib/secrets.ts)) : chaque cluster a le sien. Le jeton d'appel n'est jamais relayé vers l'outil.
7. **Résultat :** masquage des secrets ([redact.ts](src/lib/redact.ts)), taille bornée, balisage « données non fiables ».
8. **Audit :** une ligne JSON par appel sur la sortie standard ([audit.ts](src/lib/audit.ts)), plus les métriques Prometheus sur le port de gestion.

Le catalogue [policies/catalog/data.json](policies/catalog/data.json) est la source unique. OPA le lit sous `data.catalog`, et chaque serveur n'enregistre que les tools prévus pour son cluster : ce qui n'est pas enregistré n'existe pas pour l'agent.

## Développer

```bash
cd MCP
npm install
npm test            # 109 tests : paramètres refusés, jetons d'appel et d'API, politique et quorum, intégration MCP, serveur par cluster
npm run typecheck
opa test policies -v   # 16 tests de la politique
```

Lancer un serveur en local, sans TLS ni OPA (poste de développement uniquement) :

```bash
MCP_SERVER=argocd MCP_CLUSTER=npr MCP_CONFIG_FILE=config/examples/argocd.prd.json \
KEYCLOAK_ISSUER=http://localhost:8080/realms/platform POLICY_ENGINE=builtin MCP_INSECURE_HTTP=1 \
npm run dev
```

## Construire et déployer

```bash
# Une image pour tous les modules
docker build -t quay.interne.exemple/ai-platform/mcp-server:0.1.0 .

# Un serveur par cluster (Argo CD en production, voir la doc)
helm upgrade --install mcp-prd deploy/helm/mcp-server -n ai-mcp -f deploy/values/cluster-prd.yaml

# Ou un module seul
helm upgrade --install mcp-openshift deploy/helm/mcp-server -n ai-mcp -f deploy/values/openshift-prd.yaml
```

FounderOS en cloud : le serveur s'installe dans la **passerelle d'entreprise**, avec le relais, sans port entrant. Le serveur n'y écoute que sur 127.0.0.1 (`MCP_HOST`) ; seul le relais du même pod le joint. Voir [docs/install](../docs/install/README.md#mode-cloud--la-passerelle-dentreprise) et le chart `deploy/helm/founderos-gateway`.

## Ajouter un tool

1. Le déclarer dans [policies/catalog/data.json](policies/catalog/data.json) :
   - `scopes` : son scope ;
   - `tools.<cluster>` : les clusters où il existe ;
   - `write_tools` : s'il écrit ;
   - `approval_required` : s'il exige une approbation.
2. L'écrire dans le module concerné ([src/servers/](src/servers/)) avec `defineTool`, des paramètres fermés (enum, plafonds) et un `validate()` pour les listes blanches.
3. Ajouter ses tests de paramètres refusés dans [test/tools.test.ts](test/tools.test.ts), et un cas dans [policies/ai_tools_test.rego](policies/ai_tools_test.rego) s'il change la politique.
4. Côté Keycloak, Vault et FounderOS, suivre le runbook « Ajouter un outil » de la doc.

Les tests vérifient au démarrage que le code et le catalogue sont d'accord (lecture ou écriture, scope connu) : un écart empêche le serveur de démarrer.
