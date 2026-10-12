# Installer FounderOS

Ce guide installe FounderOS chez vous : sur Kubernetes, sur OpenShift ou sur une machine virtuelle. FounderOS en cloud se branche sur vos outils par un seul composant installé chez vous, la passerelle d'entreprise ([mode cloud](#mode-cloud--la-passerelle-dentreprise)).

Pour installer FounderOS lui-même, la démarche est la même dans les trois cas :

1. décrire l'installation dans `founderos.yaml` ;
2. en tirer les valeurs Helm ou le `.env` avec l'installateur ;
3. installer ;
4. ouvrir `/setup` : premier compte, diagnostic, SSO, premier agent.

| Profil | Pour qui | Fichier de départ |
| --- | --- | --- |
| Kubernetes | Un cluster standard (Ingress, cert-manager) | [`deploy/installer/profiles/kubernetes.yaml`](../../deploy/installer/profiles/kubernetes.yaml) |
| OpenShift | Un cluster OpenShift ; l'installation SCIC en est un exemple complet | [`deploy/installer/profiles/openshift-scic.yaml`](../../deploy/installer/profiles/openshift-scic.yaml), et [docs/openshift-implementation.md](../openshift-implementation.md) |
| Machine virtuelle | Petites équipes, essai : une machine Linux avec Docker | [`deploy/installer/profiles/vm.yaml`](../../deploy/installer/profiles/vm.yaml) |

## Ce qui est installé, et ce qui ne l'est pas

| Brique | Installée par | Remarque |
| --- | --- | --- |
| Backend (Express) | le chart `deploy/helm/founderos`, ou le compose | Image `backend` ([backend/Dockerfile](../../backend/Dockerfile)) |
| Interface | idem | Image `web` : une seule image, les adresses se donnent au démarrage |
| Migrations de la base | idem (Job, ou service `migrate`) | Image `migrations` : applique `supabase/migrations`, notées dans le registre de la CLI Supabase |
| Supabase | **fourni** | Auto-hébergé ([compose officiel](https://supabase.com/docs/guides/self-hosting/docker) ou chart de la communauté), ou service géré. L'installateur prépare ses clés (`supabase.env`). |
| Serveurs MCP | leur chart, sur **chaque** cluster cible ; ou la passerelle | [MCP/README.md](../../MCP/README.md) : jeton d'API généré à l'installation |
| Relais | son chart, dans le réseau du client ; ou la passerelle | [connector-relay/README.md](../../connector-relay/README.md) |
| LiteLLM | son chart amont, si vous imposez une passerelle | Puis `llm.gateway: litellm` dans `founderos.yaml` |
| OPA | en sidecar des serveurs MCP | Déjà dans leur chart |

## 1. Décrire l'installation

```bash
cp deploy/installer/profiles/kubernetes.yaml founderos.yaml   # ou openshift-scic.yaml, vm.yaml
```

Les champs sont commentés dans [`founderos.example.yaml`](../../deploy/installer/founderos.example.yaml) :

- `target` : `kubernetes`, `openshift` ou `vm`.
- `domain`, ou `urls` : les adresses de l'interface, du backend et de Supabase.
- `supabase.mode` : `selfhosted` (l'installateur génère ses clés) ou `provided` (une instance existante).
- `admins` : les administrateurs de l'installation (Administration → Installation).
- `sso.mode` : `dedicated` (une entreprise) ou `shared` (plusieurs organisations, domaines vérifiés).
- `llm.gateway` : `none`, `litellm` ou `azure`.
- `secrets.source` :
  - `generate` : l'installateur crée les clés ;
  - `vault` : des ExternalSecret les recopient de Vault ;
  - `existing` : les Secrets existent déjà.

Aucun secret ne s'écrit dans `founderos.yaml`. Une clé LiteLLM s'exporte avant de lancer l'installateur (`export LLM_API_KEY=…`).

## 2. Lancer l'installateur

```bash
npm ci                                    # js-yaml, une fois
node deploy/installer/founderos-config.mjs founderos.yaml --out ./install
```

| Fichier produit | Contenu |
| --- | --- |
| `values.generated.yaml` | Les valeurs du chart, sans aucun secret |
| `secrets.generated.yaml` | Les Secrets `founderos-backend` et `founderos-supabase` (`secrets.source: generate`) |
| `externalsecrets.generated.yaml` | Les ExternalSecret (`secrets.source: vault`) |
| `.env` | Celui du compose (`target: vm`), secrets compris |
| `supabase.env` | Les clés d'un Supabase auto-hébergé : `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD` |
| `founderos.secrets.json` | L'état des secrets générés |

Relancer l'installateur garde les mêmes secrets : les jetons chiffrés et les approbations signées restent valables. `--rotate` en génère de nouveaux. Les fichiers de secrets sont dans `.gitignore`.

## 3. Installer

### Kubernetes ou OpenShift

```bash
kubectl create namespace founderos
kubectl -n founderos apply -f install/secrets.generated.yaml          # ou externalsecrets.generated.yaml
helm upgrade --install founderos deploy/helm/founderos -n founderos -f install/values.generated.yaml
kubectl -n founderos logs job/founderos-migrations -f
```

Le Job des migrations tourne après l'installation et avant chaque mise à jour. Il tient un registre et un verrou : le relancer ne rejoue rien. Si une base a été migrée à la main avant le chart, réglez `migrations.baseline` sur la dernière version appliquée.

### Machine virtuelle

```bash
# 1. Supabase : son compose officiel, avec les clés de install/supabase.env
# 2. FounderOS :
cp install/.env deploy/compose/.env
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
```

Caddy sert l'interface et le backend en HTTPS : Let's Encrypt par défaut, ou `vm.tls: internal` sans accès Internet.

### Les images

Publiées dans le registre réglé par `images.registry`. Pour les construire depuis ce dépôt :

```bash
docker build -t <registre>/backend:<tag> backend
docker build -f deploy/spa/Dockerfile -t <registre>/web:<tag> .
docker build -f deploy/migrations/Dockerfile -t <registre>/migrations:<tag> .
docker build -f deploy/gateway/Dockerfile -t <registre>/gateway:<tag> .       # mode cloud
```

Chaque image construite depuis la racine a son propre `Dockerfile.dockerignore`, à côté de son Dockerfile ; BuildKit le lit à la place du `.dockerignore` de la racine.

## 4. Premier démarrage

Ouvrez `https://<interface>/setup`. L'assistant enchaîne quatre étapes, cochées en direct :

1. **Compte administrateur.** Le premier compte se crée par e-mail et mot de passe.
2. **Installation rattachée.** Les adresses de `admins` administrent l'installation. Sans elles, sur une instance neuve, le premier compte la rattache à son organisation.
3. **Diagnostic.** Base et migrations, chiffrement, clé de signature et JWKS public, passerelle LLM, SSO, relais, serveurs MCP, métriques, OPA. Chaque brique en panne est nommée avec sa cause.
4. **SSO, puis premier agent.**

Les réglages sans secret se changent ensuite dans Administration → Installation. Ceux que fixe `founderos.yaml` (valeurs Helm `backend.env`) y apparaissent verrouillés.

## Départs et sessions

Désactiver quelqu'un dans l'IdP l'empêche d'ouvrir une session, pas de garder la sienne. L'installateur borne donc les sessions de l'Auth (`sessions` dans `founderos.yaml`, par défaut 24 h au plus, 8 h sans activité). Les variables `GOTRUE_SESSIONS_TIMEBOX` et `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT` de `supabase.env` se passent au service `auth` de Supabase.

Retirer un membre dans FounderOS coupe aussitôt ses demandes en attente, les jetons d'IdP de ses agents et ses groupes relevés. S'il n'a plus d'organisation, ses sessions sont fermées. La trace est dans Administration → Authentification → Départs.

## Mettre à jour

```bash
node deploy/installer/founderos-config.mjs founderos.yaml --out ./install   # mêmes secrets
helm upgrade founderos deploy/helm/founderos -n founderos -f install/values.generated.yaml
```

Les migrations passent avant les nouveaux pods.

## Mode cloud : la passerelle d'entreprise

FounderOS tourne en cloud ; vos outils restent chez vous. La passerelle est le seul composant à installer : le relais et les serveurs MCP du cluster, sans aucun port entrant.

```
FounderOS (cloud)  ◄── HTTPS sortant ──  relais ──► 127.0.0.1:8443  serveur MCP ──► API Kubernetes, Argo CD…
                                         └──────── un pod, chez vous ────────┘
```

- Le relais **sort** vers FounderOS pour réclamer les appels à faire. Rien n'entre.
- Le serveur MCP n'écoute que sur la boucle locale du pod : seul le relais voisin le joint. Le relais reçoit d'office cette adresse dans sa liste blanche, et rien d'autre de local.
- Les secrets restent chez vous : Vault, ou le jeton du compte de service borné par `rbac`, ou un Secret. Le jeton d'API du serveur MCP ne traverse la file du relais que scellé.
- Sur Kubernetes, relais et serveur MCP sont deux conteneurs du même pod. Chacun ne monte que ses secrets : le jeton du relais d'un côté, Vault et les jetons d'API de l'autre.

### Sur Kubernetes ou OpenShift

1. Dans FounderOS : Ressources → Outils internes → Relais → Nouveau relais. Copiez le jeton `fosr_…`.
2. La graine du jeton tournant du serveur MCP, générée chez vous : elle va dans un Secret et ne quitte jamais le cluster. La commande affiche le jeton du jour.

   ```bash
   (cd MCP && npm ci && npm run token -- seed --file ../seed.txt)
   # sans Node : docker run --rm -v "$PWD:/w" <registre>/gateway:<tag> node mcp/dist/token-cli.js seed --file /w/seed.txt
   kubectl create namespace founderos-gateway
   kubectl -n founderos-gateway create secret generic founderos-relay --from-literal=RELAY_TOKEN=fosr_…
   kubectl -n founderos-gateway create secret generic founderos-token-seed --from-file=seed=seed.txt && shred -u seed.txt
   ```

   Gardez le jeton affiché pour l'étape 4. Ensuite, le serveur change de jeton chaque jour et livre lui-même le nouveau à FounderOS, à l'adresse `founderosUrl`.
3. Installez le chart. `mcp-config.yaml` porte la configuration des modules sous `mcp.config` ([MCP/config/examples](../../MCP/config/examples)) :

   ```bash
   helm upgrade --install gw deploy/helm/founderos-gateway -n founderos-gateway \
     --set founderosUrl=https://<projet>.supabase.co --set relay.existingSecret=founderos-relay \
     --set mcp.servers='{openshift}' --set mcp.cluster=prd --set mcp.auth.seedSecret=founderos-token-seed \
     -f mcp-config.yaml
   ```

   Sans Vault, les modules utilisent le jeton du compte de service (`readCredential: { type: file, path: /var/run/secrets/kubernetes.io/serviceaccount/token }`) et `rbac.create=true` lui donne ses droits. Avec Vault : `vault.enabled=true`, `vault.addr`.
4. Dans FounderOS : Serveurs MCP → Ajouter.
   - Accès : par le relais de la passerelle.
   - Adresse : `http://127.0.0.1:8443/mcp`.
   - Authentification : Jeton d'API, celui de l'étape 2. La fiche montre ensuite la date du dernier jeton livré par le serveur.

   « Tester » liste les tools.

La NetworkPolicy du chart refuse toute entrée, sauf la supervision vers `/metrics` (`networkPolicy.metricsFrom`). En sortie, elle laisse passer le DNS, le HTTPS vers FounderOS et les plages de `networkPolicy.egressCidrs` : API Kubernetes, Vault, outils.

### Sur une machine, sans Kubernetes

```bash
cd deploy/gateway
cp gateway.env.example .env          # FOUNDEROS_URL, RELAY_TOKEN, GATEWAY_MCP_SERVERS, MCP_CLUSTER…
# mcp-config.json (la configuration des modules) et seed.txt (la graine : token-cli.js seed) à côté
docker compose up -d
```

Un conteneur : le lanceur `gateway.mjs` démarre les deux processus, chacun avec ses seules variables. Si l'un s'arrête, la passerelle s'arrête, et Docker la relance.

## Vérifier sans cluster

```bash
node --test deploy/installer/config.test.mjs deploy/migrations/runner.test.mjs deploy/gateway/plan.test.mjs
helm lint deploy/helm/founderos -f install/values.generated.yaml
helm lint deploy/helm/founderos-gateway --set founderosUrl=https://x --set relay.token=x
helm template founderos deploy/helm/founderos -f install/values.generated.yaml
```
