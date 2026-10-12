#!/bin/sh
# Démarrage de l'image de l'interface (G5) : une seule image pour toutes les
# installations. Les adresses viennent de l'environnement du conteneur :
#
#   FOUNDEROS_SUPABASE_URL       l'API Supabase de l'installation (https://…)
#   FOUNDEROS_SUPABASE_ANON_KEY  sa clé anon (publique par nature)
#   FOUNDEROS_API_URL            le backend Express (https://…)
#
# Elles sont écrites dans /config.js (lu par src/lib/runtime-config.ts) et dans
# la politique de contenu de nginx. Défaut : les valeurs données à la
# construction (VITE_*), s'il y en a eu.
set -eu

SUPABASE_URL="${FOUNDEROS_SUPABASE_URL:-}"
ANON_KEY="${FOUNDEROS_SUPABASE_ANON_KEY:-}"
API_URL="${FOUNDEROS_API_URL:-}"

fail() { echo "entrypoint : $*" >&2; exit 1; }

[ -n "$SUPABASE_URL" ] || fail "FOUNDEROS_SUPABASE_URL est requis."
[ -n "$ANON_KEY" ] || fail "FOUNDEROS_SUPABASE_ANON_KEY est requis."
# Les valeurs vont dans du JavaScript et dans un en-tête : rien d'autre que ce
# qu'une URL ou un JWT contient.
echo "$SUPABASE_URL" | grep -Eq '^https?://[A-Za-z0-9.:/_-]+$' || fail "FOUNDEROS_SUPABASE_URL : une URL http(s) attendue."
echo "$ANON_KEY" | grep -Eq '^[A-Za-z0-9._-]+$' || fail "FOUNDEROS_SUPABASE_ANON_KEY : un JWT attendu."
[ -z "$API_URL" ] || echo "$API_URL" | grep -Eq '^https?://[A-Za-z0-9.:/_-]+$' || fail "FOUNDEROS_API_URL : une URL http(s) attendue."

# Chemins de l'image ; réglables pour les tests.
ROOT="${FOUNDEROS_WEB_ROOT:-/opt/app-root/src}"
ETC="${FOUNDEROS_WEB_ETC:-/opt/app-root/etc}"
cat > "$ROOT/config.js" <<EOF
// Écrit au démarrage du conteneur (deploy/spa/entrypoint.sh).
window.__FOUNDEROS__ = { supabaseUrl: "$SUPABASE_URL", supabaseAnonKey: "$ANON_KEY", apiUrl: "$API_URL" };
EOF

WS_URL=$(printf '%s' "$SUPABASE_URL" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#')
sed -e "s#__SUPABASE_URL__#${SUPABASE_URL}#g" -e "s#__SUPABASE_WS__#${WS_URL}#g" -e "s#__API_URL__#${API_URL}#g" \
  "$ETC/spa.conf.template" > "$ETC/nginx.default.d/spa.conf"

[ "${FOUNDEROS_WEB_DRY_RUN:-}" = "1" ] && exit 0
exec nginx -g "daemon off;"
