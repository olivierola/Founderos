# Une image pour tous les serveurs MCP (le chart pose MCP_SERVER) :
#   docker build -t quay.interne/ai-platform/mcp-server:0.1.0 MCP
# --build-arg SERVER=<clé ou liste> fixe seulement la valeur par défaut de MCP_SERVER.
#
# UBI Node 22 minimal : utilisateur 1001, groupe 0, compatible avec les UID
# arbitraires des SCC restricted-v2 d'OpenShift.

ARG NODE_IMAGE=registry.access.redhat.com/ubi9/nodejs-22-minimal:latest

FROM ${NODE_IMAGE} AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json package-lock.json ./
RUN npm ci
COPY --chown=1001:0 tsconfig.json tsconfig.build.json ./
COPY --chown=1001:0 src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ARG SERVER=""
ENV NODE_ENV=production \
    MCP_SERVER=${SERVER} \
    MCP_PORT=8443 \
    MGMT_PORT=9090
WORKDIR /opt/app-root/src
COPY --from=build --chown=1001:0 /opt/app-root/src/package.json ./
COPY --from=build --chown=1001:0 /opt/app-root/src/node_modules ./node_modules
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
# Catalogue par défaut ; en production, monté depuis le dépôt ai-policies (CATALOG_FILE),
# le même que celui d'OPA.
COPY --chown=1001:0 policies/catalog ./policies/catalog
USER 1001
EXPOSE 8443 9090
CMD ["node", "dist/main.js"]
