# Image de l'interface FounderOS (D9, rendue générique par G5).
#
# Une seule image pour toutes les installations : les adresses se donnent au
# DÉMARRAGE, par l'environnement du conteneur (deploy/spa/entrypoint.sh) :
#   FOUNDEROS_SUPABASE_URL, FOUNDEROS_SUPABASE_ANON_KEY, FOUNDEROS_API_URL
#
#   docker build -f deploy/spa/Dockerfile -t <registre>/founderos/web:<tag> .
#
# Les arguments VITE_* restent acceptés : ils deviennent les valeurs par défaut.
#
# Images UBI : utilisateur non root, compatible avec les UID arbitraires des
# SCC restricted-v2 d'OpenShift. Port 8080.

FROM registry.access.redhat.com/ubi9/nodejs-22 AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY --chown=1001:0 . .
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_API_URL=""
RUN npm run build

FROM registry.access.redhat.com/ubi9/nginx-124
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_API_URL=""
ENV FOUNDEROS_SUPABASE_URL=${VITE_SUPABASE_URL} \
    FOUNDEROS_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY} \
    FOUNDEROS_API_URL=${VITE_API_URL}
# Contenu servi par le serveur par défaut de l'image (port 8080, racine /opt/app-root/src).
COPY --from=build /opt/app-root/src/dist /opt/app-root/src
# Règles ajoutées DANS ce serveur (repli SPA, cache des assets, en-têtes de
# sécurité) : un modèle, rendu au démarrage avec les adresses de l'installation.
COPY deploy/spa/spa.conf /opt/app-root/etc/spa.conf.template
COPY deploy/spa/entrypoint.sh /usr/local/bin/founderos-web-entrypoint
USER 0
# L'UID est arbitraire sur OpenShift, mais toujours du groupe 0 : le groupe
# écrit config.js et la configuration rendue.
RUN chmod 0755 /usr/local/bin/founderos-web-entrypoint \
 && chgrp -R 0 /opt/app-root/src /opt/app-root/etc/nginx.default.d \
 && chmod -R g+rwX /opt/app-root/src /opt/app-root/etc/nginx.default.d
USER 1001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/founderos-web-entrypoint"]
