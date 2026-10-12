# Installation dédiée : SSO d'entreprise, Azure OpenAI, PRTG

Ce document décrit ce qu'il faut configurer quand la plateforme tourne chez un client, sur sa propre infrastructure (Supabase auto-hébergé), avec son fournisseur d'identité et son modèle sur Azure OpenAI.

Pour l'architecture OpenShift complète (IPS, Hub, SDB, NPR, PRD : Keycloak, Vault, LiteLLM, serveurs MCP, ACM), voir [openshift-implementation.md](openshift-implementation.md). Les serveurs MCP sont dans [MCP/](../MCP/README.md).

## 0. Le backend Express

Chez le client, les fonctions ne tournent pas dans l'edge runtime de Supabase. Elles sont servies par le backend Node/Express de [backend/](../backend/README.md), aux mêmes chemins (`/functions/v1/<nom>`). Supabase auto-hébergé reste la base, l'Auth, le storage et le realtime.

- **Image :** `docker build -t <registre>/founderos/backend backend`.
  - Le pod expose le port 8787, avec une sonde sur `GET /health`.
  - Prévoir `terminationGracePeriodSeconds: 30` : à l'arrêt, les tâches de fond ont 25 s pour finir.
- **Variables :** celles de [backend/.env.example](../backend/.env.example).
  - Clés Supabase de l'instance du client.
  - `FUNCTIONS_URL` : l'URL du backend vue par les autres services.
  - Les secrets Azure et SSO des sections suivantes.
- **Passerelle JWT :** `GATEWAY_VERIFY_JWT=strict`. Toutes les fonctions exigent un JWT de l'instance, sauf les exceptions justifiées de `supabase/config.toml` (webhooks signés, relais, runners).
- **Front :** construit avec `VITE_API_URL=<URL du backend>`. Les appels aux fonctions partent alors vers le backend, et les commandes d'installation du relais et de l'extension navigateur affichent cette URL.
- **Tâches planifiées (pg_cron) :** elles lisent l'URL du backend dans le vault. Tant que ce secret manque, elles échouent avec un message explicite au lieu d'appeler une autre instance (migration 0273).

  ```sql
  select vault.create_secret('http://founderos-backend.scic.svc:8787', 'functions_base_url');
  ```
- **Relais d'outils :** `FOUNDEROS_URL` = l'URL du backend. Le relais y appelle `/functions/v1/connector-action`.
- **Mettre à jour les fonctions :** on modifie la source dans `supabase/functions/`, puis on régénère avec `npm run port:edge` dans `backend/` avant de reconstruire l'image.

## 1. Le modèle : Azure OpenAI

Avec `LLM_UPSTREAM=azure`, tous les appels de chat et de vectorisation partent vers **une seule** ressource Azure OpenAI, et nulle part ailleurs. Tout appel vers un autre hôte (DeepSeek, Groq, Jina…) est refusé avec une erreur explicite au lieu de partir. Le code est dans [llm-upstream.ts](../supabase/functions/_shared/llm-upstream.ts).

Variables du backend (ou secrets des fonctions edge, sur une instance qui les utilise encore) :

| Variable | Rôle |
| --- | --- |
| `LLM_UPSTREAM` | `azure` |
| `AZURE_OPENAI_BASE_URL` | `https://<ressource>.openai.azure.com/openai/v1` (API v1, sans `api-version`) |
| `AZURE_OPENAI_DEPLOYMENT` | Nom du déploiement de chat (ex. `gpt-4.1`) |
| `AZURE_OPENAI_DEPLOYMENT_HEAVY` | Optionnel : déploiement des tâches lourdes (raisonnement, code) |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Déploiement `text-embedding-3-small` ou `-large`. Les vecteurs sont réduits à 1024 dimensions, comme les colonnes pgvector existantes |
| `AZURE_OPENAI_REASONING` | `1` si le déploiement de chat est un modèle de raisonnement (o-series, gpt-5) : la température n'est alors pas envoyée |
| `AZURE_OPENAI_API_KEY` | Clé de la ressource, **ou** le trio ci-dessous |
| `AZURE_OPENAI_TENANT_ID`, `AZURE_OPENAI_CLIENT_ID`, `AZURE_OPENAI_CLIENT_SECRET` | Principal de service Entra avec le rôle « Cognitive Services OpenAI User », pour une ressource dont les clés sont désactivées |
| `AZURE_OPENAI_SCOPE` | Défaut `https://cognitiveservices.azure.com/.default` |
| `LLM_ALLOWED_HOSTS` | Hôtes supplémentaires autorisés, par exemple un vLLM interne déclaré comme endpoint d'agent |

À savoir :

- `max_tokens` est envoyé sous la forme `max_completion_tokens`, qui est accepté par tous les modèles Azure récents.
- La bascule automatique DeepSeek → Groq est coupée : un quota Azure épuisé fait échouer l'appel, avec le message du service.
- Des vecteurs calculés avec Jina ne sont pas comparables à ceux d'Azure. Sur une installation neuve, rien à faire. Sur une base existante, il faut réingérer les sources RAG.
- Ces fonctions dépendent encore de services externes : la voix (Deepgram), la génération d'images (`office-ai/media`) et les connecteurs Composio. Elles seront coupées par le profil de déploiement on-prem (lot suivant).

## 2. Le SSO

Les personnes se connectent par l'IdP de l'entreprise, et leurs groupes déterminent leur rôle dans l'organisation à chaque connexion. Le code :

- la migration [0272_enterprise_sso.sql](../supabase/migrations/0272_enterprise_sso.sql) ;
- la fonction [sso-admin](../supabase/functions/sso-admin/index.ts) ;
- l'écran **Administration → Authentification**.

### Configuration de l'Auth (GoTrue)

| Variable | Valeur |
| --- | --- |
| `API_EXTERNAL_URL` | URL publique de l'Auth, **terminée par `/auth/v1`** (ex. `https://scic.interne.exemple/auth/v1`) |
| `GOTRUE_CUSTOM_OAUTH_ENABLED` | `true` : fournisseurs OIDC ajoutés à chaud (Entra ID, Keycloak). Auth ≥ v2.196.0 |
| `GOTRUE_SAML_ENABLED` | `true`, seulement si un IdP SAML est prévu |
| `GOTRUE_SAML_PRIVATE_KEY` | Clé RSA 2048 bits, PKCS#1, en base64 : `openssl genrsa 2048 \| base64 -w0` |
| `GOTRUE_SESSIONS_TIMEBOX` | Par exemple `12h`. Sans SCIM, c'est ce qui borne l'accès d'un compte désactivé dans l'IdP : il garde sa session jusqu'à cette limite |
| `GOTRUE_EXTERNAL_EMAIL_ENABLED` | `false`, **une fois le SSO validé** : refuse le mot de passe côté serveur. L'option « SSO uniquement » de l'écran ne fait que masquer le formulaire |

Variable du backend : `SSO_ADMIN_ENABLED=1`. Sans lui, l'écran reste en lecture seule. Un fournisseur d'identité vaut pour toute l'instance, donc cette configuration n'a pas de sens sur une instance partagée entre clients.

### Mise en route

1. L'installateur crée un compte par mot de passe. Son organisation sera l'organisation « maison ».
2. **Administration → Authentification → Ajouter un fournisseur → Microsoft Entra ID.**
   - Le premier enregistrement rattache le SSO de l'installation à cette organisation, et il faut en être owner.
   - Ensuite, seuls ses owners et admins gèrent le SSO, et les comptes SSO n'entrent que dans cette organisation.
3. Créez une correspondance par groupe ou rôle d'application : valeur reçue → Lecteur, Membre ou Admin.
4. Testez une connexion. Le tableau « Dernières connexions SSO » montre :
   - les valeurs reçues dans le jeton ;
   - le rôle appliqué ;
   - « claim absent du jeton » si l'IdP n'envoie pas les groupes.
5. Activez « Connexion par SSO uniquement », puis passez `GOTRUE_EXTERNAL_EMAIL_ENABLED=false`.

### Côté Entra ID

Dans **Inscriptions d'applications → Nouvelle inscription** :

- **Authentification :**
  - plateforme Web ;
  - URI de redirection `https://<hôte>/auth/v1/callback`, affichée et copiable dans l'écran.
- **Certificats et secrets :** un secret client, à reporter dans l'écran.
- **Configuration du jeton :**
  - ajoutez le claim facultatif `email` au jeton d'ID ;
  - sans adresse e-mail, l'Auth refuse la connexion.
- **Rôles d'application (recommandé) :**
  - créez un rôle par niveau d'accès, par exemple `SCIC.Admin`, `SCIC.User`, `SCIC.Reader` ;
  - dans **Applications d'entreprise → Utilisateurs et groupes**, assignez-les aux groupes ;
  - ils arrivent dans le claim `roles`, sans la limite des 200 groupes (au-delà, Entra n'envoie plus la liste des groupes).
- **À défaut, des groupes :** « Ajouter un claim de groupes ». Les valeurs reçues sont alors des object IDs, que l'écran permet de libeller.

### Comment le rôle est calculé

Le calcul se fait dans un trigger sur `auth.identities`, à chaque connexion SSO. Il lit `identity_data`, que seule l'Auth écrit. Il ne lit jamais `user_metadata`, que l'utilisateur peut modifier lui-même.

- **Plusieurs groupes reconnus :** le rôle le plus fort l'emporte.
- **Aucun groupe reconnu :** la personne reçoit le rôle par défaut du fournisseur, ou aucun accès, ce qui est le réglage recommandé.
- **Groupe retiré dans l'IdP :** le rôle baisse, ou l'accès disparaît, à la connexion suivante.
- **Membres non gérés par le SSO :** une appartenance donnée à la main (invitation, créateur de l'organisation) et le rôle owner ne sont jamais modifiés.
- **Pas d'espace personnel :** un compte créé par le SSO ne reçoit pas de « My workspace ».
- **Erreur dans le calcul :** elle ne bloque jamais la connexion. Elle n'accorde rien, et l'Auth la consigne dans ses logs.

Ce comportement est couvert par un jeu de 27 vérifications exécuté sur PGlite : correspondances, révocation, rôle owner, SAML, Keycloak, cloisonnement RLS.

## 3. Connecteur PRTG

Le modèle **PRTG Network Monitor** est disponible dans **Outils internes → Nouveau connecteur**. Il utilise l'API HTTP classique, passe par le relais, et s'authentifie avec une clé d'API passée dans le paramètre `apitoken`. Seul le chemin de chaque appel est journalisé, jamais l'URL complète avec la clé.

- **Lecture :**
  - capteurs par état ;
  - capteurs d'un équipement ;
  - équipements, recherche par nom ;
  - détail et canaux d'un capteur ;
  - historique ;
  - journal.
- **Écriture, sous approbation :**
  - acquittement ;
  - pause pour une durée ;
  - reprise ;
  - scan immédiat.
- **Identifiants :**
  - un utilisateur PRTG en lecture seule et sa clé dans le profil par défaut ;
  - une clé en lecture-écriture dans un second profil, réservé aux collaborateurs qui en ont besoin.
- **Certificat :** PRTG présente souvent un certificat interne. Donnez son autorité au relais avec `RELAY_CA_FILE`.

## 4. Pas encore couvert

- **Identité des agents par Keycloak :** jetons courts par collaborateur, vérifiés par les outils et les relais. La conception est à valider.
- **Paquet de déploiement :** chart Helm unique (Supabase auto-hébergé, backend, SPA, relais) et profil `onprem` qui coupe les dépendances externes. L'image du backend existe déjà, il manque le chart qui assemble l'ensemble.
- **Notion de cluster :** un relais par cluster, et les connecteurs Kubernetes, Loki et Argo CD créés d'un coup sur ce relais.
- **Alertmanager comme déclencheur** d'un collaborateur.
