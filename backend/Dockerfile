# Image du backend Express. Le contexte de build est ce dossier : src/edge/ est
# généré et versionné (npm run port:edge), il n'a pas besoin de supabase/.
#
#   docker build -t registry.interne/founderos/backend:0.1.0 backend
#   docker run -p 8787:8787 --env-file backend/.env registry.interne/founderos/backend:0.1.0

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8787
# Arrêt propre sur SIGTERM : index.ts laisse 25 s aux tâches de fond
# (EdgeRuntime.waitUntil). Donner au pod un terminationGracePeriodSeconds ≥ 30.
CMD ["node", "dist/index.js"]
