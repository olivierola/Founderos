# La machine partagée des équipes d'agents.
#
#   docker compose -f team-machine/compose.yaml up -d --build
#   docker exec team-machine node /opt/team-machine/src/selftest.mjs   # l'isolement, vérifié
#
# Un seul processus privilégié : le superviseur (root). Chaque agent est un
# utilisateur Linux sans privilège ; tout ce qu'il lance passe par setpriv.
FROM node:22-bookworm-slim

# Une vraie machine de travail : shell, git, compilateurs, Python, réseau.
# util-linux fournit setpriv ; passwd fournit useradd/groupadd ; tini récolte
# les processus orphelins des agents (node en PID 1 ne le fait pas).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git openssh-client jq unzip zip xz-utils file tree less nano \
      build-essential pkg-config python3 python3-pip python3-venv python3-dev \
      ripgrep sqlite3 procps psmisc iproute2 iputils-ping dnsutils \
      util-linux passwd tini \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

# Le navigateur des agents : Playwright et son Chromium sans écran, avec
# leurs bibliothèques et des polices. Lisibles par tous (chaque agent lance
# le sien sous son propre uid, voir src/browser.mjs).
WORKDIR /opt/team-machine
COPY package.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache \
 && chmod -R a+rX /opt/ms-playwright /opt/team-machine/node_modules

# Aucun binaire setuid/setgid : no_new_privs les neutralise déjà pour les
# agents, on les désarme en plus (su, passwd, mount… ne rendent plus root).
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

COPY src ./src
# Lisible par les agents (fsop.mjs tourne sous leur identité) ; rien de secret ici.
RUN chmod -R a+rX,go-w /opt/team-machine

ENV MACHINE_ROOT=/teams \
    MACHINE_STATE=/var/lib/team-machine \
    MACHINE_PORT=8080

VOLUME ["/teams", "/var/lib/team-machine"]
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/team-machine/src/server.mjs"]
