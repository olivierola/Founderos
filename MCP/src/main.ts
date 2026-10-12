// Point d'entrée : un processus = un serveur MCP sur un cluster.
//
//   MCP_SERVER            observability | fleet | openshift | argocd | git | prtg, ou plusieurs
//                         séparés par des virgules : un serveur par cluster (openshift,argocd),
//                         configuration { "openshift": {…}, "argocd": {…} }, audience mcp-<cluster>
//   MCP_CLUSTER           hub | ips | sdb | npr | prd
//   MCP_CONFIG_FILE       configuration JSON du serveur (ConfigMap), défaut /etc/mcp/config.json
//   MCP_AUDIENCE          audience attendue dans le jeton d'appel (client Keycloak du serveur),
//                         défaut mcp-<outil>-<cluster> (un module) ou mcp-<cluster> (plusieurs)
//   AUTH_MODE             rotating (défaut si MCP_TOKEN_SEED_FILE), token (défaut si MCP_TOKENS_FILE) ou oidc
//   MCP_TOKEN_SEED_FILE   rotating : la graine du jeton tournant (Secret monté) — npm run token -- seed
//   MCP_TOKEN_PERIOD      rotating : durée d'un jeton (défaut 24h ; 10m au moins)
//   MCP_TOKEN_ROLES       rotating : rôles du jeton, séparés par des virgules (défaut ai-ops-reader)
//   MCP_TOKEN_SCOPES      rotating : scopes ; vide : ceux que le catalogue accorde aux rôles
//   MCP_FOUNDEROS_URL     rotating : où livrer chaque nouveau jeton (FounderOS : backend, ou https://<projet>.supabase.co)
//   MCP_FOUNDEROS_CA_FILE rotating : AC de FounderOS, si elle n'est pas dans celles du système
//   MCP_TOKENS_FILE       empreintes des jetons d'API (Secret monté), relues à chaud — npm run token -- generate ;
//                         en mode rotating, ces jetons restent acceptés en plus du jeton tournant
//   IDP_ISSUER            issuer de l'IdP qui émet les jetons d'appel (alias historique : KEYCLOAK_ISSUER),
//                         ex. https://keycloak…/realms/platform ou https://login.microsoftonline.com/<tenant>/v2.0
//   IDP_JWKS_URL          JWKS de l'IdP (alias : KEYCLOAK_JWKS_URL) ; requis hors Keycloak,
//                         ex. https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys
//   CALL_TOKEN_MAX_LIFETIME  durée de vie maximale d'un jeton d'appel, en secondes (défaut 360 ;
//                         Entra ID sans politique de durée de vie : 5460)
//   ALLOWED_AGENTS        agents (azp) acceptés, séparés par des virgules
//   APPROVAL_ISSUER, APPROVAL_JWKS_URL   jetons d'approbation signés par FounderOS ;
//   APPROVAL_JWKS_FILE    à la place de l'URL : le JWKS dans une ConfigMap (cluster qui ne joint pas FounderOS)
//   APPROVAL_AUDIENCE     audience des jetons d'approbation, si elle diffère de MCP_AUDIENCE (Entra ID :
//                         FounderOS signe pour api://…, le jeton d'appel porte l'ID d'application)
//   OPA_URL               ex. http://opa.ai-mcp.svc:8181 ; POLICY_ENGINE=builtin pour s'en passer (dev)
//   VAULT_ADDR, VAULT_ROLE, VAULT_AUTH_MOUNT, VAULT_KV_MOUNT, VAULT_K8S_SECRETS_MOUNT, VAULT_CACERT,
//   VAULT_JWT_FILE (jeton projeté d'audience « vault »)
//   CATALOG_FILE          catalogue des tools, le même que celui d'OPA
//   TLS_CERT_FILE, TLS_KEY_FILE, TLS_CLIENT_CA_FILE, MTLS_ALLOWED_CN   (mTLS)
//   MCP_INSECURE_HTTP=1   HTTP en clair, poste local uniquement
//   MCP_PORT (8443), MGMT_PORT (9090), MAX_RESULT_BYTES (65536)
//   MCP_HOST (0.0.0.0)    127.0.0.1 dans la passerelle d'entreprise (G7) : seul le relais du pod le joint
//   MGMT_HOST             hôte du port de gestion (défaut : MCP_HOST)

import { readFileSync } from "node:fs";
import { createRemoteJWKSet } from "jose";
import { createApprovalVerifier } from "./lib/approval.ts";
import { createAccessTokenVerifier, type AccessTokenVerifier } from "./lib/auth.ts";
import { createApiTokenVerifier } from "./lib/api-tokens.ts";
import { Metrics } from "./lib/metrics.ts";
import { composeTokenVerifiers, createRotatingTokenVerifier, parseDuration, readSeedFile, TokenPusher } from "./lib/rotating-token.ts";
import { CLUSTERS, loadCatalog, type Cluster } from "./lib/catalog.ts";
import { BuiltinPolicyEngine, OpaPolicyEngine, type PolicyEngine } from "./lib/policy.ts";
import { LocalSecretResolver, VaultSecretResolver, type SecretResolver } from "./lib/secrets.ts";
import { startServer } from "./lib/server.ts";
import { resolveServerModule } from "./servers/index.ts";

const env = (k: string) => process.env[k]?.trim() || undefined;
function required(k: string): string {
  const v = env(k);
  if (!v) throw new Error(`Variable d'environnement manquante : ${k}`);
  return v;
}

async function main() {
  const module = resolveServerModule(required("MCP_SERVER"));
  const cluster = required("MCP_CLUSTER") as Cluster;
  if (!CLUSTERS.includes(cluster)) throw new Error(`MCP_CLUSTER inconnu : ${cluster}`);

  const config = module.configSchema.parse(JSON.parse(readFileSync(env("MCP_CONFIG_FILE") ?? "/etc/mcp/config.json", "utf8")));
  const catalog = loadCatalog();
  const audience = env("MCP_AUDIENCE") ?? `${module.name}-${cluster}`;
  // Authentification : jeton d'API tournant, livré par le serveur lui-même à
  // FounderOS (défaut dès qu'une graine est fournie) ; jetons d'API d'un
  // fichier ; ou jetons émis par un IdP (échange de jeton, On-Behalf-Of).
  const authMode = env("AUTH_MODE") ?? (env("MCP_TOKEN_SEED_FILE") ? "rotating" : env("MCP_TOKENS_FILE") ? "token" : "oidc");
  if (!["rotating", "token", "oidc"].includes(authMode)) throw new Error(`AUTH_MODE inconnu : ${authMode} (rotating, token ou oidc)`);
  const metrics = new Metrics();
  let pusher: TokenPusher | null = null;
  let verifyToken: AccessTokenVerifier;
  if (authMode === "rotating") {
    const seed = readSeedFile(required("MCP_TOKEN_SEED_FILE"));
    const periodMs = parseDuration(env("MCP_TOKEN_PERIOD") ?? "24h");
    if (periodMs < 10 * 60_000) throw new Error("MCP_TOKEN_PERIOD : 10m au moins (FounderOS doit recevoir chaque jeton avant la fin de la période suivante)");
    const roles = (env("MCP_TOKEN_ROLES") ?? "ai-ops-reader").split(",").map((s) => s.trim()).filter(Boolean);
    for (const r of roles) if (!(r in catalog.role_scopes)) throw new Error(`MCP_TOKEN_ROLES : rôle inconnu du catalogue : ${r}`);
    const scopes = env("MCP_TOKEN_SCOPES")?.split(",").map((s) => s.trim()).filter(Boolean)
      ?? [...new Set(roles.flatMap((r) => catalog.role_scopes[r] ?? []))];
    const rotating = createRotatingTokenVerifier({ seed, periodMs, roles, scopes });
    verifyToken = composeTokenVerifiers(rotating, env("MCP_TOKENS_FILE") ? createApiTokenVerifier({ file: env("MCP_TOKENS_FILE") }) : undefined);
    pusher = new TokenPusher({
      seed, periodMs, metrics,
      founderosUrl: required("MCP_FOUNDEROS_URL"),
      caFile: env("MCP_FOUNDEROS_CA_FILE"),
    });
  } else if (authMode === "token") {
    verifyToken = createApiTokenVerifier({ file: required("MCP_TOKENS_FILE") });
  } else {
    const issuer = env("IDP_ISSUER") ?? required("KEYCLOAK_ISSUER");
    const jwksUrl = env("IDP_JWKS_URL") ?? env("KEYCLOAK_JWKS_URL");
    const maxLifetime = env("CALL_TOKEN_MAX_LIFETIME") ? Number(env("CALL_TOKEN_MAX_LIFETIME")) : undefined;
    if (maxLifetime !== undefined && !(maxLifetime > 0)) throw new Error("CALL_TOKEN_MAX_LIFETIME doit être un nombre de secondes positif");
    verifyToken = createAccessTokenVerifier({
      issuer,
      audience,
      ...(jwksUrl ? { jwks: createRemoteJWKSet(new URL(jwksUrl)) } : {}),
      allowedAgents: env("ALLOWED_AGENTS")?.split(",").map((s) => s.trim()).filter(Boolean),
      ...(maxLifetime ? { maxLifetimeSeconds: maxLifetime } : {}),
    });
  }

  const verifyApproval = env("APPROVAL_JWKS_FILE") || env("APPROVAL_JWKS_URL")
    ? createApprovalVerifier({
        issuer: required("APPROVAL_ISSUER"), audience: env("APPROVAL_AUDIENCE") ?? audience,
        jwksFile: env("APPROVAL_JWKS_FILE"), jwksUrl: env("APPROVAL_JWKS_URL"),
      })
    : undefined;

  let policy: PolicyEngine;
  if (env("POLICY_ENGINE") === "builtin") {
    console.warn(JSON.stringify({ level: "warn", msg: "POLICY_ENGINE=builtin : décision locale, sans OPA (développement uniquement)" }));
    policy = new BuiltinPolicyEngine(catalog);
  } else {
    policy = new OpaPolicyEngine(required("OPA_URL"));
  }

  const secrets: SecretResolver = env("VAULT_ADDR")
    ? new VaultSecretResolver({
        addr: env("VAULT_ADDR")!,
        role: env("VAULT_ROLE") ?? module.name,
        authMount: env("VAULT_AUTH_MOUNT"),
        kvMount: env("VAULT_KV_MOUNT"),
        k8sSecretsMount: env("VAULT_K8S_SECRETS_MOUNT"),
        caFile: env("VAULT_CACERT"),
        namespace: env("VAULT_NAMESPACE"),
        jwtFile: env("VAULT_JWT_FILE"),
      })
    : new LocalSecretResolver();

  const tls = env("TLS_CERT_FILE")
    ? {
        certFile: required("TLS_CERT_FILE"),
        keyFile: required("TLS_KEY_FILE"),
        clientCaFile: required("TLS_CLIENT_CA_FILE"),
        allowedClientCNs: env("MTLS_ALLOWED_CN")?.split(",").map((s) => s.trim()).filter(Boolean),
      }
    : undefined;

  const running = await startServer({
    module,
    config,
    cluster,
    catalog,
    policy,
    verifyToken,
    verifyApproval,
    secrets,
    mcpPort: Number(env("MCP_PORT") ?? 8443),
    mgmtPort: Number(env("MGMT_PORT") ?? 9090),
    tls,
    insecureHttp: env("MCP_INSECURE_HTTP") === "1",
    maxResultBytes: Number(env("MAX_RESULT_BYTES") ?? 65536),
    host: env("MCP_HOST") ?? "0.0.0.0",
    mgmtHost: env("MGMT_HOST") ?? env("MCP_HOST") ?? "0.0.0.0",
    metrics,
  });
  pusher?.start();

  console.log(JSON.stringify({
    ts: new Date().toISOString(), level: "info", msg: "serveur MCP prêt",
    server: module.name, cluster, audience, auth: authMode, tools: running.tools, tls: !!tls,
    ...(pusher ? { token_id: pusher.tokenId } : {}),
  }));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      pusher?.stop();
      void running.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", msg: String(err?.message ?? err) }));
  process.exit(1);
});
