# Image du Job de migrations (G5) : le runner et les fichiers de
# supabase/migrations. Contexte de build : la racine du dépôt.
#
#   docker build -f deploy/migrations/Dockerfile -t <registre>/founderos/migrations:<tag> .
#   docker run --rm -e DATABASE_URL=postgres://… <registre>/founderos/migrations:<tag>

FROM node:22-alpine
WORKDIR /app
COPY deploy/migrations/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY deploy/migrations/runner.mjs deploy/migrations/migrate.mjs ./
COPY supabase/migrations ./migrations
# Le socle de la plateforme auto-hébergée (PLATFORM=self) : ce que Supabase
# fournit à la base, recréé sur un PostgreSQL ordinaire.
COPY backend/platform/sql ./platform-sql
USER node
CMD ["node", "migrate.mjs"]
