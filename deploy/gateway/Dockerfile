# Passerelle d'entreprise FounderOS (G7) : le relais et les serveurs MCP dans
# une seule image, le seul composant installé chez le client en mode cloud.
# Contexte de construction : la racine du dépôt.
#
#   docker build -f deploy/gateway/Dockerfile -t <registre>/founderos/gateway:<tag> .
#   docker build -f deploy/gateway/Dockerfile --build-arg WITH_K8S_TOOLS=true -t <registre>/founderos/gateway:<tag>-k8s .
#
# UBI Node 22 minimal : utilisateur 1001, groupe 0, compatible avec les UID
# arbitraires des SCC restricted-v2 d'OpenShift. Rien n'est écrit hors de /tmp.

ARG NODE_IMAGE=registry.access.redhat.com/ubi9/nodejs-22-minimal:latest

FROM ${NODE_IMAGE} AS mcp
WORKDIR /opt/app-root/src
COPY --chown=1001:0 MCP/package.json MCP/package-lock.json ./
RUN npm ci
COPY --chown=1001:0 MCP/tsconfig.json MCP/tsconfig.build.json ./
COPY --chown=1001:0 MCP/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
# helm et kubectl, pour les opérations « commande » du relais (RELAY_ALLOWED_BINARIES).
ARG WITH_K8S_TOOLS=false
ARG HELM_VERSION=v3.15.4
ARG KUBECTL_VERSION=v1.30.4
ARG TARGETARCH=amd64
USER 0
RUN if [ "$WITH_K8S_TOOLS" = "true" ]; then \
      microdnf install -y tar gzip && microdnf clean all \
      && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" | tar -xz -C /tmp \
      && mv "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
      && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
      && chmod 0755 /usr/local/bin/kubectl /usr/local/bin/helm \
      && rm -rf /tmp/linux-*; \
    fi

WORKDIR /opt/app-root/src
COPY --chown=1001:0 deploy/gateway/gateway.mjs deploy/gateway/plan.mjs ./
COPY --chown=1001:0 connector-relay/package.json ./relay/
COPY --chown=1001:0 connector-relay/src ./relay/src
COPY --from=mcp --chown=1001:0 /opt/app-root/src/package.json ./mcp/
COPY --from=mcp --chown=1001:0 /opt/app-root/src/node_modules ./mcp/node_modules
COPY --from=mcp --chown=1001:0 /opt/app-root/src/dist ./mcp/dist
# Politique et catalogue par défaut, ceux de cette version : le chart les copie
# pour OPA ; en production, ceux du dépôt de politiques (ConfigMap) les remplacent.
COPY --chown=1001:0 MCP/policies/ai_tools.rego ./mcp/policies/ai_tools.rego
COPY --chown=1001:0 MCP/policies/catalog ./mcp/policies/catalog

ENV NODE_ENV=production \
    HOME=/tmp \
    HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data \
    CATALOG_FILE=/opt/app-root/src/mcp/policies/catalog/data.json \
    GATEWAY_MCP_PORT=8443 \
    MGMT_PORT=9090 \
    RELAY_HEALTH_PORT=8080
USER 1001
# Aucun port MCP exposé : le serveur MCP écoute sur 127.0.0.1. 8080 : santé du
# relais ; 9090 : santé et métriques du serveur MCP.
EXPOSE 8080 9090
# Le lanceur est PID 1 : il relaie SIGTERM aux deux processus et attend leur fin.
CMD ["node", "gateway.mjs"]
