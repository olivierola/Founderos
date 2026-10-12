# FounderOS — relais d'outils internes

Le relais donne aux collaborateurs FounderOS un accès **contrôlé** aux outils que vous hébergez vous-même : Argo CD, Vault, Grafana, Loki, Prometheus, Alertmanager, l'API Kubernetes, Helm, Jenkins, GitLab, SonarQube, une API maison.

Il tourne dans votre réseau et ne fait **que des appels sortants** vers FounderOS. Il vient chercher les requêtes (long polling HTTPS), les exécute contre vos outils si **sa propre liste blanche** le permet, puis renvoie la réponse. Vous n'ouvrez aucun port entrant et n'exposez aucune URL interne.

```
Collaborateur FounderOS ──► connector-action (cloud) ──► file chiffrée
                                                            ▲
                         relais (chez vous) ── sortant ─────┘
                              │
                              ├──► https://argocd.interne/api/v1/...
                              ├──► https://vault.interne:8200/v1/...
                              └──► helm / kubectl (si autorisés)
```

## Ce qui protège quoi

| Couche | Où | Effet |
| --- | --- | --- |
| `RELAY_ALLOWED_HOSTS` | chez vous | Seuls ces hôtes sont joignables. Liste vide : tout est refusé. Aucune redirection n'est suivie. |
| `RELAY_ALLOWED_BINARIES` / `RELAY_DENIED_SUBCOMMANDS` | chez vous | Les CLI autorisées, jamais via un shell ; `helm uninstall`, `kubectl delete`, `kubectl exec`… refusés même si le binaire est permis. |
| RBAC du ServiceAccount | chez vous | Pour Kubernetes et Helm, les droits réels du relais (ClusterRole `view` par défaut). |
| Opérations déclarées | FounderOS | Le collaborateur choisit une opération et ses paramètres, jamais une URL libre. Paramètres validés et encodés. |
| Approbations | FounderOS | Les gestes `destructive` attendent toujours un humain, quel que soit le niveau d'autonomie. |
| Profils d'identifiants | FounderOS | Un profil par usage (lecture seule, prod-admin…), réservable à certains collaborateurs, lié à l'URL du connecteur. |
| Journal d'accès | FounderOS + vos logs | Chaque appel est journalisé, chaîné par empreinte SHA-256. Le relais écrit aussi une ligne JSON par appel sur sa sortie standard (sans corps ni secret). Chaque requête porte `X-Request-Id` et `X-FounderOS-Collaborator` pour corréler avec les journaux de vos outils. |

## Où vivent les secrets

Deux emplacements, au choix pour chaque profil d'identifiants :

- **Chiffré chez FounderOS** (AES-256-GCM). Le secret est transmis au relais par TLS au moment où il réclame une requête, jamais stocké en clair dans la file.
- **Chez le relais**. FounderOS ne stocke qu'une référence (`env:ARGOCD_TOKEN`, `file:/var/run/secrets/...`) ; la valeur ne quitte jamais votre réseau. Branchez-la avec un Secret Kubernetes, Vault Agent ou External Secrets Operator.

Exemple Kubernetes : un connecteur « Kubernetes API » avec un profil relais `token = file:/var/run/secrets/kubernetes.io/serviceaccount/token` et `RELAY_CA_FILE` pointant vers `ca.crt`.

## Installation

1. Dans FounderOS : **Ressources → Outils internes → Relais → Nouveau relais**. Copiez le jeton (montré une seule fois).
2. Déployez.

### Docker

```bash
docker build -t founderos/connector-relay .
docker run -d --name founderos-relay --restart unless-stopped \
  -e FOUNDEROS_URL=https://xxxxxxxx.supabase.co \
  -e RELAY_TOKEN=fosr_... \
  -e RELAY_ALLOWED_HOSTS="argocd.interne.exemple,vault.interne.exemple:8200" \
  founderos/connector-relay
```

### Kubernetes (Helm)

```bash
docker build --build-arg WITH_K8S_TOOLS=true -t registry.interne/founderos/connector-relay:0.1.0 .
helm install founderos-relay ./helm/connector-relay -n founderos --create-namespace \
  --set image.repository=registry.interne/founderos/connector-relay \
  --set founderosUrl=https://xxxxxxxx.supabase.co \
  --set relayToken=fosr_... \
  --set-string allowedHosts="argocd-server.argocd.svc.cluster.local\,*.monitoring.svc.cluster.local\,kubernetes.default.svc" \
  --set-string allowedBinaries="helm"
```

Pour la production, préférez `existingSecret` (clé `RELAY_TOKEN`) à `relayToken` en clair dans la commande.

### Sans conteneur

```bash
cp .env.example .env   # puis renseignez-le
node --env-file=.env src/index.js
```

## Variables

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `FOUNDEROS_URL` | (requis) | URL du projet FounderOS |
| `RELAY_TOKEN` | (requis) | Jeton du relais |
| `RELAY_ALLOWED_HOSTS` | vide = tout refusé | `hôte`, `hôte:port`, `*.domaine`, `10.0.0.0/8` |
| `RELAY_ALLOWED_BINARIES` | vide | CLI autorisées (`helm,kubectl`) |
| `RELAY_DENIED_SUBCOMMANDS` | gestes destructifs helm/kubectl | `binaire:sous-commande` |
| `RELAY_CA_FILE` | | Autorité de certification interne (PEM) |
| `RELAY_CONCURRENCY` | 4 | Requêtes simultanées |
| `RELAY_MAX_BYTES` | 1048576 | Taille maximale d'une réponse |
| `RELAY_HEALTH_PORT` | désactivé | Sonde `GET /healthz` (200 si FounderOS a répondu dans les 90 s) |

## Exploitation

- **Révoquer** : bouton « Révoquer » dans FounderOS. Le relais reçoit un 401 et s'arrête aussitôt.
- **Renouveler le jeton** : « Nouveau jeton », puis redéployez avec la nouvelle valeur.
- **Coût** : une requête de long polling toutes les ~20 s par relais, même au repos.
- **NetworkPolicy** (`networkPolicy.enabled`) : sortie DNS, 443 et vos CIDR internes seulement. Vérifiez que votre CNI laisse passer les sondes du kubelet.

## Tests

```bash
npm test
```
