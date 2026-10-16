// founderos.yaml → valeurs Helm, Secrets, .env (G5). Fonctions pures : la ligne
// de commande (founderos-config.mjs) lit et écrit les fichiers.

import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";

export class ConfigError extends Error {
  constructor(issues) {
    super(`founderos.yaml :\n  - ${issues.join("\n  - ")}`);
    this.issues = issues;
  }
}

const URL_RE = /^https?:\/\/[A-Za-z0-9.:-]+(\/[A-Za-z0-9._~\/-]*)?$/;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

/** Valide et complète founderos.yaml. Toutes les erreurs d'un coup. */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const issues = [];
  const target = r.target ?? "kubernetes";
  if (!["kubernetes", "openshift", "vm"].includes(target)) issues.push("target : kubernetes, openshift ou vm.");
  const domain = r.domain ? String(r.domain).toLowerCase() : "";
  if (domain && !DOMAIN_RE.test(domain)) issues.push(`domain : « ${domain} » n'est pas un nom de domaine.`);
  const url = (key, prefix) => {
    const given = r.urls?.[key];
    const v = given ? String(given).replace(/\/+$/, "") : domain ? `https://${prefix}.${domain}` : "";
    if (!v) issues.push(`urls.${key} : à renseigner (ou domain, pour la déduire).`);
    else if (!URL_RE.test(v)) issues.push(`urls.${key} : « ${v} » n'est pas une URL http(s).`);
    return v;
  };
  const urls = { web: url("web", "founderos"), api: url("api", "founderos-api"), supabase: url("supabase", "founderos-sb") };

  const sb = r.supabase ?? {};
  const supabaseMode = sb.mode ?? "selfhosted";
  if (!["selfhosted", "provided"].includes(supabaseMode)) issues.push("supabase.mode : selfhosted ou provided.");
  const secretsSource = r.secrets?.source ?? "generate";
  if (!["generate", "vault", "existing"].includes(secretsSource)) issues.push("secrets.source : generate, vault ou existing.");
  if (supabaseMode === "provided" && secretsSource === "generate") {
    for (const k of ["anonKey", "serviceRoleKey", "databaseUrl"]) {
      if (!sb[k] && !process.env[`SUPABASE_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`]) {
        issues.push(`supabase.${k} : requis pour une instance fournie (ou dans l'environnement : SUPABASE_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}).`);
      }
    }
  }
  if (target === "vm" && secretsSource !== "generate") issues.push("target vm : secrets.source vaut generate (le .env porte les secrets de la machine).");
  if (secretsSource === "vault" && !r.secrets?.vault?.path) issues.push("secrets.vault.path : le chemin des secrets dans Vault (ex. secret/data/founderos).");

  const admins = [].concat(r.admins ?? []).map(String);
  for (const a of admins) if (!EMAIL_RE.test(a)) issues.push(`admins : « ${a} » n'est pas une adresse e-mail.`);
  if (!admins.length) issues.push("admins : au moins une adresse (les administrateurs de l'installation).");

  // Bornes de session de l'Auth (version allégée de G6) : un départ dans l'IdP prend effet en quelques heures.
  const DURATION_RE = /^\d+(h|m)$/;
  const sessions = { timebox: String(r.sessions?.timebox ?? "24h"), inactivity: String(r.sessions?.inactivity ?? "8h") };
  for (const [k, v] of Object.entries(sessions)) if (!DURATION_RE.test(v)) issues.push(`sessions.${k} : une durée comme 24h ou 90m.`);

  const ssoMode = r.sso?.mode ?? "dedicated";
  if (!["dedicated", "shared", "off"].includes(ssoMode)) issues.push("sso.mode : dedicated, shared ou off.");

  const llm = r.llm ?? {};
  const gateway = llm.gateway ?? "none";
  if (!["none", "litellm", "azure"].includes(gateway)) issues.push("llm.gateway : none, litellm ou azure.");
  if (gateway === "litellm" && !URL_RE.test(String(llm.litellm?.url ?? ""))) issues.push("llm.litellm.url : l'URL de LiteLLM (ex. http://litellm.ai-gateway.svc:4000/v1).");
  if (gateway === "azure" && (!URL_RE.test(String(llm.azure?.url ?? "")) || !llm.azure?.deployment)) issues.push("llm.azure.url et llm.azure.deployment : requis.");

  // Serveurs MCP des clusters (architecture Hub) : hôtes joints en direct, certificat client mTLS.
  const HOST_PATTERN_RE = /^(\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.(\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?))+$/;
  const mcpRaw = r.mcp ?? {};
  const internalHosts = [].concat(mcpRaw.internalHosts ?? []).map((h) => String(h).toLowerCase());
  for (const h of internalHosts) if (!HOST_PATTERN_RE.test(h)) issues.push(`mcp.internalHosts : « ${h} » n'est pas un motif d'hôte (ex. mcp.apps-int.*.interne.exemple).`);
  const clientCert = mcpRaw.clientCert ?? {};
  if (clientCert.issuer && clientCert.secretName) issues.push("mcp.clientCert : issuer (cert-manager le crée) ou secretName (Secret existant), pas les deux.");
  if ((clientCert.issuer || clientCert.secretName) && !internalHosts.length) issues.push("mcp.clientCert : sans mcp.internalHosts, le certificat ne serait présenté à aucun serveur.");
  if (target === "vm" && internalHosts.length) issues.push("mcp : réservé aux cibles kubernetes et openshift.");

  if (issues.length) throw new ConfigError(issues);
  return {
    target, domain, urls,
    supabase: {
      mode: supabaseMode, internalUrl: sb.internalUrl ? String(sb.internalUrl).replace(/\/+$/, "") : "",
      anonKey: sb.anonKey ?? process.env.SUPABASE_ANON_KEY ?? null,
      serviceRoleKey: sb.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
      jwtSecret: sb.jwtSecret ?? process.env.SUPABASE_JWT_SECRET ?? null,
      databaseUrl: sb.databaseUrl ?? process.env.SUPABASE_DATABASE_URL ?? null,
      dbHost: sb.dbHost ?? (target === "vm" ? "db" : "supabase-db"),
    },
    admins, ssoMode, sessions,
    llm: { gateway, litellm: llm.litellm ?? {}, azure: llm.azure ?? {} },
    secrets: { source: secretsSource, vault: r.secrets?.vault ?? {}, existing: { backend: r.secrets?.existing?.backend ?? "founderos-backend", supabase: r.secrets?.existing?.supabase ?? "founderos-supabase" } },
    images: { registry: r.images?.registry ?? "ghcr.io/founderos", tag: String(r.images?.tag ?? "0.1.0") },
    kubernetes: { ingressClass: r.kubernetes?.ingressClass ?? "", tlsSecret: r.kubernetes?.tlsSecret ?? "" },
    openshift: { routeLabels: r.openshift?.routeLabels ?? {} },
    vm: { tls: r.vm?.tls ?? "auto" },
    mcp: {
      internalHosts,
      clientCert: {
        issuer: clientCert.issuer ? String(clientCert.issuer) : "",
        issuerKind: String(clientCert.issuerKind ?? "ClusterIssuer"),
        secretName: clientCert.secretName ? String(clientCert.secretName) : clientCert.issuer ? "founderos-mcp-client" : "",
        commonName: String(clientCert.commonName ?? "founderos-ai-platform"),
        caConfigMap: clientCert.caConfigMap ? String(clientCert.caConfigMap) : "",
      },
    },
    migrationsBaseline: r.migrations?.baseline ? String(r.migrations.baseline) : "",
  };
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Une clé anon ou service_role d'un Supabase auto-hébergé : un JWT HS256 signé par JWT_SECRET. */
export function supabaseKey(jwtSecret, role, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 24 * 3600 }));
  const sig = b64url(createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/**
 * Les secrets de l'installation. Rien n'est régénéré qui existe déjà
 * (`previous`, l'état d'une exécution précédente) : relancer l'installateur ne
 * casse ni les jetons chiffrés ni les approbations signées.
 */
export function generateSecrets(cfg, previous = {}, { rotate = false } = {}) {
  const prev = rotate ? {} : previous;
  const keep = (k, make) => prev[k] ?? make();
  const s = {
    CREDENTIAL_ENCRYPTION_KEY: keep("CREDENTIAL_ENCRYPTION_KEY", () => randomBytes(32).toString("base64")),
    APPROVAL_SIGNING_KEY: keep("APPROVAL_SIGNING_KEY", () =>
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  };
  if (process.env.LLM_API_KEY) s.LLM_API_KEY = process.env.LLM_API_KEY;
  else if (prev.LLM_API_KEY) s.LLM_API_KEY = prev.LLM_API_KEY;
  if (cfg.supabase.mode === "selfhosted") {
    s.SUPABASE_JWT_SECRET = cfg.supabase.jwtSecret ?? keep("SUPABASE_JWT_SECRET", () => b64url(randomBytes(32)));
    s.POSTGRES_PASSWORD = keep("POSTGRES_PASSWORD", () => b64url(randomBytes(24)));
    const fresh = s.SUPABASE_JWT_SECRET !== prev.SUPABASE_JWT_SECRET;
    s.SUPABASE_ANON_KEY = cfg.supabase.anonKey ?? (!fresh && prev.SUPABASE_ANON_KEY ? prev.SUPABASE_ANON_KEY : supabaseKey(s.SUPABASE_JWT_SECRET, "anon"));
    s.SUPABASE_SERVICE_ROLE_KEY = cfg.supabase.serviceRoleKey ?? (!fresh && prev.SUPABASE_SERVICE_ROLE_KEY ? prev.SUPABASE_SERVICE_ROLE_KEY : supabaseKey(s.SUPABASE_JWT_SECRET, "service_role"));
    s.SUPABASE_DATABASE_URL = cfg.supabase.databaseUrl ?? `postgres://postgres:${s.POSTGRES_PASSWORD}@${cfg.supabase.dbHost}:5432/postgres`;
  } else {
    s.SUPABASE_ANON_KEY = cfg.supabase.anonKey;
    s.SUPABASE_SERVICE_ROLE_KEY = cfg.supabase.serviceRoleKey;
    s.SUPABASE_DATABASE_URL = cfg.supabase.databaseUrl;
    if (cfg.supabase.jwtSecret) s.SUPABASE_JWT_SECRET = cfg.supabase.jwtSecret;
  }
  return s;
}

/** Variables non secrètes du backend, réglées par founderos.yaml (verrouillées à l'écran Installation). */
function llmEnv(cfg) {
  const { gateway, litellm, azure } = cfg.llm;
  if (gateway === "litellm") {
    return {
      LLM_UPSTREAM: "litellm", LLM_BASE_URL: String(litellm.url).replace(/\/+$/, ""),
      ...(litellm.model ? { LLM_MODEL_DEFAULT: String(litellm.model) } : {}),
      ...(litellm.heavyModel ? { LLM_MODEL_HEAVY: String(litellm.heavyModel) } : {}),
      ...(litellm.embeddingModel ? { LLM_EMBEDDING_MODEL: String(litellm.embeddingModel) } : {}),
    };
  }
  if (gateway === "azure") {
    return {
      LLM_UPSTREAM: "azure", AZURE_OPENAI_BASE_URL: String(azure.url).replace(/\/+$/, ""), AZURE_OPENAI_DEPLOYMENT: String(azure.deployment),
      ...(azure.heavyDeployment ? { AZURE_OPENAI_DEPLOYMENT_HEAVY: String(azure.heavyDeployment) } : {}),
      ...(azure.embeddingDeployment ? { AZURE_OPENAI_EMBEDDING_DEPLOYMENT: String(azure.embeddingDeployment) } : {}),
      ...(azure.tenantId ? { AZURE_OPENAI_TENANT_ID: String(azure.tenantId) } : {}),
      ...(azure.clientId ? { AZURE_OPENAI_CLIENT_ID: String(azure.clientId) } : {}),
    };
  }
  return {};
}

function mcpValues({ internalHosts, clientCert: c }) {
  return {
    internalHosts,
    clientCert: {
      secretName: c.secretName, caConfigMap: c.caConfigMap,
      certManager: { enabled: !!c.issuer, ...(c.issuer ? { issuerKind: c.issuerKind, issuerName: c.issuer, commonName: c.commonName } : {}) },
    },
  };
}

/** Les valeurs du chart deploy/helm/founderos (aucun secret). */
export function helmValues(cfg) {
  return {
    platform: cfg.target,
    images: { registry: cfg.images.registry, tag: cfg.images.tag },
    supabase: { url: cfg.urls.supabase, internalUrl: cfg.supabase.internalUrl, existingSecret: cfg.secrets.existing.supabase },
    backend: {
      publicUrl: cfg.urls.api, existingSecret: cfg.secrets.existing.backend,
      installationAdmins: cfg.admins.join(","), ssoMode: cfg.ssoMode, env: llmEnv(cfg),
    },
    web: { publicUrl: cfg.urls.web },
    migrations: { enabled: true, baseline: cfg.migrationsBaseline },
    ...(cfg.target === "kubernetes" ? { ingress: { className: cfg.kubernetes.ingressClass, tlsSecretName: cfg.kubernetes.tlsSecret } } : {}),
    ...(cfg.target === "openshift" ? { route: { labels: cfg.openshift.routeLabels } } : {}),
    ...(cfg.mcp.internalHosts.length ? { mcp: mcpValues(cfg.mcp) } : {}),
  };
}

const BACKEND_KEYS = ["CREDENTIAL_ENCRYPTION_KEY", "APPROVAL_SIGNING_KEY", "LLM_API_KEY"];

/** Les Secrets attendus par le chart, quand l'installateur les génère. */
export function k8sSecrets(cfg, s) {
  const backend = Object.fromEntries(BACKEND_KEYS.filter((k) => s[k]).map((k) => [k, s[k]]));
  const supabase = {
    anonKey: s.SUPABASE_ANON_KEY, serviceRoleKey: s.SUPABASE_SERVICE_ROLE_KEY, databaseUrl: s.SUPABASE_DATABASE_URL,
    ...(s.SUPABASE_JWT_SECRET ? { jwtSecret: s.SUPABASE_JWT_SECRET } : {}),
  };
  const secret = (name, stringData) => ({ apiVersion: "v1", kind: "Secret", metadata: { name, labels: { "app.kubernetes.io/part-of": "founderos" } }, type: "Opaque", stringData });
  return [secret(cfg.secrets.existing.backend, backend), secret(cfg.secrets.existing.supabase, supabase)];
}

/** Secrets dans Vault : des ExternalSecret (External Secrets Operator) qui les recopient. */
export function externalSecrets(cfg) {
  const store = cfg.secrets.vault.store ?? "vault";
  const path = String(cfg.secrets.vault.path);
  const es = (name, keys) => ({
    apiVersion: "external-secrets.io/v1beta1", kind: "ExternalSecret",
    metadata: { name, labels: { "app.kubernetes.io/part-of": "founderos" } },
    spec: {
      refreshInterval: "1h", secretStoreRef: { kind: "ClusterSecretStore", name: store }, target: { name },
      data: keys.map(([secretKey, property]) => ({ secretKey, remoteRef: { key: path, property } })),
    },
  });
  return [
    es(cfg.secrets.existing.backend, BACKEND_KEYS.map((k) => [k, k])),
    es(cfg.secrets.existing.supabase, [["anonKey", "SUPABASE_ANON_KEY"], ["serviceRoleKey", "SUPABASE_SERVICE_ROLE_KEY"], ["databaseUrl", "SUPABASE_DATABASE_URL"], ["jwtSecret", "SUPABASE_JWT_SECRET"]]),
  ];
}

const envLine = (k, v) => {
  const s = String(v ?? "");
  // Les clés PEM tiennent sur plusieurs lignes : guillemets et \n échappés, comme le lit docker compose.
  return /[\s"'#$\\]/.test(s) ? `${k}="${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\$/g, "$$$$")}"` : `${k}=${s}`;
};

/** Le .env du docker-compose de la machine virtuelle. */
export function composeEnv(cfg, s) {
  const host = (u) => new URL(u).host;
  const lines = [
    "# Généré par deploy/installer/founderos-config.mjs : contient des secrets, ne pas versionner.",
    envLine("FOUNDEROS_REGISTRY", cfg.images.registry), envLine("FOUNDEROS_TAG", cfg.images.tag),
    envLine("FOUNDEROS_WEB_URL", cfg.urls.web), envLine("FOUNDEROS_API_URL", cfg.urls.api),
    envLine("FOUNDEROS_WEB_HOST", host(cfg.urls.web)), envLine("FOUNDEROS_API_HOST", host(cfg.urls.api)),
    envLine("CADDY_TLS", cfg.vm.tls),
    envLine("SUPABASE_URL", cfg.urls.supabase),
    ...(cfg.supabase.internalUrl ? [envLine("SUPABASE_INTERNAL_URL", cfg.supabase.internalUrl)] : []),
    envLine("SUPABASE_ANON_KEY", s.SUPABASE_ANON_KEY), envLine("SUPABASE_SERVICE_ROLE_KEY", s.SUPABASE_SERVICE_ROLE_KEY),
    ...(s.SUPABASE_JWT_SECRET ? [envLine("SUPABASE_JWT_SECRET", s.SUPABASE_JWT_SECRET)] : []),
    envLine("DATABASE_URL", s.SUPABASE_DATABASE_URL),
    envLine("INSTALLATION_ADMINS", cfg.admins.join(",")), envLine("SSO_MODE", cfg.ssoMode),
    ...BACKEND_KEYS.filter((k) => s[k]).map((k) => envLine(k, s[k])),
    ...Object.entries(llmEnv(cfg)).map(([k, v]) => envLine(k, v)),
  ];
  return `${lines.join("\n")}\n`;
}

/** Les variables du docker compose officiel de Supabase (supabase/docker/.env), pour un Supabase auto-hébergé. */
export function supabaseEnv(cfg, s) {
  return `${[
    "# À reporter dans le .env du docker compose officiel de Supabase (supabase/docker).",
    envLine("POSTGRES_PASSWORD", s.POSTGRES_PASSWORD), envLine("JWT_SECRET", s.SUPABASE_JWT_SECRET),
    envLine("ANON_KEY", s.SUPABASE_ANON_KEY), envLine("SERVICE_ROLE_KEY", s.SUPABASE_SERVICE_ROLE_KEY),
    envLine("SITE_URL", cfg.urls.web), envLine("API_EXTERNAL_URL", cfg.urls.supabase), envLine("SUPABASE_PUBLIC_URL", cfg.urls.supabase),
    envLine("ADDITIONAL_REDIRECT_URLS", `${cfg.urls.web}/**`),
    "# Bornes de session (départs) : à passer au service auth du compose (GOTRUE_*), ou au chart.",
    envLine("GOTRUE_SESSIONS_TIMEBOX", cfg.sessions.timebox), envLine("GOTRUE_SESSIONS_INACTIVITY_TIMEOUT", cfg.sessions.inactivity),
  ].join("\n")}\n`;
}
