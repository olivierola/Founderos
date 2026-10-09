# FounderOS — relais d'outils internes.
#
#   docker build -t founderos/connector-relay .
#   docker build --build-arg WITH_K8S_TOOLS=true -t founderos/connector-relay:k8s .   # + helm et kubectl
#
# Image sans dépendance npm. Utilisateur non root, système de fichiers en
# lecture seule possible (rien n'est écrit hors de /tmp).
FROM node:20-alpine

ARG WITH_K8S_TOOLS=false
ARG HELM_VERSION=v3.15.4
ARG KUBECTL_VERSION=v1.30.4
ARG TARGETARCH=amd64

RUN apk add --no-cache ca-certificates tini \
 && if [ "$WITH_K8S_TOOLS" = "true" ]; then \
      apk add --no-cache curl \
      && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" | tar -xz -C /tmp \
      && mv "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
      && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
      && chmod +x /usr/local/bin/kubectl /usr/local/bin/helm \
      && rm -rf /tmp/linux-* \
      && apk del curl; \
    fi

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOME=/tmp \
    HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
