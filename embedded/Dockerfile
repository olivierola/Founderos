# founderos/agent-runtime : le moteur des agents embarqués (docs/harness-opencode/05).
#
# Le harnais OpenCode et les plugins FounderOS (backend/src/harness), le SDK et
# le programme du conteneur (backend/src/embedded). Chaque agent embarqué part de
# cette image et y ajoute son manifeste, ses paquets et ses fichiers d'amorce.
#
#   docker build -f embedded/Dockerfile -t founderos/agent-runtime:1 .
#
# À construire depuis la racine du dépôt. Aucun secret dans l'image.

FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 python3-pip python3-venv procps \
 && rm -rf /var/lib/apt/lists/*

# L'agent travaille sous son propre utilisateur, dans /workspace ; l'état de ses sessions est dans /data.
RUN useradd -m -u 10001 -s /bin/bash agent \
 && mkdir -p /app/backend /data /workspace \
 && chown -R agent:agent /data /workspace

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY backend/tsconfig.json ./
COPY backend/src ./src

USER agent
ENV NODE_ENV=production DATA_DIR=/data WORKSPACE_DIR=/workspace MANIFEST=/app/manifest.json
# tsx se résout depuis /app/backend ; les sessions de l'agent travaillent dans /workspace.
CMD ["node", "--import", "tsx", "src/embedded/start.ts"]
