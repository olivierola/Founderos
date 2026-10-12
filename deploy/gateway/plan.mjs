// La passerelle d'entreprise (G7) : ce que le lanceur démarre, et avec quoi.
// Fonction pure : gateway.mjs l'exécute, les tests la vérifient.
//
// Deux processus dans le même conteneur :
//   - le serveur MCP, sur la BOUCLE LOCALE seulement (127.0.0.1) : aucun Service,
//     aucune Route, aucun autre pod ne le joint ; seul le relais voisin y accède ;
//   - le relais, seul chemin sortant vers FounderOS, autorisé vers ce port local
//     en plus des outils de sa liste blanche.
// Chacun ne reçoit que ses propres secrets : le serveur MCP ne voit pas le jeton
// du relais, le relais ne voit ni Vault ni les jetons des serveurs MCP.

const RELAY_ONLY = /^(RELAY_|FOUNDEROS_URL$)/;
const MCP_ONLY = /^(MCP_|MGMT_|VAULT_|OPA_|IDP_|KEYCLOAK_|APPROVAL_|AUTH_MODE$|CATALOG_FILE$|POLICY_ENGINE$|ALLOWED_AGENTS$|CALL_TOKEN_MAX_LIFETIME$|MAX_RESULT_BYTES$|TLS_|MTLS_)/;

function without(env, re) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !re.test(k)));
}

export function gatewayPlan(env, paths = { mcpMain: "/app/mcp/dist/main.js", relayMain: "/app/relay/src/index.js" }) {
  const issues = [];
  if (!env.FOUNDEROS_URL) issues.push("FOUNDEROS_URL : l'adresse de FounderOS (https://<projet>.supabase.co, ou le backend).");
  if (!env.RELAY_TOKEN) issues.push("RELAY_TOKEN : le jeton du relais, créé dans FounderOS (Ressources → Outils internes → Relais).");
  const servers = String(env.GATEWAY_MCP_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const port = Number(env.GATEWAY_MCP_PORT ?? 8443);
  if (!(port > 0 && port < 65536)) issues.push("GATEWAY_MCP_PORT : un port.");
  if (servers.length && !env.MCP_CLUSTER) issues.push("MCP_CLUSTER : le cluster que servent les serveurs MCP de la passerelle (hub, ips, sdb, npr, prd).");
  // Jeton tournant (défaut dès qu'une graine est donnée), jetons fixes d'un fichier, ou IdP.
  const authMode = env.AUTH_MODE ?? (env.MCP_TOKEN_SEED_FILE ? "rotating" : env.MCP_TOKENS_FILE ? "token" : "");
  if (servers.length && !["rotating", "token", "oidc"].includes(authMode)) {
    issues.push("MCP_TOKEN_SEED_FILE : la graine du jeton tournant (npm run token -- seed) ; ou MCP_TOKENS_FILE (jetons fixes), ou AUTH_MODE=oidc.");
  }
  if (servers.length && authMode === "rotating" && !env.MCP_TOKEN_SEED_FILE) issues.push("MCP_TOKEN_SEED_FILE : la graine du jeton tournant (npm run token -- seed).");

  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const allowed = String(env.RELAY_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const relayEnv = {
    ...without(env, MCP_ONLY),
    RELAY_ALLOWED_HOSTS: [...allowed, ...(servers.length ? [`127.0.0.1:${port}`] : [])].join(","),
  };
  const mcp = servers.length
    ? {
        cmd: process.execPath, args: [paths.mcpMain],
        env: {
          ...without(without(env, RELAY_ONLY), /^TLS_|^MTLS_/),
          MCP_SERVER: servers.join(","),
          ...(authMode ? { AUTH_MODE: authMode } : {}),
          // Le serveur livre chaque nouveau jeton à FounderOS, à la même adresse que le relais.
          ...(authMode === "rotating" ? { MCP_FOUNDEROS_URL: env.MCP_FOUNDEROS_URL ?? env.FOUNDEROS_URL } : {}),
          // Le trafic ne quitte jamais le pod : la boucle locale, sans TLS. Le jeton
          // d'API, OPA, le catalogue et les approbations s'appliquent comme ailleurs.
          MCP_HOST: "127.0.0.1",
          MCP_PORT: String(port),
          MCP_INSECURE_HTTP: "1",
          // /metrics reste joignable par le ServiceMonitor, jamais le port MCP.
          MGMT_HOST: env.MGMT_HOST ?? "0.0.0.0",
          MGMT_PORT: env.MGMT_PORT ?? "9090",
        },
      }
    : null;
  return { issues, mcp, relay: { cmd: process.execPath, args: [paths.relayMain], env: relayEnv }, mcpUrl, servers };
}
