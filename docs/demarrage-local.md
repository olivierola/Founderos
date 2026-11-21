# Démarrer FounderOS en local

En local, FounderOS tourne en **mode auto-hébergé** (`PLATFORM=self`), sans Supabase ni Docker. Il y a deux processus :

- **le backend** (`backend/`, port 8787) : base PostgreSQL embarquée (PGlite, dans `backend/.data/pg`), authentification, stockage, temps réel, les fonctions edge portées et le harnais OpenCode ;
- **le front** (Vite, port 5173), branché sur ce backend.

## En une commande

```
npm run dev:local
```

Le script `scripts/start-local.mjs` enchaîne :

1. Il vérifie Node 22 ou plus.
2. Il installe les dépendances du front et du backend si `node_modules` manque.
3. Il prépare `backend/.env.self` :
   - il le crée depuis `.env.self.example` s'il n'existe pas ;
   - il génère `JWT_SECRET` s'il est vide ;
   - il pose `PLATFORM=self` et `HARNESS_OPENCODE=1`.
4. Il applique les migrations à la base locale.
5. Il importe une base Supabase, si `--import` est donné.
6. Il écrit l'URL du backend et la clé anon dans `.env.local` à la racine. Vite les préfère à `.env`, qui reste celui du mode cloud.
7. Il démarre le backend, attend qu'il réponde sur `/health` (environ 20 s au premier démarrage du harnais), puis démarre le front.

Ensuite :
- ouvre http://localhost:5173 ;
- Ctrl+C arrête les deux processus.

### Options

| Option | Effet |
|---|---|
| `--import "<URL Postgres>"` | Copie d'abord une base Supabase : comptes, schéma public, storage, secrets du vault. L'index de recherche des agents est reconstruit à la fin |
| `--force` | Avec `--import` : écrase une base locale qui a déjà des comptes |
| `--source-url <https://ref.supabase.co> --source-key <service_role>` | Avec `--import` : copie aussi les fichiers du storage |
| `--no-harness` | Désactive le harnais OpenCode : tous les agents restent sur l'ancien moteur |
| `--backend-only` | Ne démarre pas le front |
| `--setup-only` | Prépare tout sans rien démarrer |
| `--skip-install` | Ne vérifie pas les dépendances (démarrages suivants) |

Les options passent après `--` : `npm run dev:local -- --import "postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres"`.

## À faire une fois, à la main

1. **Une clé de modèle**, sans quoi les agents ne répondent pas. Dans `backend/.env.self` :
   ```
   LLM_UPSTREAM=openrouter
   OPENROUTER_API_KEY=sk-or-…
   ```
   Pour le harnais, `HARNESS_MODEL` donne un modèle par défaut (voir `.env.self.example`).
2. **Des données.** Une base locale neuve est vide. Deux possibilités :
   - importer le cloud, une fois, avec `--import` ;
   - créer un compte depuis l'écran d'inscription du front.
3. **Passer des agents sur OpenCode.** Les agents restent sur l'ancien moteur tant que leur colonne `harness` n'est pas changée. Cette mise à jour se fait en SQL sur la base locale :
   ```sql
   update public.internal_agents set harness = 'opencode' where id = '<agent>';
   ```

## Les mêmes étapes, à la main

```
npm install && npm --prefix backend install
cp backend/.env.self.example backend/.env.self   # puis remplir JWT_SECRET (32 caractères ou plus) et la clé de modèle
cd backend
npm run platform -- migrate                      # base locale
npm run platform -- import --from "<URL>"        # facultatif
npm run platform -- keys                         # copier les 3 lignes VITE_* dans ../.env.local
npm run dev:self                                 # backend sur :8787
# dans un autre terminal, à la racine :
npm run dev                                      # front sur :5173
```

## Outils utiles

| Commande (dans `backend/`) | Rôle |
|---|---|
| `npm run platform -- keys` | Les clés anon et service_role, et les lignes `VITE_*` du front |
| `npm run platform -- migrate [--dry-run]` | Appliquer les migrations sans démarrer le serveur |
| `npm run platform -- reindex` | Reconstruire l'index de recherche des agents |
| `npm test` | Les tests du backend |

## Revenir au cloud

Supprime les trois lignes `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` et `VITE_API_URL` de `.env.local`, ou supprime le fichier. Le front reprend alors le `.env` du mode Supabase.

## En cas de souci

- **Le front ne démarre pas** et le script dit « le backend ne répond pas sur /health » : lis les lignes `backend │` au-dessus. Le plus souvent, c'est un port 8787 déjà pris ou une erreur de `.env.self`.
- **Base verrouillée.** PGlite n'accepte qu'un processus à la fois. Arrête le backend avant `migrate`, `import` ou `reindex`.
- **Repartir de zéro.** Supprime `backend/.data/pg`, puis relance `npm run dev:local`. Cela efface toutes les données locales.
