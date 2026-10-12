// Outils internes : le modèle d'un connecteur personnalisé.
//
// Ce fichier est PUR (aucun import, aucune API Deno ou navigateur) : il est lu
// tel quel par les fonctions edge ET par le front
// (src/features/custom-connectors), pour qu'une opération se valide de la même
// façon dans l'éditeur, dans l'assistant et au moment de l'exécution. Ne pas y
// ajouter d'import.
//
// Un connecteur, c'est :
//   · une URL de base, joignable en direct (outil exposé) ou via le relais
//     déployé chez le client (URL interne) ;
//   · un schéma d'authentification, dont les paramètres non secrets vivent ici
//     et les secrets dans custom_connector_credentials ;
//   · une liste d'OPÉRATIONS déclarées : le collaborateur choisit une opération
//     et ses paramètres, jamais une URL libre (sauf requête brute autorisée et
//     bornée par la politique) ;
//   · une politique : approbations, lecture seule, rédaction des réponses,
//     débit, chemins autorisés.

export type Transport = "direct" | "relay";
export type Risk = "read" | "write" | "destructive";
export type OutputMode = "full" | "redact" | "keys_only";
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AuthScheme =
  | "none"
  | "bearer"
  | "api_key"
  | "basic"
  | "headers"
  | "oauth2_client_credentials"
  | "oauth2_authorization_code"
  | "session_login"
  | "mtls";

export interface OpParam {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
  enum?: string[];
  /** Expression régulière que la valeur doit respecter entièrement. */
  pattern?: string;
  default?: string | number | boolean;
  /** Paramètre de chemin qui peut contenir des « / » (chemin Vault…). */
  allow_slash?: boolean;
}

export interface ConnectorOperation {
  name: string;
  description: string;
  /** http (défaut) ou exec : une commande sur le relais (helm, kubectl…). */
  kind?: "http" | "exec";
  method?: HttpMethod;
  /** Chemin relatif à l'URL de base, avec des {param}. */
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Corps JSON. Une chaîne qui vaut exactement "{p}" reçoit la valeur typée. */
  body?: unknown;
  /** Type de contenu du corps (défaut application/json). */
  content_type?: string;
  binary?: string;
  args?: string[];
  params?: OpParam[];
  risk: Risk;
  output?: OutputMode;
  timeout_ms?: number;
}

export interface ConnectorPolicy {
  /** writes : écritures et destructions approuvées ; all : tout ; destructive_only. */
  approval: "writes" | "all" | "destructive_only";
  read_only: boolean;
  /** Requête brute (méthode + chemin choisis par le collaborateur). */
  allow_raw: boolean;
  raw_methods: HttpMethod[];
  /** Préfixes de chemins autorisés pour la requête brute (* accepté). */
  path_allowlist: string[];
  path_denylist: string[];
  output: "full" | "redact";
  redact_fields: string[];
  max_response_kb: number;
  rate_limit_per_min: number;
  /** En-têtes X-FounderOS-* et X-Request-Id envoyés à l'outil. */
  trace_headers: boolean;
  /** Opération utilisée par « Tester la connexion ». */
  test_operation?: string;
}

export interface AuthConfig {
  // bearer
  header?: string;
  prefix?: string;
  // api_key
  in?: "header" | "query";
  name?: string;
  // basic
  username?: string;
  // headers
  header_names?: string[];
  // oauth2_*
  token_url?: string;
  authorize_url?: string;
  issuer?: string;
  client_id?: string;
  scope?: string;
  audience?: string;
  client_auth?: "body" | "basic";
  // session_login
  login_path?: string;
  login_method?: "POST" | "PUT";
  login_body?: Record<string, unknown>;
  token_path?: string;
  ttl_path?: string;
  ttl_seconds?: number;
  // en-têtes non secrets ajoutés à chaque appel (X-Scope-OrgID, X-Vault-Namespace…)
  extra_headers?: Record<string, string>;
}

export const AUTH_SCHEMES: Array<{ key: AuthScheme; label: string; hint: string }> = [
  { key: "none", label: "Aucune", hint: "Outil ouvert, ou protégé en amont par le réseau." },
  { key: "bearer", label: "Jeton (Bearer)", hint: "Jeton d'API ou de compte de service, envoyé dans un en-tête." },
  { key: "api_key", label: "Clé d'API", hint: "Clé dans un en-tête nommé ou un paramètre d'URL." },
  { key: "basic", label: "Identifiant + mot de passe", hint: "HTTP Basic : compte technique, robot, jeton d'API Jenkins." },
  { key: "headers", label: "En-têtes secrets", hint: "Plusieurs en-têtes, par ex. Cloudflare Access ou un proxy d'identité." },
  { key: "oauth2_client_credentials", label: "SSO machine (OAuth2 client credentials)", hint: "Jeton délivré par votre IdP (Keycloak, Okta, Entra ID, Dex) à un client technique." },
  { key: "oauth2_authorization_code", label: "SSO utilisateur (OAuth2 + PKCE)", hint: "Une personne se connecte via le SSO de l'entreprise ; les appels partent sous son identité." },
  { key: "session_login", label: "Connexion par session", hint: "Un appel de login renvoie un jeton (Argo CD session, Vault AppRole ou Kubernetes)." },
  { key: "mtls", label: "Certificat client (mTLS)", hint: "Certificat et clé détenus par le relais. Relais obligatoire." },
];

// ── Normalisation ────────────────────────────────────────────────────────────

const METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const OP_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const BINARY = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function asStr(v: unknown, d = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : d;
}
function asStrMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = String(val);
  }
  return out;
}
function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => asStr(x).trim()).filter(Boolean) : [];
}

export function toOpName(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "op_$1");
  return s.slice(0, 48) || "operation";
}

export function toSlug(raw: string): string {
  return raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "outil";
}

/** Le risque par défaut d'une méthode, quand l'opération ne le dit pas. */
export function defaultRisk(method: string): Risk {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return "read";
  if (m === "DELETE") return "destructive";
  return "write";
}

/** Les {param} cités par une chaîne (hors marqueurs {{secret:x}}). */
export function placeholders(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g)) out.push(m[1]);
  return out;
}

function collectBodyPlaceholders(v: unknown, into: Set<string>) {
  if (typeof v === "string") placeholders(v).forEach((p) => into.add(p));
  else if (Array.isArray(v)) v.forEach((x) => collectBodyPlaceholders(x, into));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectBodyPlaceholders(x, into));
}

/** Tous les paramètres qu'une opération référence quelque part. */
export function referencedParams(op: ConnectorOperation): string[] {
  const set = new Set<string>();
  placeholders(op.path ?? "").forEach((p) => set.add(p));
  Object.values(op.query ?? {}).forEach((v) => placeholders(v).forEach((p) => set.add(p)));
  Object.values(op.headers ?? {}).forEach((v) => placeholders(v).forEach((p) => set.add(p)));
  (op.args ?? []).forEach((a) => placeholders(a).forEach((p) => set.add(p)));
  collectBodyPlaceholders(op.body, set);
  return [...set];
}

export function normalizeParam(raw: unknown): OpParam | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = asStr(r.name).trim();
  if (!PARAM_NAME.test(name)) return null;
  const type = (["string", "number", "boolean", "object"] as const).includes(r.type as never)
    ? r.type as OpParam["type"] : "string";
  const p: OpParam = { name, type };
  const desc = asStr(r.description).trim();
  if (desc) p.description = desc.slice(0, 300);
  if (r.required === true) p.required = true;
  const en = asList(r.enum);
  if (en.length) p.enum = en.slice(0, 50);
  const pattern = asStr(r.pattern).trim();
  if (pattern) {
    try { new RegExp(pattern); p.pattern = pattern.slice(0, 200); } catch { /* motif invalide ignoré */ }
  }
  if (typeof r.default === "string" || typeof r.default === "number" || typeof r.default === "boolean") p.default = r.default;
  if (r.allow_slash === true) p.allow_slash = true;
  return p;
}

export function normalizeOperation(raw: unknown): ConnectorOperation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  let name = OP_NAME.test(asStr(r.name)) ? asStr(r.name) : toOpName(asStr(r.name));
  if (!name) return null;
  // « request » désigne la requête brute côté exécution.
  if (name === "request") name = "request_op";
  const kind = r.kind === "exec" ? "exec" : "http";
  const params = (Array.isArray(r.params) ? r.params : []).map(normalizeParam).filter(Boolean) as OpParam[];
  const op: ConnectorOperation = {
    name,
    description: asStr(r.description).trim().slice(0, 500) || name.replace(/_/g, " "),
    params,
    risk: "read",
  };
  if (kind === "exec") {
    op.kind = "exec";
    const binary = asStr(r.binary).trim().toLowerCase();
    op.binary = BINARY.test(binary) ? binary : "";
    op.args = asList(r.args).slice(0, 40).map((a) => a.slice(0, 200));
    op.risk = (["read", "write", "destructive"] as const).includes(r.risk as never) ? r.risk as Risk : "write";
  } else {
    const method = METHODS.includes(asStr(r.method).toUpperCase() as HttpMethod)
      ? asStr(r.method).toUpperCase() as HttpMethod : "GET";
    op.method = method;
    let path = asStr(r.path).trim() || "/";
    if (!path.startsWith("/")) path = `/${path}`;
    op.path = path.slice(0, 500);
    const q = asStrMap(r.query);
    if (Object.keys(q).length) op.query = q;
    const h = asStrMap(r.headers);
    if (Object.keys(h).length) op.headers = h;
    if (r.body !== undefined && r.body !== null && r.body !== "") op.body = r.body;
    const ct = asStr(r.content_type).trim();
    if (ct) op.content_type = ct.slice(0, 100);
    op.risk = (["read", "write", "destructive"] as const).includes(r.risk as never) ? r.risk as Risk : defaultRisk(method);
  }
  if ((["full", "redact", "keys_only"] as const).includes(r.output as never)) op.output = r.output as OutputMode;
  const t = Number(r.timeout_ms);
  if (Number.isFinite(t) && t > 0) op.timeout_ms = Math.min(Math.max(Math.round(t), 1000), 55_000);
  // Un paramètre cité mais non déclaré devient une chaîne obligatoire : mieux
  // vaut un schéma un peu trop strict qu'une URL avec « {name} » en dur.
  const declared = new Set(op.params!.map((p) => p.name));
  for (const ref of referencedParams(op)) {
    if (!declared.has(ref)) op.params!.push({ name: ref, type: "string", required: true });
  }
  return op;
}

export function normalizeOperations(raw: unknown): ConnectorOperation[] {
  const list = (Array.isArray(raw) ? raw : []).map(normalizeOperation).filter(Boolean) as ConnectorOperation[];
  const seen = new Set<string>();
  return list.filter((o) => (seen.has(o.name) ? false : (seen.add(o.name), true))).slice(0, 80);
}

export const DEFAULT_POLICY: ConnectorPolicy = {
  approval: "writes",
  read_only: false,
  allow_raw: false,
  raw_methods: ["GET"],
  path_allowlist: [],
  path_denylist: [],
  output: "redact",
  redact_fields: [],
  max_response_kb: 64,
  rate_limit_per_min: 60,
  trace_headers: true,
};

export function normalizePolicy(raw: unknown): ConnectorPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : d;
  };
  const p: ConnectorPolicy = {
    approval: (["writes", "all", "destructive_only"] as const).includes(r.approval as never)
      ? r.approval as ConnectorPolicy["approval"] : DEFAULT_POLICY.approval,
    read_only: r.read_only === true,
    allow_raw: r.allow_raw === true,
    raw_methods: asList(r.raw_methods).map((m) => m.toUpperCase()).filter((m) => METHODS.includes(m as HttpMethod)) as HttpMethod[],
    path_allowlist: asList(r.path_allowlist).map((s) => s.slice(0, 200)).slice(0, 40),
    path_denylist: asList(r.path_denylist).map((s) => s.slice(0, 200)).slice(0, 40),
    output: r.output === "full" ? "full" : "redact",
    redact_fields: asList(r.redact_fields).slice(0, 40),
    max_response_kb: num(r.max_response_kb, DEFAULT_POLICY.max_response_kb, 4, 512),
    rate_limit_per_min: num(r.rate_limit_per_min, DEFAULT_POLICY.rate_limit_per_min, 1, 600),
    trace_headers: r.trace_headers !== false,
  };
  if (!p.raw_methods.length) p.raw_methods = ["GET"];
  const test = asStr(r.test_operation).trim();
  if (test) p.test_operation = test;
  return p;
}

export function normalizeAuthConfig(raw: unknown): AuthConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: AuthConfig = {};
  for (const k of ["header", "prefix", "name", "username", "token_url", "authorize_url", "issuer", "client_id",
    "scope", "audience", "login_path", "token_path", "ttl_path"] as const) {
    if (typeof r[k] === "string") (out as Record<string, unknown>)[k] = (r[k] as string).slice(0, 500);
  }
  if (r.in === "query" || r.in === "header") out.in = r.in;
  if (r.client_auth === "basic" || r.client_auth === "body") out.client_auth = r.client_auth;
  if (r.login_method === "PUT" || r.login_method === "POST") out.login_method = r.login_method;
  const names = asList(r.header_names).slice(0, 10);
  if (names.length) out.header_names = names;
  if (r.login_body && typeof r.login_body === "object" && !Array.isArray(r.login_body)) {
    out.login_body = r.login_body as Record<string, unknown>;
  }
  const ttl = Number(r.ttl_seconds);
  if (Number.isFinite(ttl) && ttl > 0) out.ttl_seconds = Math.min(Math.round(ttl), 86_400);
  const extra = asStrMap(r.extra_headers);
  if (Object.keys(extra).length) out.extra_headers = extra;
  return out;
}

/** Les champs secrets qu'un schéma attend (ce que le formulaire demande). */
export function secretFieldsFor(scheme: AuthScheme, cfg: AuthConfig): Array<{ name: string; label: string; optional?: boolean; multiline?: boolean }> {
  switch (scheme) {
    case "bearer": return [{ name: "token", label: "Jeton" }];
    case "api_key": return [{ name: "key", label: "Clé d'API" }];
    case "basic": return [{ name: "password", label: "Mot de passe ou jeton" }];
    case "headers": return (cfg.header_names ?? []).map((h) => ({ name: h, label: h }));
    case "oauth2_client_credentials": return [{ name: "client_secret", label: "Client secret" }];
    case "oauth2_authorization_code": return [{ name: "client_secret", label: "Client secret (vide si client public PKCE)", optional: true }];
    case "session_login": {
      const set = new Set<string>();
      const walk = (v: unknown) => {
        if (typeof v === "string") for (const m of v.matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)) set.add(m[1]);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(cfg.login_body ?? {});
      return [...set].map((n) => ({ name: n, label: n }));
    }
    case "mtls": return [
      { name: "cert", label: "Certificat client (PEM)", multiline: true },
      { name: "key", label: "Clé privée (PEM)", multiline: true },
    ];
    default: return [];
  }
}

// ── Ce qu'il reste à faire ───────────────────────────────────────────────────

export interface ConnectorLike {
  name?: string;
  base_url?: string;
  transport?: Transport;
  relay_id?: string | null;
  auth_scheme?: AuthScheme;
  auth_config?: unknown;
  operations?: unknown;
  status?: string;
}

/**
 * Ce qui empêche ce connecteur de servir, en phrases. `credentialsCount`
 * absent : on ne juge pas les identifiants (l'assistant qui rédige un brouillon).
 */
export function connectorSetupIssues(c: ConnectorLike, credentialsCount?: number): string[] {
  const issues: string[] = [];
  const url = (c.base_url ?? "").trim();
  if (!url) issues.push("URL de base à renseigner.");
  else if (!/^https?:\/\/[^/\s]+/i.test(url) || /[<>{}]/.test(url)) issues.push("URL de base invalide (http(s)://hôte, sans marqueur).");
  if (c.transport === "relay" && !c.relay_id) issues.push("Transport par relais choisi mais aucun relais sélectionné.");
  const ops = normalizeOperations(c.operations);
  if (!ops.length) issues.push("Aucune opération déclarée.");
  if (c.transport !== "relay" && ops.some((o) => o.kind === "exec")) {
    issues.push("Les opérations « commande » (helm, kubectl…) ne s'exécutent que sur un relais.");
  }
  const scheme = c.auth_scheme ?? "none";
  const cfg = normalizeAuthConfig(c.auth_config);
  if (scheme === "mtls" && c.transport !== "relay") issues.push("Le mTLS exige le transport par relais.");
  if ((scheme === "oauth2_client_credentials" || scheme === "oauth2_authorization_code") && !cfg.token_url) issues.push("URL du serveur de jetons (token_url) à renseigner.");
  if ((scheme === "oauth2_client_credentials" || scheme === "oauth2_authorization_code") && !cfg.client_id) issues.push("client_id à renseigner.");
  if (scheme === "oauth2_authorization_code" && !cfg.authorize_url) issues.push("URL d'autorisation (authorize_url) à renseigner.");
  if (scheme === "session_login" && !cfg.login_path) issues.push("Chemin de connexion (login_path) à renseigner.");
  if (scheme === "headers" && !(cfg.header_names ?? []).length) issues.push("Nommez au moins un en-tête secret.");
  if (scheme === "api_key" && !cfg.name) issues.push("Nom de l'en-tête ou du paramètre de la clé à renseigner.");
  if (credentialsCount !== undefined && scheme !== "none" && credentialsCount === 0) {
    issues.push(scheme === "oauth2_authorization_code" ? "Personne ne s'est encore connecté via le SSO." : "Aucun identifiant enregistré.");
  }
  return issues;
}

// ── Modèles ──────────────────────────────────────────────────────────────────
// Des connecteurs prêts à compléter : l'URL et le secret restent à saisir, les
// opérations suivent la documentation officielle de chaque outil. Lecture par
// défaut ; les écritures sont marquées, les gestes irréversibles « destructive »
// (approbation obligatoire, quel que soit le niveau d'autonomie).

export interface ConnectorTemplate {
  key: string;
  name: string;
  category: "GitOps & déploiement" | "Secrets" | "Observabilité" | "Kubernetes" | "CI/CD & qualité" | "Générique";
  description: string;
  docs: string;
  base_url_hint: string;
  default_transport: Transport;
  auth_scheme: AuthScheme;
  auth_config: AuthConfig;
  operations: ConnectorOperation[];
  policy?: Partial<ConnectorPolicy>;
  setup_notes: string;
}

const p = (name: string, description: string, extra: Partial<OpParam> = {}): OpParam =>
  ({ name, type: "string", description, ...extra });

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    key: "argocd",
    name: "Argo CD",
    category: "GitOps & déploiement",
    description: "État des applications GitOps, synchronisations, historique et rollback.",
    docs: "https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/",
    base_url_hint: "https://argocd.interne.exemple",
    default_transport: "relay",
    auth_scheme: "bearer",
    auth_config: { header: "Authorization", prefix: "Bearer " },
    policy: { test_operation: "list_applications" },
    setup_notes:
      "Créez un compte local dédié (accounts.<nom>: apiKey dans argocd-cm) avec une politique RBAC limitée (role:readonly pour commencer), " +
      "puis générez son jeton : argocd account generate-token --account <nom>. Avec un SSO Dex/OIDC, préférez ce compte technique au jeton d'une personne.",
    operations: [
      { name: "list_applications", description: "Lister les applications (filtrables par projet ou sélecteur de labels).", method: "GET", path: "/api/v1/applications",
        query: { projects: "{project}", selector: "{selector}" }, risk: "read",
        params: [p("project", "Projet Argo CD (optionnel)."), p("selector", "Sélecteur de labels, ex. team=payments (optionnel).")] },
      { name: "get_application", description: "Détail d'une application : statut de sync, santé, révision.", method: "GET", path: "/api/v1/applications/{name}", risk: "read",
        params: [p("name", "Nom de l'application.", { required: true })] },
      { name: "get_resource_tree", description: "Arbre des ressources Kubernetes d'une application et leur santé.", method: "GET", path: "/api/v1/applications/{name}/resource-tree", risk: "read",
        params: [p("name", "Nom de l'application.", { required: true })] },
      { name: "get_events", description: "Événements Kubernetes liés à une application.", method: "GET", path: "/api/v1/applications/{name}/events", risk: "read",
        params: [p("name", "Nom de l'application.", { required: true })] },
      { name: "get_revision_metadata", description: "Auteur, date et message d'une révision Git déployée.", method: "GET", path: "/api/v1/applications/{name}/revisions/{revision}/metadata", risk: "read",
        params: [p("name", "Nom de l'application.", { required: true }), p("revision", "SHA ou tag.", { required: true })] },
      { name: "list_projects", description: "Lister les projets Argo CD.", method: "GET", path: "/api/v1/projects", risk: "read" },
      { name: "list_clusters", description: "Lister les clusters déclarés.", method: "GET", path: "/api/v1/clusters", risk: "read" },
      { name: "sync_application", description: "Synchroniser une application (option dry-run et prune).", method: "POST", path: "/api/v1/applications/{name}/sync",
        body: { revision: "{revision}", prune: "{prune}", dryRun: "{dry_run}" }, risk: "write",
        params: [p("name", "Nom de l'application.", { required: true }), p("revision", "Révision cible (optionnel, défaut : celle de l'application)."),
          { name: "prune", type: "boolean", description: "Supprimer les ressources orphelines.", default: false },
          { name: "dry_run", type: "boolean", description: "Simulation sans rien appliquer.", default: false }] },
      { name: "rollback_application", description: "Revenir à une entrée d'historique (id de l'historique de déploiement).", method: "POST", path: "/api/v1/applications/{name}/rollback",
        body: { id: "{history_id}", dryRun: "{dry_run}" }, risk: "destructive",
        params: [p("name", "Nom de l'application.", { required: true }), { name: "history_id", type: "number", description: "Identifiant d'historique (status.history[].id).", required: true },
          { name: "dry_run", type: "boolean", description: "Simulation sans rien appliquer.", default: false }] },
      { name: "terminate_operation", description: "Interrompre l'opération de sync en cours.", method: "DELETE", path: "/api/v1/applications/{name}/operation", risk: "write",
        params: [p("name", "Nom de l'application.", { required: true })] },
    ],
  },
  {
    key: "vault",
    name: "HashiCorp Vault",
    category: "Secrets",
    description: "Santé, montages, métadonnées des secrets KV v2. Les valeurs ne sont jamais montrées au collaborateur.",
    docs: "https://developer.hashicorp.com/vault/api-docs",
    base_url_hint: "https://vault.interne.exemple:8200",
    default_transport: "relay",
    auth_scheme: "session_login",
    auth_config: {
      login_path: "/v1/auth/approle/login", login_method: "POST",
      login_body: { role_id: "{{secret:role_id}}", secret_id: "{{secret:secret_id}}" },
      token_path: "auth.client_token", ttl_path: "auth.lease_duration",
      header: "X-Vault-Token", prefix: "",
    },
    policy: { test_operation: "health" },
    setup_notes:
      "Activez AppRole et créez un rôle dont la politique Vault ne donne que ce qu'il faut (list + read sur metadata/ pour l'inventaire). " +
      "Sur Kubernetes, remplacez le corps de connexion par {\"role\": \"<role>\", \"jwt\": \"{{secret:jwt}}\"} vers /v1/auth/kubernetes/login et laissez le relais lire le jeton du compte de service (file:/var/run/secrets/kubernetes.io/serviceaccount/token). " +
      "Vault Enterprise : ajoutez l'en-tête X-Vault-Namespace dans les en-têtes fixes.",
    operations: [
      { name: "health", description: "État du cluster Vault (initialisé, scellé, standby).", method: "GET", path: "/v1/sys/health", query: { standbyok: "true" }, risk: "read" },
      { name: "seal_status", description: "Statut de scellement et progression du descellement.", method: "GET", path: "/v1/sys/seal-status", risk: "read" },
      { name: "token_lookup_self", description: "Ce que le jeton du collaborateur a le droit de faire (politiques, TTL).", method: "GET", path: "/v1/auth/token/lookup-self", risk: "read", output: "redact" },
      { name: "list_mounts", description: "Moteurs de secrets montés.", method: "GET", path: "/v1/sys/mounts", risk: "read" },
      { name: "list_secrets", description: "Lister les clés sous un chemin KV v2 (sans valeurs).", method: "GET", path: "/v1/{mount}/metadata/{path}", query: { list: "true" }, risk: "read",
        params: [p("mount", "Montage KV v2, ex. secret.", { required: true, default: "secret" }), p("path", "Chemin, ex. team/app (vide pour la racine).", { allow_slash: true })] },
      { name: "secret_metadata", description: "Métadonnées d'un secret KV v2 : versions, dates, suppression programmée.", method: "GET", path: "/v1/{mount}/metadata/{path}", risk: "read",
        params: [p("mount", "Montage KV v2.", { required: true, default: "secret" }), p("path", "Chemin du secret.", { required: true, allow_slash: true })] },
      { name: "secret_keys", description: "Noms des champs d'un secret KV v2. Les valeurs sont masquées.", method: "GET", path: "/v1/{mount}/data/{path}", risk: "read", output: "keys_only",
        params: [p("mount", "Montage KV v2.", { required: true, default: "secret" }), p("path", "Chemin du secret.", { required: true, allow_slash: true })] },
      { name: "list_policies", description: "Lister les politiques ACL.", method: "GET", path: "/v1/sys/policies/acl", query: { list: "true" }, risk: "read" },
      { name: "read_policy", description: "Lire une politique ACL.", method: "GET", path: "/v1/sys/policies/acl/{name}", risk: "read",
        params: [p("name", "Nom de la politique.", { required: true })] },
      { name: "list_audit_devices", description: "Dispositifs d'audit actifs.", method: "GET", path: "/v1/sys/audit", risk: "read" },
      { name: "revoke_lease", description: "Révoquer un bail (identifiants dynamiques).", method: "PUT", path: "/v1/sys/leases/revoke", body: { lease_id: "{lease_id}" }, risk: "destructive",
        params: [p("lease_id", "Identifiant du bail.", { required: true })] },
    ],
  },
  {
    key: "grafana",
    name: "Grafana",
    category: "Observabilité",
    description: "Tableaux de bord, alertes, requêtes de sources de données, annotations.",
    docs: "https://grafana.com/docs/grafana/latest/developers/http_api/",
    base_url_hint: "https://grafana.interne.exemple",
    default_transport: "direct",
    auth_scheme: "bearer",
    auth_config: { header: "Authorization", prefix: "Bearer " },
    policy: { test_operation: "health" },
    setup_notes: "Créez un compte de service (Administration → Comptes de service) au rôle Viewer, puis un jeton pour ce compte. Passez-le Editor seulement si les annotations ou silences sont voulus.",
    operations: [
      { name: "health", description: "Santé de Grafana et de sa base.", method: "GET", path: "/api/health", risk: "read" },
      { name: "search_dashboards", description: "Chercher des tableaux de bord.", method: "GET", path: "/api/search", query: { query: "{query}", type: "dash-db", limit: "{limit}" }, risk: "read",
        params: [p("query", "Texte recherché."), { name: "limit", type: "number", description: "Maximum de résultats.", default: 30 }] },
      { name: "get_dashboard", description: "Définition d'un tableau de bord (panneaux, requêtes).", method: "GET", path: "/api/dashboards/uid/{uid}", risk: "read",
        params: [p("uid", "UID du tableau de bord.", { required: true })] },
      { name: "list_datasources", description: "Sources de données configurées.", method: "GET", path: "/api/datasources", risk: "read", output: "redact" },
      { name: "query_datasource", description: "Exécuter une requête sur une source (PromQL, LogQL…) via /api/ds/query.", method: "POST", path: "/api/ds/query",
        body: { from: "{from}", to: "{to}", queries: [{ refId: "A", datasource: { uid: "{datasource_uid}" }, expr: "{expr}", maxDataPoints: 500 }] }, risk: "read",
        params: [p("datasource_uid", "UID de la source.", { required: true }), p("expr", "Expression de requête.", { required: true }),
          p("from", "Début, ex. now-1h.", { default: "now-1h" }), p("to", "Fin, ex. now.", { default: "now" })] },
      { name: "active_alerts", description: "Alertes Grafana actives.", method: "GET", path: "/api/alertmanager/grafana/api/v2/alerts", query: { active: "true" }, risk: "read" },
      { name: "alert_rules_state", description: "État des règles d'alerte.", method: "GET", path: "/api/prometheus/grafana/api/v1/rules", risk: "read" },
      { name: "create_annotation", description: "Poser une annotation (déploiement, incident) sur un tableau de bord.", method: "POST", path: "/api/annotations",
        body: { dashboardUID: "{dashboard_uid}", text: "{text}", tags: ["founderos"] }, risk: "write",
        params: [p("dashboard_uid", "UID du tableau de bord (optionnel : annotation globale)."), p("text", "Texte de l'annotation.", { required: true })] },
    ],
  },
  {
    key: "loki",
    name: "Grafana Loki",
    category: "Observabilité",
    description: "Recherche dans les journaux (LogQL), labels et séries.",
    docs: "https://grafana.com/docs/loki/latest/reference/loki-http-api/",
    base_url_hint: "http://loki-gateway.monitoring.svc",
    default_transport: "relay",
    auth_scheme: "none",
    auth_config: { extra_headers: { "X-Scope-OrgID": "" } },
    policy: { test_operation: "list_labels", max_response_kb: 128 },
    setup_notes: "En multi-tenant, renseignez X-Scope-OrgID dans les en-têtes fixes (sinon retirez-le). Derrière une passerelle authentifiée, passez en Identifiant + mot de passe (Grafana Cloud : identifiant d'instance + jeton).",
    operations: [
      { name: "query_range", description: "Lignes de journaux sur une période (LogQL). Dates en RFC3339 ou nanosecondes ; défaut : la dernière heure.", method: "GET", path: "/loki/api/v1/query_range",
        query: { query: "{query}", start: "{start}", end: "{end}", limit: "{limit}", direction: "backward" }, risk: "read",
        params: [p("query", "Requête LogQL, ex. {namespace=\"payments\"} |= \"error\".", { required: true }), p("start", "Début (optionnel)."), p("end", "Fin (optionnel)."),
          { name: "limit", type: "number", description: "Nombre maximum de lignes.", default: 200 }] },
      { name: "query_instant", description: "Requête LogQL instantanée (métriques sur journaux, ex. count_over_time).", method: "GET", path: "/loki/api/v1/query", query: { query: "{query}", limit: "{limit}" }, risk: "read",
        params: [p("query", "Requête LogQL.", { required: true }), { name: "limit", type: "number", description: "Maximum.", default: 100 }] },
      { name: "list_labels", description: "Noms de labels indexés.", method: "GET", path: "/loki/api/v1/labels", risk: "read" },
      { name: "label_values", description: "Valeurs d'un label (ex. namespace, app).", method: "GET", path: "/loki/api/v1/label/{label}/values", risk: "read",
        params: [p("label", "Nom du label.", { required: true })] },
      { name: "series", description: "Flux correspondant à un sélecteur.", method: "GET", path: "/loki/api/v1/series", query: { "match[]": "{selector}" }, risk: "read",
        params: [p("selector", "Sélecteur, ex. {app=\"api\"}.", { required: true })] },
    ],
  },
  {
    key: "prometheus",
    name: "Prometheus",
    category: "Observabilité",
    description: "Requêtes PromQL, alertes, règles et cibles de collecte.",
    docs: "https://prometheus.io/docs/prometheus/latest/querying/api/",
    base_url_hint: "http://prometheus-operated.monitoring.svc:9090",
    default_transport: "relay",
    auth_scheme: "none",
    auth_config: {},
    policy: { test_operation: "list_alerts" },
    setup_notes: "Souvent non authentifié à l'intérieur du cluster : laissez « Aucune » et passez par le relais. Derrière un proxy, choisissez Basic ou Bearer.",
    operations: [
      { name: "query", description: "Requête PromQL instantanée.", method: "GET", path: "/api/v1/query", query: { query: "{query}", time: "{time}" }, risk: "read",
        params: [p("query", "Expression PromQL.", { required: true }), p("time", "Horodatage (optionnel).")] },
      { name: "query_range", description: "Requête PromQL sur une période.", method: "GET", path: "/api/v1/query_range", query: { query: "{query}", start: "{start}", end: "{end}", step: "{step}" }, risk: "read",
        params: [p("query", "Expression PromQL.", { required: true }), p("start", "Début (RFC3339 ou epoch).", { required: true }), p("end", "Fin.", { required: true }), p("step", "Pas, ex. 60s.", { default: "60s" })] },
      { name: "list_alerts", description: "Alertes actives.", method: "GET", path: "/api/v1/alerts", risk: "read" },
      { name: "list_rules", description: "Règles d'alerte et d'enregistrement.", method: "GET", path: "/api/v1/rules", risk: "read" },
      { name: "list_targets", description: "Cibles de collecte et leur santé.", method: "GET", path: "/api/v1/targets", query: { state: "active" }, risk: "read" },
    ],
  },
  {
    key: "alertmanager",
    name: "Alertmanager",
    category: "Observabilité",
    description: "Alertes en cours et silences.",
    docs: "https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml",
    base_url_hint: "http://alertmanager-operated.monitoring.svc:9093",
    default_transport: "relay",
    auth_scheme: "none",
    auth_config: {},
    policy: { test_operation: "list_alerts" },
    setup_notes: "Les silences sont des écritures : ils passent en approbation par défaut.",
    operations: [
      { name: "list_alerts", description: "Alertes actives non silencées.", method: "GET", path: "/api/v2/alerts", query: { active: "true", silenced: "false" }, risk: "read" },
      { name: "list_silences", description: "Silences existants.", method: "GET", path: "/api/v2/silences", risk: "read" },
      { name: "create_silence", description: "Créer un silence sur une alerte (nom d'alerte, durée).", method: "POST", path: "/api/v2/silences",
        body: { matchers: [{ name: "alertname", value: "{alertname}", isRegex: false, isEqual: true }], startsAt: "{starts_at}", endsAt: "{ends_at}", createdBy: "founderos", comment: "{comment}" }, risk: "write",
        params: [p("alertname", "Nom de l'alerte.", { required: true }), p("starts_at", "Début RFC3339.", { required: true }), p("ends_at", "Fin RFC3339.", { required: true }), p("comment", "Raison.", { required: true })] },
      { name: "expire_silence", description: "Lever un silence.", method: "DELETE", path: "/api/v2/silence/{silence_id}", risk: "write",
        params: [p("silence_id", "Identifiant du silence.", { required: true })] },
    ],
  },
  {
    key: "kubernetes",
    name: "Kubernetes API",
    category: "Kubernetes",
    description: "Pods, déploiements, événements, journaux de conteneurs ; redémarrage et mise à l'échelle sous approbation.",
    docs: "https://kubernetes.io/docs/reference/kubernetes-api/",
    base_url_hint: "https://kubernetes.default.svc",
    default_transport: "relay",
    auth_scheme: "bearer",
    auth_config: { header: "Authorization", prefix: "Bearer " },
    policy: { test_operation: "list_namespaces", max_response_kb: 128 },
    setup_notes:
      "Depuis le relais déployé dans le cluster : identifiant à l'emplacement « relais » avec token = file:/var/run/secrets/kubernetes.io/serviceaccount/token. " +
      "Les droits réels sont ceux du ServiceAccount du relais (ClusterRole view par défaut dans le chart Helm) : c'est la vraie barrière.",
    operations: [
      { name: "list_namespaces", description: "Namespaces du cluster.", method: "GET", path: "/api/v1/namespaces", risk: "read" },
      { name: "list_pods", description: "Pods d'un namespace et leur état.", method: "GET", path: "/api/v1/namespaces/{namespace}/pods", query: { labelSelector: "{selector}" }, risk: "read",
        params: [p("namespace", "Namespace.", { required: true }), p("selector", "Sélecteur de labels (optionnel).")] },
      { name: "pod_logs", description: "Dernières lignes du journal d'un conteneur.", method: "GET", path: "/api/v1/namespaces/{namespace}/pods/{pod}/log",
        query: { container: "{container}", tailLines: "{tail}", previous: "{previous}" }, risk: "read",
        params: [p("namespace", "Namespace.", { required: true }), p("pod", "Nom du pod.", { required: true }), p("container", "Conteneur (optionnel)."),
          { name: "tail", type: "number", description: "Nombre de lignes.", default: 200 }, { name: "previous", type: "boolean", description: "Journal du conteneur précédent (après un crash).", default: false }] },
      { name: "list_deployments", description: "Déploiements d'un namespace.", method: "GET", path: "/apis/apps/v1/namespaces/{namespace}/deployments", risk: "read",
        params: [p("namespace", "Namespace.", { required: true })] },
      { name: "list_events", description: "Événements récents d'un namespace.", method: "GET", path: "/api/v1/namespaces/{namespace}/events", risk: "read",
        params: [p("namespace", "Namespace.", { required: true })] },
      { name: "restart_deployment", description: "Redémarrage progressif d'un déploiement (comme kubectl rollout restart).", method: "PATCH", path: "/apis/apps/v1/namespaces/{namespace}/deployments/{name}",
        content_type: "application/strategic-merge-patch+json",
        body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": "{restarted_at}" } } } } }, risk: "write",
        params: [p("namespace", "Namespace.", { required: true }), p("name", "Déploiement.", { required: true }), p("restarted_at", "Horodatage RFC3339 (maintenant).", { required: true })] },
      { name: "scale_deployment", description: "Changer le nombre de réplicas.", method: "PATCH", path: "/apis/apps/v1/namespaces/{namespace}/deployments/{name}/scale",
        content_type: "application/merge-patch+json", body: { spec: { replicas: "{replicas}" } }, risk: "destructive",
        params: [p("namespace", "Namespace.", { required: true }), p("name", "Déploiement.", { required: true }), { name: "replicas", type: "number", description: "Réplicas voulus.", required: true }] },
    ],
  },
  {
    key: "helm",
    name: "Helm (via relais)",
    category: "Kubernetes",
    description: "Releases Helm : état, historique, valeurs, rollback. Exécuté par la CLI helm du relais.",
    docs: "https://helm.sh/docs/helm/",
    base_url_hint: "https://kubernetes.default.svc",
    default_transport: "relay",
    auth_scheme: "none",
    auth_config: {},
    policy: { test_operation: "list_releases", max_response_kb: 128 },
    setup_notes:
      "Helm n'a pas d'API : le relais lance la CLI. Autorisez-la côté relais (RELAY_ALLOWED_BINARIES=helm) ; elle agit avec le ServiceAccount du relais. " +
      "L'URL de base sert uniquement de repère ici.",
    operations: [
      { name: "list_releases", description: "Releases de tous les namespaces.", kind: "exec", binary: "helm", args: ["list", "--all-namespaces", "--output", "json"], risk: "read" },
      { name: "release_status", description: "État d'une release.", kind: "exec", binary: "helm", args: ["status", "{release}", "--namespace", "{namespace}", "--output", "json"], risk: "read",
        params: [p("release", "Nom de la release.", { required: true }), p("namespace", "Namespace.", { required: true })] },
      { name: "release_history", description: "Historique des révisions d'une release.", kind: "exec", binary: "helm", args: ["history", "{release}", "--namespace", "{namespace}", "--output", "json"], risk: "read",
        params: [p("release", "Nom de la release.", { required: true }), p("namespace", "Namespace.", { required: true })] },
      { name: "release_values", description: "Valeurs utilisateur d'une release (secrets masqués).", kind: "exec", binary: "helm", args: ["get", "values", "{release}", "--namespace", "{namespace}", "--output", "json"], risk: "read", output: "redact",
        params: [p("release", "Nom de la release.", { required: true }), p("namespace", "Namespace.", { required: true })] },
      { name: "rollback_release", description: "Revenir à une révision précédente.", kind: "exec", binary: "helm", args: ["rollback", "{release}", "{revision}", "--namespace", "{namespace}", "--wait"], risk: "destructive",
        params: [p("release", "Nom de la release.", { required: true }), { name: "revision", type: "number", description: "Révision cible.", required: true }, p("namespace", "Namespace.", { required: true })] },
    ],
  },
  {
    key: "jenkins",
    name: "Jenkins",
    category: "CI/CD & qualité",
    description: "Jobs, derniers builds, journaux de console, déclenchement de builds.",
    docs: "https://www.jenkins.io/doc/book/using/remote-access-api/",
    base_url_hint: "https://jenkins.interne.exemple",
    default_transport: "relay",
    auth_scheme: "basic",
    auth_config: { username: "" },
    policy: { test_operation: "list_jobs", max_response_kb: 128 },
    setup_notes: "Utilisateur technique + jeton d'API (profil → Configure → API Token). Avec un jeton d'API, le crumb CSRF n'est pas requis.",
    operations: [
      { name: "list_jobs", description: "Jobs et couleur de leur dernier build.", method: "GET", path: "/api/json", query: { tree: "jobs[name,color,url]" }, risk: "read" },
      { name: "last_build", description: "Dernier build d'un job.", method: "GET", path: "/job/{job}/lastBuild/api/json", risk: "read",
        params: [p("job", "Nom du job.", { required: true })] },
      { name: "console_text", description: "Journal de console d'un build.", method: "GET", path: "/job/{job}/{build}/consoleText", risk: "read",
        params: [p("job", "Nom du job.", { required: true }), p("build", "Numéro de build ou lastBuild.", { required: true, default: "lastBuild" })] },
      { name: "trigger_build", description: "Déclencher un build.", method: "POST", path: "/job/{job}/build", risk: "write",
        params: [p("job", "Nom du job.", { required: true })] },
    ],
  },
  {
    key: "gitlab",
    name: "GitLab auto-hébergé",
    category: "CI/CD & qualité",
    description: "Projets, pipelines, merge requests, journaux de jobs.",
    docs: "https://docs.gitlab.com/ee/api/rest/",
    base_url_hint: "https://gitlab.interne.exemple",
    default_transport: "relay",
    auth_scheme: "api_key",
    auth_config: { in: "header", name: "PRIVATE-TOKEN" },
    policy: { test_operation: "list_projects" },
    setup_notes: "Jeton d'accès de projet ou de groupe, portée read_api (api pour déclencher des pipelines).",
    operations: [
      { name: "list_projects", description: "Projets accessibles.", method: "GET", path: "/api/v4/projects", query: { membership: "true", simple: "true", per_page: "50" }, risk: "read" },
      { name: "list_pipelines", description: "Pipelines récents d'un projet.", method: "GET", path: "/api/v4/projects/{project}/pipelines", query: { per_page: "20", ref: "{ref}" }, risk: "read",
        params: [p("project", "ID ou chemin complet (groupe/projet).", { required: true }), p("ref", "Branche (optionnel).")] },
      { name: "list_merge_requests", description: "Merge requests ouvertes.", method: "GET", path: "/api/v4/projects/{project}/merge_requests", query: { state: "opened", per_page: "30" }, risk: "read",
        params: [p("project", "ID ou chemin complet.", { required: true })] },
      { name: "job_log", description: "Journal d'un job de pipeline.", method: "GET", path: "/api/v4/projects/{project}/jobs/{job_id}/trace", risk: "read",
        params: [p("project", "ID ou chemin complet.", { required: true }), p("job_id", "Identifiant du job.", { required: true })] },
      { name: "run_pipeline", description: "Lancer un pipeline sur une branche.", method: "POST", path: "/api/v4/projects/{project}/pipeline", query: { ref: "{ref}" }, risk: "write",
        params: [p("project", "ID ou chemin complet.", { required: true }), p("ref", "Branche.", { required: true })] },
    ],
  },
  {
    key: "sonarqube",
    name: "SonarQube",
    category: "CI/CD & qualité",
    description: "Quality gates et problèmes de qualité ou de sécurité.",
    docs: "https://docs.sonarsource.com/sonarqube/latest/extension-guide/web-api/",
    base_url_hint: "https://sonar.interne.exemple",
    default_transport: "relay",
    auth_scheme: "bearer",
    auth_config: { header: "Authorization", prefix: "Bearer " },
    policy: { test_operation: "list_projects" },
    setup_notes: "Jeton d'utilisateur technique (Mon compte → Sécurité), droit Browse sur les projets voulus.",
    operations: [
      { name: "list_projects", description: "Projets analysés.", method: "GET", path: "/api/components/search", query: { qualifiers: "TRK", ps: "100" }, risk: "read" },
      { name: "quality_gate", description: "Statut du quality gate d'un projet.", method: "GET", path: "/api/qualitygates/project_status", query: { projectKey: "{project_key}" }, risk: "read",
        params: [p("project_key", "Clé du projet.", { required: true })] },
      { name: "search_issues", description: "Problèmes ouverts d'un projet, filtrables par sévérité.", method: "GET", path: "/api/issues/search",
        query: { componentKeys: "{project_key}", severities: "{severities}", resolved: "false", ps: "50" }, risk: "read",
        params: [p("project_key", "Clé du projet.", { required: true }), p("severities", "Ex. BLOCKER,CRITICAL (optionnel).")] },
    ],
  },
  {
    key: "generic",
    name: "API REST interne",
    category: "Générique",
    description: "Point de départ vide : déclarez vos opérations, importez un OpenAPI ou demandez-les à l'assistant.",
    docs: "",
    base_url_hint: "https://api.interne.exemple",
    default_transport: "relay",
    auth_scheme: "bearer",
    auth_config: { header: "Authorization", prefix: "Bearer " },
    setup_notes: "Déclarez au moins une opération de lecture et désignez-la comme test.",
    operations: [],
  },
];

export function findTemplate(key: string): ConnectorTemplate | undefined {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CONNECTOR_TEMPLATES.find((t) => t.key === k || t.name.toLowerCase().replace(/[^a-z0-9]/g, "") === k);
}
