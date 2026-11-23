# FounderOS — backend Express

Remplace les edge functions Supabase (`supabase/functions/`). Deux modes :

- `PLATFORM=supabase` (défaut) : Supabase reste la base de données, l'auth, le
  storage et le realtime ;
- `PLATFORM=self` : ce backend les sert lui-même, sur un PostgreSQL à nous —
  voir [Plateforme auto-hébergée](#plateforme-auto-hébergée).

Les 100 fonctions sont servies aux mêmes chemins que chez Supabase
(`/functions/v1/<nom>`) : basculer un appelant ne change que l'hôte.

## Démarrer

```bash
cd backend
npm install
cp .env.example .env   # au minimum les clés Supabase
npm run dev            # http://localhost:8787
```

Depuis la racine : `npm run dev:backend`. Côté front, `VITE_API_URL=http://localhost:8787`
dans le `.env` racine envoie toutes les fonctions vers ce backend.

| Script              | Rôle                                                         |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | serveur avec rechargement (tsx watch)                        |
| `npm test`          | tests (node:test, sans appel à Supabase)                     |
| `npm run typecheck` | vérification TypeScript, code généré compris                 |
| `npm run build`     | compile vers `dist/`                                         |
| `npm start`         | lance `dist/index.js` (production)                           |
| `npm run dev:self`  | serveur en plateforme auto-hébergée (`.env.self`)            |
| `npm run platform`  | `keys`, `migrate`, `import` (plateforme auto-hébergée)       |

## Organisation

```
src/
  index.ts              démarrage, arrêt propre (attend les tâches de fond)
  server.ts             serveur HTTP : app Express + WebSocket
  app.ts                CORS, passerelle JWT, routes, erreurs
  env.ts                variables d'environnement
  shared/               code Express
    gateway.ts          vérification du JWT « à la passerelle » (verify_jwt)
    authz.ts            gardes d'accès (requireUser, requireProjectMember…)
    rate-limit.ts, supabase.ts, http.ts
  functions/            fonctions réécrites en Express (une par fichier)
  ws/                   fonctions WebSocket réécrites pour Node (deepgram-stream)
  compat/               exécution du code edge sous Node
    index.ts            objet Deno (env, DNS, TLS), EdgeRuntime.waitUntil
    express.ts          adaptateur Request/Response web ↔ Express
  edge/                 les edge functions, servies par ce backend (la source)
    registry.ts         liste des fonctions + exceptions verify_jwt
  harness/              le moteur des agents : OpenCode embarqué (runs, pont, cycle de vie)
  agents/               ce que le moteur assemble pour un agent (outils, prompt, fin de run)
```

### Deux sortes de fonctions

- **Edge** (`src/edge/`) : le code des anciennes edge functions, porté une fois
  depuis `supabase/functions/` puis maintenu ICI : le backend est la source
  (docs/harness-opencode/04). `supabase/functions/` est gelé, c'est la version
  de l'ancien cloud. Les API propres au runtime Supabase passent par `src/compat/`.
- **Réécrites** (`src/functions/`, `src/ws/`) : du code Express ou Node natif.

Le moteur des agents (`internal-agent-run`) n'est plus une edge function : c'est
le harnais OpenCode (`src/harness/`), servi à la même URL par `harness/route.ts`.

### Réglages de l'installation (G4)

Administration → Installation parle à `installation-admin`, fonction native de
ce backend (`src/functions/installation-admin.ts`) :

- les réglages sans secret (passerelle LLM et alias, hôtes MCP internes, OPA,
  émetteur des approbations, adresse publique, résolveur DNS) sont gardés dans
  `installation_settings` (migration 0283) ;
- le backend les lit au démarrage puis chaque minute (`src/shared/installation.ts`),
  et `Deno.env.get` de la couche de compatibilité les sert au code porté quand
  l'environnement ne fixe pas la variable : **l'environnement garde la priorité** ;
- seuls les réglages du catalogue sont permis ; les secrets restent dans
  l'environnement ou Vault, l'écran dit seulement s'ils sont présents ;
- chaque changement est journalisé (`installation_settings_history`) ;
- le diagnostic (`src/shared/installation-checks.ts`) teste la base et ses
  migrations, le chiffrement, la clé de signature et le JWKS public, la
  passerelle LLM (un appel court), les IdP, la garde SSO, les relais, les
  serveurs MCP (par `mcp-gateway`, sous la session de la personne), le port de
  métriques et OPA.

Qui administre : les adresses de `INSTALLATION_ADMINS`, ou les owners et admins
de l'organisation propriétaire. Sur une instance neuve (une seule organisation,
personne n'administre encore), son owner la revendique depuis l'écran.

### Réécrire une fonction en Express

1. Créer `src/functions/<nom>.ts` à partir de `src/edge/<nom>/index.ts` :
   - `await req.json()` → `req.body` (toujours un objet) ;
   - `return jsonResponse(x)` → `res.json(x)` ;
   - `return jsonResponse({ error }, { status })` → `throw new HttpError(status, error)` ;
   - les gardes de `_shared/authz.ts` → ceux de `src/shared/authz.ts`.
2. L'enregistrer dans `src/functions/index.ts`.
3. Retirer `src/edge/<nom>/` et son entrée de `src/edge/registry.ts`.

Garder les gardes d'accès : avec la clé service role, RLS ne protège plus rien,
toute route qui reçoit un id de workspace, de projet ou de ressource appelle
`requireWorkspaceMember`, `requireProjectMember` ou `requireResourceAccess`.

## Sécurité

- **Passerelle JWT** : l'équivalent de `verify_jwt` chez Supabase — un JWT
  Supabase valide dans `Authorization` (la clé anon en est un). Réponses 401
  identiques à celles de Supabase. Deux modes, `GATEWAY_VERIFY_JWT` :
  - `production` (défaut) : seules les fonctions que la passerelle Supabase
    protège réellement (relevé du 2026-10-02 : 8 sur 100, liste dans
    `src/shared/gateway.ts`). La bascule ne change rien pour les appelants.
  - `strict` : toutes les fonctions sauf les exceptions de `supabase/config.toml`,
    le réglage voulu par FOS-16. À activer une fois les appelants vérifiés.

  Dans les deux modes, les exceptions de `config.toml` (webhooks signés, runners,
  SDK, WebSocket…) l'emportent ; le générateur les reprend automatiquement.
- **IP client** : lue selon `TRUST_PROXY` ; ce que le client écrit lui-même dans
  `x-forwarded-for` est ignoré.
- **Rejets non gérés** : journalisés au lieu d'arrêter le serveur (le code edge
  lance des `fetch` sans `.catch`, ce qui ne tuait qu'un isolat sous Deno).

## Plateforme auto-hébergée

Avec `PLATFORM=self`, le backend sert, sur un PostgreSQL ordinaire, tout ce que
Supabase fournissait, **aux mêmes chemins et dans les mêmes formats** :

| Chemin | Remplace | Ce qui est repris |
| --- | --- | --- |
| `/rest/v1` | PostgREST | select (champs, alias, `::cast`, chemins JSON), ressources imbriquées (plusieurs-à-un, un-à-plusieurs, plusieurs-à-plusieurs, indices `!fkey`, `!inner`, filtres/tri/limite imbriqués), tous les opérateurs, `or`/`and`/`not`, `order`, `limit`/`offset`, `count`, `single`/`maybeSingle`, insert/upsert (fusion, ignore, `on_conflict`, `columns`), update, delete, `rpc` (surcharges, défauts, fonctions ensemblistes), erreurs et statuts HTTP de PostgREST |
| `/auth/v1` | GoTrue | inscription, mot de passe, rafraîchissement (fenêtre de réutilisation), PKCE et implicite, utilisateur, déconnexion (`global`/`local`/`others`), réinitialisation et liens d'e-mail, OAuth (Google, Apple, GitHub, Azure, Keycloak, fournisseurs OIDC d'entreprise ajoutés à chaud), MFA TOTP (aal2), API d'administration (users, bannissement, `generate_link`, `invite`, `custom-providers`) |
| `/storage/v1` | Supabase Storage | envoi (multipart ou brut, `x-upsert`), lecture sous RLS, lecture publique, URL signées, liste, déplacement, copie, suppression, buckets — les politiques RLS de `storage.objects` décident |
| `/realtime/v1` | Realtime | `postgres_changes` (filtres, RLS de l'abonné), broadcast, presence ; protocole Phoenix vsn 1 et 2 |
| (workers) | pg_cron, pg_net | les tâches de `cron.job` à leur heure ; les requêtes de `net.http_post` envoyées |

supabase-js — dans le front comme dans le code des fonctions — ne voit pas la
différence. **Basculer, c'est changer une URL et des clés** ; le code ne change pas.

### Comment c'est fait

- **La base** (`platform/sql/00_platform.sql`) : les rôles `anon`,
  `authenticated`, `service_role`, les schémas `auth` (tables de GoTrue, colonne
  pour colonne), `storage`, `vault` (secrets chiffrés pgcrypto), et `cron`,
  `net`, `pgmq` aux mêmes signatures que les extensions qu'ils remplacent. Puis
  `supabase/migrations` **telles quelles**, dans le même registre que la CLI
  Supabase (`supabase_migrations.schema_migrations`).
- **Chaque requête d'API** s'exécute dans sa transaction sous le rôle de son
  JWT, avec `request.jwt.claims` posé comme le fait PostgREST : `auth.uid()` et
  toute la RLS des migrations s'appliquent à l'identique.
- **Les réponses JSON** sont construites par PostgreSQL (`json_agg`), comme
  PostgREST : dates, nombres et JSON arrivent au front sous la même forme.
- **Les mots de passe** sont hachés en bcrypt, comme GoTrue : un compte importé
  de Supabase se connecte avec son mot de passe.
- **Le schéma reconstruit** depuis les migrations a été comparé à celui de
  l'instance SaaS (`src/platform/schema-drift.ts`) : 380 tables et vues des deux
  côtés ; les deux écarts trouvés (colonnes ajoutées hors migration) sont
  rattrapés par 0092 et 0290.

### Essayer en local (sans rien installer)

```bash
cd backend
cp .env.self.example .env.self      # puis un JWT_SECRET de 32 caractères au moins
npm run dev:self                    # base PGlite dans .data/pg, migrations au premier démarrage
npm run platform -- keys            # les variables du front
```

Côté front, mettre dans le `.env` de la racine les trois lignes que
`platform -- keys` affiche (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_API_URL` = l'URL du backend), puis `npm run dev`. PGlite est un vrai
PostgreSQL compilé en WebAssembly : parfait pour essayer et tester, une seule
connexion — en production, `DATABASE_URL=postgres://…`.

### Basculer, et revenir

1. **Préparer la base** : PostgreSQL 15+ avec l'extension `vector` (pgvector)
   installée sur le serveur. `npm run platform -- migrate` (ou le premier
   démarrage) applique socle et migrations.
2. **Emporter les données** de Supabase (connexion directe, « Database →
   Connection string » du projet) :

   ```bash
   npm run platform -- import --from "postgresql://postgres:<mdp>@db.<ref>.supabase.co:5432/postgres"      --storage --source-url https://<ref>.supabase.co --source-key <service_role>
   ```

   Comptes (mots de passe, sessions ouvertes, MFA), identités, tout `public`,
   storage (métadonnées et fichiers), secrets du vault. La source fait foi : les
   tables de données de la cible sont vidées d'abord (`--force` si elle a déjà
   des comptes). Le rôle cible doit être superutilisateur (copie sans
   déclencheurs). Les jetons d'accès en cours ne valent plus (autre secret) ; les
   sessions, elles, continuent : chacun reste connecté.
3. **Démarrer** le backend en `PLATFORM=self`, **reconstruire le front** avec
   les variables de `platform -- keys`, et pointer les runners, relais et
   webhooks vers le backend (liste de la section suivante, points 4 à 6).
4. **Revenir** : `PLATFORM=supabase` et les anciennes variables. Rien n'a été
   déconnecté côté Supabase.

En conteneur : `PLATFORM_MIGRATE=false` pour le backend, et le service
`migrate` (`deploy/migrations`) lancé avec `PLATFORM=self` prépare la base ;
`STORAGE_DIR` sur un volume.

### Ce qui n'est pas repris

- **SAML** (`/auth/v1/sso`) : refusé avec un message clair. Les IdP d'entreprise
  passent par OIDC (Entra ID, Keycloak, Okta…), qui fonctionne.
- Connexion par téléphone (SMS), comptes anonymes, liens magiques par OTP
  (`signInWithOtp`) : non utilisés par l'app, non implémentés.
- PostgREST : agrégats (`count()` dans un select), syntaxe `...rel()`,
  `Prefer: missing=default`, tri par colonne d'une ressource imbriquée.
- Storage : envois reprenables (TUS) et transformation d'images.
- Realtime : l'ancienne ligne d'un UPDATE/DELETE ne porte que la clé primaire
  (comme Supabase sans `REPLICA IDENTITY FULL`) ; broadcast binaire.

### Tests

`src/platform/platform.test.ts` (analyse PostgREST, SQL, cron, JWT, TOTP) et
`src/platform/platform.e2e.test.ts` : le vrai serveur sur une base PGlite neuve
(socle + toutes les migrations) et supabase-js en face — inscription,
connexion, RLS, déclencheurs, administration, MFA, storage, realtime, edge
functions, pg_net et la chaîne des ticks d'agents (pgmq → vault → pg_net →
`internal-agent-run`). `PLATFORM_E2E=0` saute ce dernier.

## Mise en production — ce qui reste branché sur Supabase

Le backend n'est appelé que par ceux à qui on donne son URL. À la bascule :

1. **Déployer** sur un hôte qui garde le processus en vie (Railway, Render,
   Fly.io, un cluster Kubernetes…), avec `FUNCTIONS_URL` = l'URL publique et les
   secrets de `.env.example`. Le `Dockerfile` de ce dossier construit l'image
   (`docker build -t <registre>/founderos/backend backend`) ; sur Kubernetes,
   sonde sur `GET /health` et `terminationGracePeriodSeconds` ≥ 30.
2. **Front** : `VITE_API_URL` sur Vercel, et l'URL du backend dans `connect-src`
   de la CSP de `vercel.json`.
3. **pg_cron** : depuis la migration 0273, les tâches planifiées appellent
   `<functions_base_url>/functions/v1/...`, où `functions_base_url` est un
   secret du vault (l'instance SaaS a reçu son URL actuelle). Pour basculer :
   `select vault.update_secret(id, 'https://<backend>') from vault.secrets where name = 'functions_base_url';`
   (ou `vault.create_secret('https://<backend>', 'functions_base_url')` s'il
   n'existe pas encore).
4. **Runners** (`runner`, `ops-runner`, `test-runner`, `skill-recorder`) :
   `FUNCTIONS_URL` dans leur `.env`.
5. **Widget et SDK** : l'attribut `data-endpoint` du snippet d'intégration
   (sinon `public/widget.js` garde l'URL Supabase par défaut).
6. **Tiers** : URL de webhook chez Stripe (`stripe-webhook`), Slack (`slack-gateway`,
   puis retirer la fonction de `EDGE_ONLY` dans `src/lib/edge.ts`), Teams
   (`teams-gateway`), messageries (`messaging-gateway`), sources Sentinel
   (`automation-receiver`).
7. Une fois le trafic basculé et vérifié : supprimer les edge functions et
   `supabase/functions/`, puis retirer le générateur (`src/edge/` devient la source).
