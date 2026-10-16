# Architecture Hub : FounderOS sur le Hub, un serveur MCP par cluster

Architecture retenue le 12/10/2026. Elle remplace la variante Keycloak, Vault et LiteLLM décrite dans [openshift-implementation.md](openshift-implementation.md). Ce document-là reste la référence pour ce qui n'a pas changé : l'AC interne, Supabase, les approbations, l'exploitation.

**En bref.** FounderOS (interface, backend Express, Supabase) tourne sur le cluster Hub. Chaque cluster (Hub, IPS, SDB, NPR, PRD) a son serveur MCP, qui expose les outils de ce cluster. Le backend appelle le modèle sur Azure OpenAI. Il appelle aussi les serveurs MCP, chacun avec le jeton que ce serveur lui a livré. L'orchestrateur de FounderOS s'en sert pour mener ses missions.

Ni Keycloak, ni Vault, ni LiteLLM, ni External Secrets.

## Sommaire

1. [Schéma](#1-schéma)
2. [Composants](#2-composants)
3. [Flux à ouvrir](#3-flux-à-ouvrir)
4. [Identités et secrets](#4-identités-et-secrets)
5. [Ce que garantit chaque serveur MCP](#5-ce-que-garantit-chaque-serveur-mcp)
6. [Outils par cluster](#6-outils-par-cluster)
7. [Installer, dans l'ordre](#7-installer-dans-lordre)
8. [Exploiter](#8-exploiter)
9. [Par rapport à la variante précédente](#9-par-rapport-à-la-variante-précédente)

## 1. Schéma

```
                      Utilisateurs (navigateur)
                                │ F1  HTTPS, Routes internes du Hub
┌───────────────────────── Cluster Hub ─────────────────────────────┐
│  namespace founderos                                              │
│    web ──► backend Express ──► Supabase (Auth, base, stockage)    │
│               │                    └── F2  SSO : IdP de           │
│               │                            l'entreprise (OIDC/SAML)│
│  namespace ai-mcp                                                 │
│    mcp-hub : observabilité, flotte ACM, OpenShift, Argo CD + OPA  │
└───────────────┼───────────────────────────────────────────────────┘
  F3  HTTPS     │  F5  HTTPS, mTLS + jeton du serveur      ▲  F4  livraison
  sortant vers  │      (vers chaque Route MCP)             │      du jeton
  Azure OpenAI  ▼                                          │
     mcp-ips · mcp-sdb · mcp-npr · mcp-prd   (namespace ai-mcp de chaque cluster)
                │  F6  API Kubernetes et outils du cluster, sans sortir du cluster
```

## 2. Composants

| Composant | Où | Rôle | Livré par |
| --- | --- | --- | --- |
| Interface (web) | Hub, `founderos` | L'application, derrière le SSO | `deploy/helm/founderos` |
| Backend Express | Hub, `founderos` | Orchestrateur et agents, appels du modèle et des serveurs MCP, approbations, audit | `deploy/helm/founderos` |
| Supabase | Hub, `founderos` | Auth (SSO), base Postgres, stockage | Chart de la communauté, clés générées par l'installateur (`supabase.env`) |
| Serveur MCP | Chaque cluster, `ai-mcp` | Outils du cluster, politique OPA en sidecar | `MCP/deploy/helm/mcp-server` et `MCP/deploy/values/cluster-<cluster>.yaml` |
| Azure OpenAI | Azure, Data Zone EU | `gpt-6-luna` par défaut, `gpt-6-sol` pour le raisonnement long | Déploiements Azure (rapport de coûts) |

L'installateur produit tout ce dont le Hub a besoin à partir d'un fichier : [deploy/installer/profiles/openshift-hub.yaml](../deploy/installer/profiles/openshift-hub.yaml).

## 3. Flux à ouvrir

| Flux | Source | Destination | Port | Authentification |
| --- | --- | --- | --- | --- |
| F1 | Postes des utilisateurs | Routes `founderos` et `founderos-api` (Hub) | 443 | Session Supabase, ouverte par le SSO |
| F2 | Supabase Auth (Hub) | IdP de l'entreprise (Entra ID, ADFS, Okta…) | 443 | OIDC ou SAML |
| F3 | Backend (Hub, `founderos`) | `<ressource>.openai.azure.com` | 443 | Clé API (`LLM_API_KEY`), par le proxy sortant si l'entreprise en impose un |
| F4 | Serveur MCP (chaque cluster, `ai-mcp`) | Route `founderos-api` (Hub) | 443 | En `Bearer`, le jeton que FounderOS détient déjà |
| F5 | Backend (Hub, `founderos`) | Route `mcp` de chaque cluster (passthrough) | 443 | mTLS (certificat client `founderos-ai-platform`) et jeton du serveur `mcpt_…` |
| F6 | Serveur MCP | API Kubernetes et outils de son cluster | 443 / 6443 | Jeton court du compte dédié, ou jeton de l'outil |
| F7 | Prometheus du cluster | Port de gestion 9090 (serveurs MCP, backend) | 9090 | Réseau interne seulement |

Les NetworkPolicies du chart MCP n'admettent sur le port MCP que le routeur, et sur le port de gestion que la supervision. Le backend ne joint que les hôtes de `mcp.internalHosts` (garde SSRF) et ne présente son certificat client qu'à eux.

## 4. Identités et secrets

| Qui vers qui | Mécanisme | Où vit le secret | Rotation |
| --- | --- | --- | --- |
| Personne → FounderOS | SSO de l'entreprise branché sur Supabase Auth, réglé depuis la page de connexion (« Set up SSO », mode `dedicated`). Sessions bornées : 24 h, 8 h d'inactivité | Chez l'IdP | Celle de l'IdP |
| FounderOS → serveur MCP | Jeton d'API tournant propre à chaque serveur, `mcpt_<id>_<HMAC-SHA256(graine, jour)>`. Le serveur le livre lui-même (F4) | Graine : Secret `mcp-token-seed` du cluster, jamais copiée. FounderOS : jeton chiffré en base, plus son empreinte | Chaque jour, automatique ; la veille reste acceptée |
| Canal FounderOS ↔ MCP | mTLS : certificat client et certificats des serveurs émis par cert-manager depuis l'AC interne | Secrets cert-manager | 30 jours, automatique |
| Serveur MCP → API Kubernetes | Comptes `mcp-<cluster>-reader` et `mcp-<cluster>-operator`, liés par RoleBinding dans les seuls namespaces autorisés. Jeton de 10 minutes par l'API TokenRequest. Le compte du pod n'a qu'un droit : demander ces deux jetons | Aucun secret stocké | 10 minutes |
| Serveur MCP → outils (Argo CD, Loki, Grafana, recherche ACM…) | Jeton de l'outil, monté en lecture seule (`secretMounts`, credential `{ type: file }`) | Secret du namespace `ai-mcp` du cluster | Trimestrielle (17.3 de l'implémentation) |
| Approbation → serveur MCP | Jeton ES256 signé par FounderOS, valable 5 minutes, lié au demandeur, au tool, au cluster cible et aux paramètres. Une exécution par jeton | JWKS public (`GET /functions/v1/approval-jwks`) copié dans la ConfigMap `approval-jwks` | Annuelle, nouvelle clé publiée avant usage |
| Backend → Azure OpenAI | Clé API | Secret `founderos-backend` (`LLM_API_KEY`), jamais dans `founderos.yaml` | Politique Azure |

Le jeton d'appel n'est jamais relayé vers un outil, et aucun secret ne transite entre clusters. Un serveur MCP ne détient que la graine de son jeton et les jetons des outils de son cluster.

## 5. Ce que garantit chaque serveur MCP

La chaîne est la même pour tous les modules ([MCP/src/lib/tool.ts](../MCP/src/lib/tool.ts)). Chaque garantie a ses tests.

| Étape | Garantie | Tests |
| --- | --- | --- |
| Connexion | mTLS : certificat client signé par l'AC interne, CN dans `tls.allowedClientCNs` ; sinon refus avant toute lecture du jeton | `mtls.test.ts` |
| Jeton | Jeton tournant du jour ou de la veille, comparé en temps constant, vérifié avant toute lecture du corps de la requête | `rotating-token.test.ts` |
| Débit | 120 appels par minute et par appelant, rafale de 30 (`limits.ratePerMinute`, `limits.burst`) | `limits.test.ts` |
| Paramètres | Aucun paramètre sans borne : chaîne bornée ou expression ancrée, nombre borné des deux côtés, liste bornée. Listes blanches (namespaces, applications, projets) | `contract.test.ts`, `tools.test.ts` |
| Politique | OPA : tool au catalogue du cluster, scope du jeton accordé par un rôle | `opa test` (17) |
| Approbation | Écriture sur le Hub (FounderOS y tourne) ou en PRD : approbation d'une autre personne, jeton consommé une fois. Une simulation (`dry_run`) ne le consomme pas | `limits.test.ts`, `contract.test.ts`, `opa test` |
| Exécution | 16 tools à la fois au plus, 10 s d'attente au-delà (`busy`), 30 s par tool (`timeout`) | `limits.test.ts` |
| Lecture | Jamais de Secret : liste fermée de types (`resource_list`, `resource_get`), valeurs des ConfigMaps et variables d'environnement littérales masquées, `managedFields` retirés | `openshift-k8s.test.ts` |
| Écriture | Redémarrage et mise à l'échelle seulement, plafond de réplicas (`maxReplicas`, 10 par défaut). Chaque écriture accepte `dry_run`. Relancer ne crée pas de doublon : silence identique rendu, synchronisation en cours non relancée, pull request déjà ouverte rendue | `openshift-k8s.test.ts`, `tools.test.ts`, `contract.test.ts` |
| Résultat | Secrets masqués, taille bornée, balisé « données non fiables » | `lib.test.ts` |
| Audit | Une ligne JSON par appel : personne, agent, jeton, tool, empreinte des paramètres, décision, approbateurs, durée | `tools.test.ts` |

**Codes d'erreur stables**, que l'orchestrateur traite sans lire le message :

| Code | Sens | Que faire |
| --- | --- | --- |
| `invalid_params` | Paramètre refusé (schéma ou liste blanche) | Corriger l'appel |
| `denied` | Refus de la politique (`reason` : scope, rôle, approbation rejouée…) | Ne pas réessayer |
| `approval_required` | Écriture à faire approuver ; porte `params_hash` | FounderOS ouvre la demande, puis rejoue à l'identique |
| `rate_limited` | Débit dépassé ; `retry_after_seconds` | Attendre |
| `busy` | Serveur saturé | Réessayer plus tard |
| `timeout` | Tool trop long | Vérifier l'état avant de relancer une écriture |
| `not_found` / `forbidden` | 404 / 403 de l'outil | Vérifier la cible, ou les droits RBAC |
| `upstream_error` | Autre erreur de l'outil | Voir l'audit |

**Droits et outils vérifiés en continu.** Au démarrage, puis toutes les 60 secondes, le module OpenShift demande à l'API (SelfSubjectAccessReview) si ses comptes ont bien leurs droits, namespace par namespace. Les autres modules vérifient que leurs outils répondent avec l'identifiant configuré (`module-checks.test.ts`). Un droit manquant rend le serveur « dégradé » sans le retirer du service. `/readyz` donne la cause, et la métrique `mcp_check_ok` passe à 0. Seul OPA injoignable retire le pod du service.

## 6. Outils par cluster

Le catalogue [MCP/policies/catalog/data.json](../MCP/policies/catalog/data.json) fait autorité. Un serveur n'enregistre que les tools prévus pour son cluster.

| Cluster | Modules | Tools | Écritures (approbation) |
| --- | --- | --- | --- |
| Hub | observabilité, flotte, OpenShift, Argo CD | 23 | `deployment_restart`, `deployment_scale`, `app_sync` (approbation) ; `alert_silence_create` (approbation si la cible est PRD) |
| IPS | OpenShift, Argo CD, Git, PRTG | 17 | `deployment_restart`, `deployment_scale`, `app_sync`, `pr_create` |
| SDB, NPR | OpenShift, Argo CD | 15 | `deployment_restart`, `deployment_scale`, `app_sync` |
| PRD | OpenShift, Argo CD | 14 | `deployment_restart`, `deployment_scale` (approbation) ; pas de `app_sync` |

Les tools OpenShift : `pods_list`, `pod_logs`, `events_list`, `deployment_status`, `namespace_overview` (vue d'ensemble d'un namespace), `resource_list` et `resource_get` (types autorisés, jamais un Secret), `rollout_history`, `pod_metrics` (CPU et mémoire par conteneur), `deployment_restart`, `deployment_scale`.

## 7. Installer, dans l'ordre

**Sur le Hub.**

1. Préalables : cert-manager avec le ClusterIssuer `platform-internal-ca`, la ConfigMap `platform-internal-ca-bundle` (clé `ca.crt`), et les namespaces `founderos` et `ai-mcp`.
2. FounderOS et Supabase, depuis le profil :

   ```bash
   cp deploy/installer/profiles/openshift-hub.yaml founderos.yaml     # adapter les URL et la ressource Azure
   export LLM_API_KEY=<clé Azure OpenAI>
   node deploy/installer/founderos-config.mjs founderos.yaml --out ./install
   # Supabase : reporter install/supabase.env dans les valeurs de son chart, puis l'installer.
   oc -n founderos apply -f install/secrets.generated.yaml
   helm upgrade --install founderos deploy/helm/founderos -n founderos -f install/values.generated.yaml
   ```

   Le chart crée le certificat client vers les serveurs MCP (`mcp.clientCert`) et limite le backend aux hôtes `mcp.apps-int.*.interne.exemple`.
3. Ouvrir `https://founderos.apps-int.hub.interne.exemple/setup` : premier compte, diagnostic, puis « Set up SSO » depuis la page de connexion.

**Sur chaque cluster** (ici PRD ; Hub, IPS, SDB et NPR de même avec leur fichier de valeurs) :

```bash
oc new-project ai-mcp
# La graine du jeton tournant : générée ici, elle ne quitte pas le cluster.
npm --prefix MCP run token -- seed --file seed.txt
oc -n ai-mcp create secret generic mcp-token-seed --from-file=seed=seed.txt && shred -u seed.txt
# Les jetons des outils (Argo CD ici), montés en lecture seule.
oc -n ai-mcp create secret generic mcp-argocd --from-literal=token=<jeton du compte Argo CD>
# Les clés publiques des approbations, et la politique.
curl -s https://founderos-api.apps-int.hub.interne.exemple/functions/v1/approval-jwks > jwks.json
oc -n ai-mcp create configmap approval-jwks --from-file=jwks.json
oc -n ai-mcp create configmap ai-policies --from-file=MCP/policies/ai_tools.rego --from-file=catalog.json=MCP/policies/catalog/data.json
# Le serveur, ses comptes dédiés et leurs liaisons.
helm upgrade --install mcp-prd MCP/deploy/helm/mcp-server -n ai-mcp -f MCP/deploy/values/cluster-prd.yaml
# Le jeton du jour, à coller une fois dans FounderOS.
oc -n ai-mcp exec deploy/mcp-prd -c mcp -- node dist/token-cli.js current --file /etc/mcp-token-seed/seed
```

Une seule release par cluster crée les ClusterRoles `ai-reader`, `ai-operator`, `ai-prd-restarter` et `ai-acm-policy-reader` (`rbac.clusterRoles.create`).

**Dans FounderOS.** Ressources → Serveurs MCP : déclarer chaque serveur (URL de sa Route, jeton du jour). La fiche affiche ensuite « tournant » et la date de la dernière livraison.

**Vérifier.**
- `/readyz` de chaque serveur : `ready: true`, `degraded: false`, chaque vérification nommée.
- Un appel en lecture depuis un agent, puis une écriture en NPR (sans approbation).
- Une écriture en PRD : demande d'approbation, vote d'une autre personne, exécution, rejeu refusé.

## 8. Exploiter

| Signal | Où | Seuil d'alerte conseillé |
| --- | --- | --- |
| Disponibilité | `/healthz` (le processus vit) et `/readyz` (vérifications) sur le port 9090 | `/readyz` en 503 plus de 2 minutes |
| Droits RBAC, OPA | `mcp_check_ok{check}` | À 0 plus de 5 minutes |
| Livraison du jeton | `mcp_token_push_total{result}` | Aucun succès en 26 heures |
| Appels | `ai_tool_calls_total`, `ai_tool_denied_total{reason}`, `ai_tool_duration_seconds` | Hausse des `rate_limited`, `busy` ou `timeout` |
| Audit | Une ligne JSON par appel, sur la sortie standard du conteneur `mcp` | Collectée par la journalisation du cluster |

**Réenrôler un serveur** (FounderOS arrêté plus de 7 jours, ou connexion recréée) : relancer `token-cli.js current` et coller le jeton dans FounderOS.

**Changer la graine** (fuite soupçonnée) : `npm run token -- seed --force`, republier `mcp-token-seed`, redémarrer le serveur, puis coller le nouveau jeton.

**Retirer l'accès de l'IA à un namespace** : le retirer de `config.openshift.namespaces` et `helm upgrade`. Les RoleBindings disparaissent avec.

## 9. Par rapport à la variante précédente

| Avant | Maintenant |
| --- | --- |
| Keycloak : SSO et échange de jeton vers les serveurs MCP | SSO de l'entreprise directement sur Supabase Auth ; jeton tournant par serveur MCP |
| Un Vault par cluster : identifiants éphémères, secrets des outils | TokenRequest pour Kubernetes ; Secrets montés pour les outils |
| LiteLLM devant Azure OpenAI | Azure OpenAI en direct (`LLM_UPSTREAM=azure`) |
| External Secrets depuis Vault | Secrets générés par l'installateur |
| FounderOS sur IPS | FounderOS sur le Hub |

Les modes `oidc` (jetons d'un IdP) et Vault (`vault.enabled`) restent dans le code et le chart pour d'autres installations. Ils sont désactivés par défaut.
