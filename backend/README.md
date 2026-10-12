# FounderOS — backend Express

Remplace les edge functions Supabase (`supabase/functions/`). Supabase reste la
base de données, l'auth, le storage et le realtime.

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
| `npm run port:edge` | régénère `src/edge/` depuis `supabase/functions/`            |

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
  edge/                 GÉNÉRÉ — copie des edge functions, ne pas modifier
    registry.ts         liste des fonctions + exceptions verify_jwt
scripts/
  port-edge.mjs         le générateur de src/edge/
```

### Deux sortes de fonctions

- **Générées** (`src/edge/`, 96 fonctions) : le code des edge functions, copié
  par `scripts/port-edge.mjs`. Seules les parties propres à Supabase sont
  réécrites — imports `esm.sh` → npm, `Deno.serve` → export, URL internes →
  `FUNCTIONS_URL`. Le reste est identique à la source, ce qui garantit le même
  comportement. Pour corriger l'une d'elles : modifier `supabase/functions/`,
  puis `npm run port:edge`.
- **Réécrites** (`src/functions/`, `src/ws/`) : du code Express ou Node natif.
  Le générateur ignore toute fonction qui a un fichier ici.

Tant que les edge functions restent déployées, `npm run port:edge` après chaque
changement dans `supabase/functions/` garde les deux versions identiques.

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
3. `npm run port:edge` : la copie générée disparaît.

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
