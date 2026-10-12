# Implémentation en mode test : backend Express, SSO, Azure OpenAI, connecteurs

Ce document explique comment monter un environnement de **test**, puis comment vérifier ce qui a été livré pour l'installation dédiée :

- le backend Express qui remplace les edge functions ;
- le SSO d'entreprise ;
- le routage vers Azure OpenAI ;
- le connecteur PRTG ;
- le raccordement des tâches planifiées.

La configuration de production chez le client est décrite dans [enterprise-onprem.md](enterprise-onprem.md).

## 1. Ce qui est testé

| Brique | Où | Rôle |
| --- | --- | --- |
| Backend Express | [backend/](../backend/README.md) | Sert les 101 fonctions sur `/functions/v1/<nom>` sous Node, au lieu des edge functions Supabase. 97 sont générées depuis `supabase/functions/`, 4 réécrites en Express. |
| SSO d'entreprise | migration `0272`, fonction `sso-admin`, écran Administration → Authentification | Fournisseurs OIDC (Entra ID, Keycloak) ou SAML enregistrés à chaud. Rôle calculé depuis les groupes à chaque connexion. |
| Azure OpenAI | `supabase/functions/_shared/llm-upstream.ts` | Avec `LLM_UPSTREAM=azure`, chat et embeddings partent vers une seule ressource Azure, et tout autre hôte est refusé. |
| Connecteur PRTG | modèle dans `custom-connector-model.ts` | Lecture des capteurs, journal et historique ; écritures (acquittement, pause, reprise, scan) sous approbation. |
| URL des tâches planifiées | migration `0273` | pg_cron appelle `<functions_base_url>/functions/v1/…`, une URL lue dans le vault et non plus écrite en dur. |

## 2. Architecture de test

```
 Navigateur ──► Front Vite :5173 ──► Backend Express :8787 ──► Supabase local :54321
                     │                      │      ▲            (Auth, PostgREST, Storage,
                     │                      │      │             Realtime, Postgres :54322)
                     │                      │      └── pg_cron / pg_net
                     │                      │          via host.docker.internal:8787
                     │                      ├──► LLM : DeepSeek, ou Azure OpenAI (LLM_UPSTREAM=azure)
                     │                      └──► Relais d'outils ──► PRTG, Prometheus…
                     └──► Keycloak :8080 (SSO, via host.docker.internal)
```

Deux modes possibles :

- **Mode A, tout en local (recommandé).** Supabase tourne dans Docker via la CLI. On peut tout tester, SSO Keycloak compris, sans toucher aucune donnée réelle.
- **Mode B, projet Supabase de test hébergé.** Sans Docker. Il faut un projet Supabase **dédié aux tests**, jamais celui de production. Le SSO n'y est testable qu'avec un IdP joignable depuis Internet (un tenant Entra de test, par exemple).

## 3. Prérequis

- Node 22 ou plus, puis `npm install` à la racine et dans `backend/`.
- **Mode A :** Docker Desktop lancé, et capable de télécharger des images. Derrière un proxy d'entreprise, renseigner le proxy dans Docker Desktop → Settings → Resources → Proxies. Sinon, le téléchargement échoue avec `lookup public.ecr.aws: no such host`.
- **Mode B :** un projet Supabase de test, avec ses clés (Settings → API).
- Une clé LLM : `DEEPSEEK_API_KEY`, ou une ressource Azure OpenAI avec un déploiement de chat et un déploiement `text-embedding-3-small` ou `-large`.

## 4. Mise en place

### Mode A : tout en local

```bash
# 1. Supabase local : applique toutes les migrations de supabase/migrations.
npx supabase start

# 2. Écrit .env.local (front) et backend/.env.local (backend) depuis
#    `supabase status`, puis affiche trois lignes SQL.
node scripts/dev-local-env.mjs
```

3. Collez les trois lignes SQL affichées dans Studio (<http://127.0.0.1:54323>, SQL Editor) :

   ```sql
   select vault.create_secret('http://host.docker.internal:8787', 'functions_base_url');
   select vault.create_secret('<service_role_key locale>', 'agent_service_key');
   select vault.create_secret('<AGENT_TICK_SECRET de backend/.env.local>', 'agent_tick_secret');
   ```

4. Ajoutez la configuration LLM en bas de `backend/.env.local` (voir section 5).

5. Lancez le backend et le front, dans deux terminaux :

   ```bash
   npm run dev:backend   # http://localhost:8787
   npm run dev           # http://localhost:5173
   ```

6. Créez un compte sur <http://localhost:5173>. L'e-mail de confirmation arrive dans Mailpit (<http://127.0.0.1:54324>).

`scripts/dev-local-env.mjs` règle aussi :
- `GATEWAY_VERIFY_JWT=strict` ;
- `SSO_ADMIN_ENABLED=1` ;
- `SSO_ALLOW_HTTP=1`, nécessaire pour un Keycloak en http ;
- `FUNCTIONS_URL=http://host.docker.internal:8787`, l'adresse du backend vue depuis les conteneurs.

Les fichiers `.env.local` priment sur les `.env`. Les supprimer suffit à revenir à la configuration habituelle.

### Mode B : projet Supabase de test hébergé

```bash
npx supabase link --project-ref <ref du projet de TEST>
npx supabase db push          # applique les migrations, 0272 et 0273 comprises
```

1. Remplissez `backend/.env.local` à partir de `backend/.env.example` :
   - les clés du projet de test ;
   - `GATEWAY_VERIFY_JWT=strict` ;
   - `SSO_ADMIN_ENABLED=1`.
2. Ajoutez au `.env.local` de la racine :

   ```ini
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon du projet de test>
   VITE_API_URL=http://localhost:8787
   ```

3. Lancez `npm run dev:backend` et `npm run dev`.

Limites de ce mode :

- **Les tâches planifiées n'atteignent pas le backend.** pg_cron tourne dans le cloud et ne voit pas `localhost:8787`. Pour tester les agents de bout en bout, exposez le backend par un tunnel HTTPS et mettez cette URL dans `functions_base_url`. Sinon, testez les agents en mode A.
- **Le trigger de synchronisation SSO peut manquer.** Si l'instance hébergée refuse sa création sur `auth.identities`, la migration 0272 l'a signalé par un avertissement, sans échouer. Les connexions SSO aboutissent alors, mais sans calcul de rôle : testez le SSO en mode A.

## 5. Configuration LLM de test

DeepSeek (comportement SaaS) :

```ini
DEEPSEEK_API_KEY=sk-...
```

Azure OpenAI (comportement de l'installation dédiée) :

```ini
LLM_UPSTREAM=azure
AZURE_OPENAI_BASE_URL=https://<ressource>.openai.azure.com/openai/v1
AZURE_OPENAI_DEPLOYMENT=<déploiement chat>
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=<déploiement embeddings>
AZURE_OPENAI_API_KEY=<clé>
# ou, si les clés sont désactivées sur la ressource :
# AZURE_OPENAI_TENANT_ID=… AZURE_OPENAI_CLIENT_ID=… AZURE_OPENAI_CLIENT_SECRET=…
```

Redémarrez le backend après chaque changement de `backend/.env.local`.

## 6. IdP de test : Keycloak (mode A)

Un realm prêt à l'emploi est fourni dans [scripts/dev/keycloak/scic-realm.json](../scripts/dev/keycloak/scic-realm.json) :
- le realm `scic` et son client `founderos`, de secret `founderos-dev-secret` ;
- un mapper qui place les groupes dans le claim `groups` du jeton d'ID ;
- trois comptes, dont le mot de passe est égal au nom.

| Compte | Groupe | Résultat attendu |
| --- | --- | --- |
| `alice` | `sre` | Membre |
| `bob` | `admins` | Admin |
| `carol` | aucun | Aucun accès |

Lancement, en PowerShell depuis la racine du dépôt :

```powershell
docker run --rm -p 8080:8080 `
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin `
  -e KC_HOSTNAME=http://host.docker.internal:8080 `
  -v "${PWD}\scripts\dev\keycloak:/opt/keycloak/data/import" `
  quay.io/keycloak/keycloak:26.0 start-dev --import-realm
```

L'issuer est `http://host.docker.internal:8080/realms/scic`. C'est la seule adresse que voient à la fois le navigateur et le conteneur de l'Auth : Docker Desktop l'ajoute au fichier hosts de Windows.

## 7. Plan de test

Chaque cas a un identifiant, des étapes et un résultat attendu. Cochez au fur et à mesure.

### 7.1 Backend Express

| ID | Étapes | Résultat attendu |
| --- | --- | --- |
| BE-01 | `curl http://localhost:8787/health` | `{"ok":true}` |
| BE-02 | Naviguer dans l'app, onglet Réseau du navigateur (filtre `functions/v1`) | Les appels de fonctions partent vers `localhost:8787/functions/v1/…`, pas vers le port 54321 ni vers `supabase.co`. Le backend ne journalise pas les requêtes : c'est le navigateur qui fait foi. |
| BE-03 | `curl -X POST http://localhost:8787/functions/v1/internal-agent-run -d '{}'` | 401, `"code":"UNAUTHORIZED_NO_AUTH_HEADER"` : la passerelle stricte refuse sans JWT. |
| BE-04 | `curl -X POST http://localhost:8787/functions/v1/connector-action -d '{}'` | La réponse ne porte pas le code `UNAUTHORIZED_NO_AUTH_HEADER` : `connector-action` est une exception de `config.toml` (le relais n'a pas de JWT), et c'est la fonction elle-même qui refuse la requête vide. |
| BE-05 | `cd backend && npm test` | 125 tests passent, sans appel réseau. |
| BE-06 | `cd backend && npm run typecheck` | 0 erreur. |
| BE-07 | Modifier un message dans `supabase/functions/…`, puis `npm run port:edge` et redémarrer | Le changement est visible : `src/edge/` est bien régénéré depuis la source. |

### 7.2 Tâches planifiées (migration 0273)

| ID | Étapes | Résultat attendu |
| --- | --- | --- |
| CRON-01 | Avant le SQL du vault : `select count(*) from net._http_response;` (Studio) | 0. Sans clé service dans le vault, les tâches s'arrêtent avant d'envoyer quoi que ce soit. |
| CRON-02 | Ne créer que `agent_service_key`, sans `functions_base_url`, puis `select status, return_message from cron.job_run_details order by start_time desc limit 5;` | Échecs avec « functions_base_url absent du vault ». Aucune requête ne part ailleurs. |
| CRON-03 | Créer les trois secrets, puis envoyer un message à un collaborateur | Le run avance d'étape en étape. Dans `net._http_response`, les dernières lignes ont un `status_code` 2xx et pas d'`error_msg` : le backend a répondu. |

### 7.3 Azure OpenAI

| ID | Étapes | Résultat attendu |
| --- | --- | --- |
| LLM-01 | `LLM_UPSTREAM=azure` configuré, aucune clé DeepSeek ni Groq. Converser avec un collaborateur. | Réponses normales, alors qu'aucun autre fournisseur n'est configuré. |
| LLM-02 | Ajouter `LLM_UPSTREAM=azure` sans `AZURE_OPENAI_DEPLOYMENT`, redémarrer, converser | Les appels échouent avec le message « LLM_UPSTREAM=azure demande AZURE_OPENAI_BASE_URL et AZURE_OPENAI_DEPLOYMENT. » |
| LLM-03 | Router un agent vers un endpoint auto-hébergé (fournisseur personnalisé) sur un autre hôte | Refus : « Appel LLM vers <hôte> refusé : ce déploiement n'autorise que <ressource> ». Le refus disparaît si l'hôte est ajouté à `LLM_ALLOWED_HOSTS`. |
| LLM-04 | Ajouter un document dans une base de connaissances (RAG), puis poser une question dessus | L'ingestion réussit sans `JINA_API_KEY`. La réponse cite le document : les vecteurs viennent d'Azure, en 1024 dimensions. |
| LLM-05 | Remplacer la clé par le trio `AZURE_OPENAI_TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` | Mêmes réponses : le jeton Entra est obtenu puis mis en cache. |
| LLM-06 | Éditeur de documents → menu IA (⌘+J) | La génération en flux arrive d'Azure (`office-ai-stream`). |

### 7.4 SSO (mode A avec Keycloak, ou un tenant Entra de test)

Préalable : être connecté avec le compte créé à la section 4, owner de son organisation.

| ID | Étapes | Résultat attendu |
| --- | --- | --- |
| SSO-01 | Administration → Authentification | L'écran s'ouvre et affiche la Redirect URI `http://127.0.0.1:54321/auth/v1/callback`. |
| SSO-02 | Ajouter un fournisseur → Keycloak : serveur `http://host.docker.internal:8080`, realm `scic`, client `founderos`, secret `founderos-dev-secret`, claim `groups`. Cliquer « Tester ». | « L'IdP répond comme attendu », avec l'issuer `…/realms/scic`. |
| SSO-03 | Enregistrer, puis ajouter les correspondances `sre` → Membre et `admins` → Admin | Le fournisseur apparaît « Actif », avec ses deux correspondances. |
| SSO-04 | Se déconnecter | La page de connexion affiche « Continue with Keycloak ». |
| SSO-05 | Se connecter avec `alice` | Elle arrive dans l'organisation comme Membre, sans « My workspace » personnel. Journal : « Accès créé », valeurs reçues `sre`. |
| SSO-06 | Se connecter avec `bob` | Admin. Journal : « Accès créé ». |
| SSO-07 | Se connecter avec `carol` | Authentifiée, mais sans organisation. Journal : « Aucun groupe reconnu ». |
| SSO-08 | Dans Keycloak, retirer `alice` du groupe `sre`, puis la reconnecter | L'accès est retiré. Journal : « Accès retiré ». |
| SSO-09 | Inviter à la main un compte en Lecteur, puis le connecter par SSO avec un groupe admin | Il reste Lecteur. Journal : « Géré à la main ». |
| SSO-10 | Tentative d'élévation. Récupérer le JWT de `carol` dans le stockage local du navigateur (clé `sb-…-auth-token`, champ `access_token`), puis : `curl -X PUT http://127.0.0.1:54321/auth/v1/user -H "apikey: <anon>" -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"data":{"groups":["admins"]}}'`. Reconnecter `carol`. | Toujours aucun accès : le rôle vient des données d'identité écrites par l'Auth, jamais de `user_metadata`. |
| SSO-11 | Activer « Connexion par SSO uniquement » | La page de connexion n'affiche plus que le bouton SSO, et `/signup` renvoie vers `/login`. |
| SSO-12 | Supprimer le fournisseur | Le bouton disparaît, et « SSO uniquement » se désactive de lui-même : le mot de passe revient. |
| SSO-13 | Entra (tenant de test) : préréglage Entra ID, claim `roles`, rôles d'application assignés à des groupes | Même comportement que SSO-05 à SSO-08, avec des valeurs comme `SCIC.User`. Si le journal indique « claim absent du jeton », vérifier les rôles assignés et le claim facultatif `email`. |

### 7.5 Connecteurs et relais

| ID | Étapes | Résultat attendu |
| --- | --- | --- |
| CON-01 | Outils internes → Relais → Nouveau relais | La commande d'installation affichée contient `FOUNDEROS_URL=http://localhost:8787`. |
| CON-02 | Lancer le relais (voir ci-dessous) | Le relais passe « En ligne » et le backend reçoit ses appels à `connector-action`. |
| CON-03 | Nouveau connecteur → modèle PRTG : URL de l'instance PRTG de test, transport relais, clé d'API en lecture. Cliquer « Tester ». | `list_sensors_by_status` répond la liste des capteurs en panne, éventuellement vide. |
| CON-04 | Demander à un collaborateur « quels capteurs PRTG sont en panne ? » | Il appelle les opérations de lecture sans demander d'approbation. |
| CON-05 | Lui demander d'acquitter un capteur | Une approbation est demandée avant tout appel à `acknowledgealarm.htm` : les écritures sont approuvées par défaut, sauf si l'autonomie du collaborateur l'en dispense. |
| CON-06 | Ouvrir le journal d'accès du connecteur | Seul le chemin est journalisé (`/api/table.json`). Ni la clé `apitoken` ni l'URL complète n'y figurent. |

Lancer le relais en local (PowerShell) :

```powershell
cd connector-relay; npm install
$env:FOUNDEROS_URL="http://localhost:8787"; $env:RELAY_TOKEN="fosr_..."; $env:RELAY_ALLOWED_HOSTS="prtg.test.local"
node src/index.js
```

## 8. Dépannage

| Symptôme | Cause probable | Remède |
| --- | --- | --- |
| `supabase start` : `lookup public.ecr.aws: no such host` | Docker Desktop ne sort pas sur Internet (proxy, DNS) | Configurer le proxy dans Docker Desktop, ou passer au mode B. |
| 401 `UNAUTHORIZED_NO_AUTH_HEADER` sur une page publique | Passerelle `strict` et appel sans session | Normal pour une fonction protégée. Pour tester comme le SaaS : `GATEWAY_VERIFY_JWT=production`. |
| Retour SSO sur la page d'accueil plutôt que sur `/orgs` | URL de retour non autorisée par l'Auth | `additional_redirect_urls` doit contenir `http://localhost:5173/**` (déjà dans `supabase/config.toml`, après redémarrage de la stack). |
| « Tester » échoue sur un issuer `http://` | `SSO_ALLOW_HTTP` absent | Mettre `SSO_ALLOW_HTTP=1` dans `backend/.env.local` (test seulement). |
| Journal SSO : « claim absent du jeton » | L'IdP n'envoie pas les groupes dans le jeton d'ID | Keycloak : mapper « Group Membership » avec « Add to ID token ». Entra : rôles d'application assignés, ou claim de groupes. |
| Connexion Entra refusée par l'Auth | Pas d'e-mail dans le jeton | Ajouter le claim facultatif `email` au jeton d'ID. |
| Les runs d'agents n'avancent pas | Vault incomplet, ou backend injoignable depuis les conteneurs | Vérifier les trois secrets du vault et `cron.job_run_details`. |
| `Appel LLM vers … refusé` | `LLM_UPSTREAM=azure` actif, et une fonction vise un autre hôte | Comportement voulu. Ajouter l'hôte à `LLM_ALLOWED_HOSTS` s'il est légitime. |

## 9. Remise à zéro

```bash
npx supabase stop --no-backup   # mode A : efface la base locale
```

Supprimez ensuite `.env.local` et `backend/.env.local` pour revenir à la configuration habituelle. Le conteneur Keycloak, lancé avec `--rm`, disparaît à son arrêt.

## 10. Vérifié pendant le développement, et non vérifié

Déjà vérifié :

- typage du front et du backend (0 erreur) ;
- 125 tests du backend ;
- `deno check` sur les fonctions modifiées, hors les 2 fonctions Composio, que l'indisponibilité d'esm.sh a empêché de vérifier ;
- démarrage du backend compilé, avec les seules dépendances de production ;
- logique SQL des migrations 0272 (27 cas) et 0273 (14 cas), sur PGlite.

Pas encore vérifié : la connexion réelle Keycloak ou Entra contre l'Auth, les appels réels à Azure OpenAI et à PRTG, et la construction de l'image Docker du backend. C'est l'objet de ce plan de test.
