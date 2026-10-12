// Outils internes : l'exécution.
//
// Le seul endroit où le secret d'un connecteur personnalisé est déchiffré (il
// n'est importé que par connector-action). Le collaborateur choisit une
// opération et ses paramètres ; ce module :
//
//   1. vérifie que le connecteur est actif, que le collaborateur a le droit de
//      s'en servir (service, profil d'identifiants, opérations accordées) ;
//   2. applique la politique : lecture seule, plancher d'approbation pour les
//      gestes destructifs, débit, chemins autorisés pour la requête brute ;
//   3. construit la requête (paramètres validés, encodés, jamais concaténés à
//      l'aveugle), ajoute les en-têtes de traçage, puis
//   4. la fait partir EN DIRECT (garde anti-SSRF, pas de redirection suivie :
//      un 302 vers un autre hôte emporterait l'en-tête d'authentification) ou
//      PAR LE RELAIS du client (file connector_relay_jobs) ;
//   5. masque ce qui ressemble à un secret dans la réponse avant que le modèle
//      ne la lise ;
//   6. inscrit l'appel au journal chaîné, quelle qu'en soit l'issue.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { assertSafeUrl } from "./ssrf.ts";
import { pkce, randomState } from "./mcp-oauth.ts";
import {
  type AuthConfig, type AuthScheme, type ConnectorOperation, type ConnectorPolicy, type OpParam, type Risk,
  normalizeAuthConfig, normalizeOperations, normalizePolicy, placeholders, secretFieldsFor,
} from "./custom-connector-model.ts";

// ── Lignes ───────────────────────────────────────────────────────────────────

export interface ConnectorRow {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  name: string;
  slug: string;
  base_url: string;
  transport: "direct" | "relay";
  relay_id: string | null;
  auth_scheme: AuthScheme;
  auth_config: unknown;
  operations: unknown;
  policy: unknown;
  status: "draft" | "active" | "disabled";
  version: number;
}

interface CredentialRow {
  id: string;
  connector_id: string;
  workspace_id: string;
  label: string;
  location: "cloud" | "relay";
  encrypted_payload: string | null;
  iv: string | null;
  relay_refs: Record<string, string> | null;
  identity: string | null;
  binding: string;
  allowed_agent_ids: string[] | null;
  expires_at: string | null;
  token_enc: string | null;
  token_iv: string | null;
  token_expires_at: string | null;
  status: "active" | "revoked";
  rotated_at: string | null;
}

interface RelayRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  status: string;
  last_seen_at: string | null;
}

const CONNECTOR_COLS =
  "id, workspace_id, project_id, service_dashboard_id, name, slug, base_url, transport, relay_id, auth_scheme, auth_config, operations, policy, status, version";

// ── Petits outils ────────────────────────────────────────────────────────────

class CallError extends Error {
  constructor(message: string, public decision: "blocked" | "error" = "error") {
    super(message);
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function originOf(url: string | undefined, base?: string): string {
  if (!url) return "";
  try {
    return new URL(url, base || undefined).origin;
  } catch {
    return "";
  }
}

/**
 * Les origines vers lesquelles un secret peut partir. Un profil enregistré
 * pour argocd.interne ne part pas vers une URL modifiée depuis.
 */
export async function computeBinding(c: Pick<ConnectorRow, "base_url" | "auth_config">): Promise<string> {
  const cfg = normalizeAuthConfig(c.auth_config);
  return await sha256Hex(JSON.stringify([
    originOf(c.base_url),
    originOf(cfg.token_url),
    cfg.login_path && /^https?:/i.test(cfg.login_path) ? originOf(cfg.login_path) : "",
  ]));
}

function hintOf(v: string): string {
  return v.length <= 8 ? "••••" : `••••${v.slice(-4)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un en-tête HTTP n'accepte que du Latin-1 : un nom de collaborateur accentué le casserait. */
function headerSafe(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "").slice(0, 120);
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

// ── Paramètres ───────────────────────────────────────────────────────────────

function coerce(param: OpParam, raw: unknown): unknown {
  if (param.type === "object") {
    if (raw && typeof raw === "object") return raw;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { /* plus bas */ }
    }
    throw new CallError(`Paramètre « ${param.name} » : objet JSON attendu.`, "blocked");
  }
  if (param.type === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new CallError(`Paramètre « ${param.name} » : nombre attendu.`, "blocked");
    return n;
  }
  if (param.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    if (["true", "1", "oui", "yes"].includes(s)) return true;
    if (["false", "0", "non", "no"].includes(s)) return false;
    throw new CallError(`Paramètre « ${param.name} » : booléen attendu.`, "blocked");
  }
  if (raw !== null && typeof raw === "object") throw new CallError(`Paramètre « ${param.name} » : texte attendu.`, "blocked");
  const s = String(raw);
  if (s.length > 4000) throw new CallError(`Paramètre « ${param.name} » trop long.`, "blocked");
  return s;
}

/** Les valeurs des paramètres déclarés : défauts, types, énumérations, motifs. */
export function resolveParams(op: ConnectorOperation, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of op.params ?? []) {
    let raw = input[param.name];
    if (raw === undefined || raw === null || raw === "") raw = param.default;
    if (raw === undefined || raw === null || raw === "") {
      if (param.required) throw new CallError(`Paramètre obligatoire manquant : « ${param.name} ».`, "blocked");
      continue;
    }
    const v = coerce(param, raw);
    if (param.enum?.length && !param.enum.includes(String(v))) {
      throw new CallError(`Paramètre « ${param.name} » : valeur hors liste (${param.enum.join(", ")}).`, "blocked");
    }
    if (param.pattern && typeof v === "string" && !new RegExp(`^(?:${param.pattern})$`).test(v)) {
      throw new CallError(`Paramètre « ${param.name} » : format refusé.`, "blocked");
    }
    out[param.name] = v;
  }
  return out;
}

/** Une valeur de segment de chemin : encodée, sans « . » ni « .. » qui remonteraient. */
function encodePathValue(v: string, allowSlash: boolean): string {
  const segs = allowSlash ? v.split("/").filter((s) => s !== "") : [v];
  for (const s of segs) {
    if (s === "." || s === "..") throw new CallError("Valeur de chemin refusée (« . » ou « .. »).", "blocked");
  }
  return segs.map((s) => encodeURIComponent(s)).join("/");
}

function renderPath(tpl: string, values: Record<string, unknown>, params: OpParam[]): string {
  return tpl.replace(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) return "";
    const def = params.find((p) => p.name === name);
    return encodePathValue(String(v), !!def?.allow_slash);
  });
}

/** null quand une valeur citée manque : la clé est alors omise. */
function renderText(tpl: string, values: Record<string, unknown>): string | null {
  const refs = placeholders(tpl);
  if (refs.some((r) => values[r] === undefined)) return null;
  return tpl.replace(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g, (_m, name: string) => {
    const v = values[name];
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

const OMIT = Symbol("omit");

function renderBody(v: unknown, values: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const exact = v.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (exact) return values[exact[1]] === undefined ? OMIT : values[exact[1]];
    const s = renderText(v, values);
    return s === null ? OMIT : s;
  }
  if (Array.isArray(v)) return v.map((x) => renderBody(x, values)).filter((x) => x !== OMIT);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = renderBody(x, values);
      if (r !== OMIT) out[k] = r;
    }
    return out;
  }
  return v;
}

/** Un argument de commande : pas de shell côté relais, et pas d'option injectée. */
const SAFE_ARG = /^[A-Za-z0-9._:/=@,+-]{0,256}$/;
function renderArgs(args: string[], values: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const a of args) {
    const refs = placeholders(a);
    if (!refs.length) { out.push(a); continue; }
    const missing = refs.filter((r) => values[r] === undefined);
    if (missing.length) {
      // Un argument entièrement fait d'un paramètre optionnel absent disparaît.
      if (a === `{${missing[0]}}` && refs.length === 1) continue;
      throw new CallError(`Paramètre manquant pour la commande : ${missing.join(", ")}.`, "blocked");
    }
    for (const r of refs) {
      const s = String(values[r]);
      if (!SAFE_ARG.test(s) || s.startsWith("-")) {
        throw new CallError(`Paramètre « ${r} » refusé pour une commande (caractères ou option interdits).`, "blocked");
      }
    }
    out.push(renderText(a, values)!);
  }
  return out;
}

function joinUrl(base: string, path: string): URL {
  let b: URL;
  try {
    b = new URL(base);
  } catch {
    throw new CallError("URL de base invalide.", "blocked");
  }
  const basePath = b.pathname.replace(/\/+$/, "");
  const u = new URL(b.origin + basePath + (path.startsWith("/") ? path : `/${path}`));
  if (u.origin !== b.origin) throw new CallError("Le chemin sort de l'hôte du connecteur.", "blocked");
  return u;
}

function globPrefix(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^?#]*");
  return new RegExp(`^${esc}`);
}

function checkRawPath(path: string, policy: ConnectorPolicy): void {
  if (!path.startsWith("/") || path.startsWith("//") || /\\|#|\?/.test(path)) {
    throw new CallError("Chemin brut invalide (commence par /, sans ? ni #, les paramètres vont dans query).", "blocked");
  }
  if (path.split("/").some((s) => s === ".." || s === "." || decodeURIComponent(s) === "..")) {
    throw new CallError("Chemin brut refusé (« .. »).", "blocked");
  }
  if (!policy.path_allowlist.length) {
    throw new CallError("Requête brute : aucun chemin autorisé n'est configuré sur ce connecteur.", "blocked");
  }
  if (!policy.path_allowlist.some((p) => globPrefix(p).test(path))) {
    throw new CallError(`Chemin hors de la liste autorisée (${policy.path_allowlist.join(", ")}).`, "blocked");
  }
  if (policy.path_denylist.some((p) => globPrefix(p).test(path))) {
    throw new CallError("Chemin explicitement interdit par la politique du connecteur.", "blocked");
  }
}

// ── Rédaction des secrets dans les réponses ──────────────────────────────────

const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie|session[-_]?id|^jwt$|bearer|access[-_]?key|signature|^pin$/i;
const NOT_SECRET_KEY = /(name|names|ref|id|ids|type|path|count|ttl|expir\w*|_at|enabled|fields|policies|policy|url|uri|kind|version|length)$/i;
const SECRET_VALUES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bhv[sbr]\.[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
];
const SECRET_ASSIGN = /\b(pass(?:word)?|secret|token|api[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi;
const MASK = "[masqué]";

function redactText(s: string, counter: { n: number }): string {
  let out = s;
  for (const re of SECRET_VALUES) {
    out = out.replace(re, () => { counter.n++; return MASK; });
  }
  out = out.replace(SECRET_ASSIGN, (_m, k: string, sep: string) => { counter.n++; return `${k}${sep}${MASK}`; });
  return out;
}

function redactJson(v: unknown, extra: RegExp | null, counter: { n: number }, key = ""): unknown {
  const keyIsSecret = !!key && !NOT_SECRET_KEY.test(key) && (SECRET_KEY.test(key) || (extra?.test(key) ?? false));
  if (typeof v === "string") {
    if (keyIsSecret && v) { counter.n++; return MASK; }
    return redactText(v, counter);
  }
  if (typeof v === "number" && keyIsSecret) { counter.n++; return MASK; }
  if (Array.isArray(v)) return v.map((x) => redactJson(x, extra, counter, key));
  if (v && typeof v === "object") {
    if (keyIsSecret && extra?.test(key)) { counter.n++; return MASK; }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactJson(x, extra, counter, k);
    return out;
  }
  return v;
}

/** Garde la forme (clés, longueurs de listes), masque toutes les valeurs. */
function keysOnly(v: unknown, counter: { n: number }): unknown {
  if (Array.isArray(v)) return v.map((x) => keysOnly(x, counter));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = keysOnly(x, counter);
    return out;
  }
  if (v === null || v === undefined) return v;
  counter.n++;
  return typeof v === "string" ? "•••" : `<${typeof v}>`;
}

// ── Transport ────────────────────────────────────────────────────────────────

/** La requête telle qu'elle est mise en file : marqueurs {{secret:x}}, aucun secret. */
export interface JobRequest {
  type: "http" | "exec";
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | null;
  binary?: string;
  args?: string[];
  timeout_ms: number;
  max_bytes: number;
  /** Le relais applique lui-même l'authentification du connecteur. */
  apply_auth: boolean;
  /** Comment substituer les marqueurs : brut, dans un formulaire, dans une chaîne JSON. */
  placeholder_encoding: "raw" | "form" | "json";
}

export interface TransportResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  duration_ms: number;
  error?: string;
}

/** Remplace {{secret:x}} par la valeur, encodée selon l'endroit où elle va. */
function fillSecrets(s: string, secrets: Record<string, string>, enc: JobRequest["placeholder_encoding"]): string {
  return s.replace(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g, (m, name: string) => {
    const v = secrets[name];
    if (v === undefined) return m;
    if (enc === "form") return encodeURIComponent(v);
    if (enc === "json") return JSON.stringify(v).slice(1, -1);
    return v;
  });
}

function fillRequest(req: JobRequest, secrets: Record<string, string>): JobRequest {
  const enc = req.placeholder_encoding;
  return {
    ...req,
    url: req.url ? fillSecrets(req.url, secrets, "form") : req.url,
    headers: req.headers
      ? Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, fillSecrets(v, secrets, "raw")]))
      : req.headers,
    body: typeof req.body === "string" ? fillSecrets(req.body, secrets, enc) : req.body,
    args: req.args?.map((a) => fillSecrets(a, secrets, "raw")),
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!res.body) return { text: "", truncated: false, bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(all), truncated, bytes };
}

/** En direct, depuis le cloud. Pas de redirection suivie : elle emporterait l'authentification. */
async function directFetch(req: JobRequest): Promise<TransportResult> {
  const verdict = await assertSafeUrl(req.url ?? "");
  if (!verdict.ok) {
    throw new CallError(
      `Hôte injoignable en direct : ${verdict.reason}. Un outil sur une URL interne passe par le relais déployé chez vous.`,
      "blocked",
    );
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeout_ms);
  try {
    const res = await fetch(req.url!, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body ?? undefined,
      redirect: "manual",
      signal: ctrl.signal,
    });
    const { text, truncated } = await readCapped(res, req.max_bytes);
    const headers: Record<string, string> = {};
    for (const k of ["content-type", "location", "retry-after", "x-request-id"]) {
      const v = res.headers.get(k);
      if (v) headers[k] = v;
    }
    return { status: res.status, headers, body: text, truncated, duration_ms: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? `délai dépassé (${req.timeout_ms} ms)` : e instanceof Error ? e.message : String(e);
    throw new CallError(`Appel impossible : ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

const RELAY_STALE_MS = 90_000;

/** Par le relais : mise en file, puis attente du résultat (chiffré au repos). */
async function relayRoundTrip(
  admin: SupabaseClient,
  c: ConnectorRow,
  credentialId: string | null,
  req: JobRequest,
): Promise<TransportResult & { relay_name: string }> {
  if (!c.relay_id) throw new CallError("Aucun relais n'est rattaché à ce connecteur.", "blocked");
  const { data: relay } = await admin.from("connector_relays")
    .select("id, workspace_id, project_id, name, status, last_seen_at").eq("id", c.relay_id).maybeSingle();
  const r = relay as RelayRow | null;
  if (!r || r.status !== "active") throw new CallError("Le relais de ce connecteur est révoqué ou introuvable.", "blocked");
  if (r.workspace_id !== c.workspace_id) throw new CallError("Relais d'un autre espace.", "blocked");
  const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : 0;
  if (Date.now() - seen > RELAY_STALE_MS) {
    const since = seen ? `dernier contact ${new Date(seen).toISOString()}` : "jamais connecté";
    throw new CallError(`Le relais « ${r.name} » est hors ligne (${since}). Vérifiez son déploiement.`);
  }

  const waitMs = Math.min(req.timeout_ms + 8_000, 60_000);
  const { data: job, error } = await admin.from("connector_relay_jobs").insert({
    relay_id: r.id, workspace_id: c.workspace_id, connector_id: c.id, credential_id: credentialId,
    request: req, expires_at: new Date(Date.now() + waitMs).toISOString(),
  }).select("id").single();
  if (error || !job) throw new CallError(`File du relais indisponible : ${error?.message ?? "inconnu"}`);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(350);
    const { data: row } = await admin.from("connector_relay_jobs")
      .select("status, result_enc, result_iv").eq("id", job.id).maybeSingle();
    const st = (row as { status?: string } | null)?.status;
    if (st === "done" || st === "error") {
      const enc = row as { result_enc: string | null; result_iv: string | null };
      let result: TransportResult = { status: 0, headers: {}, body: "", truncated: false, duration_ms: 0, error: "réponse vide" };
      if (enc.result_enc && enc.result_iv) {
        try { result = JSON.parse(await decryptSecret(enc.result_enc, enc.result_iv)); } catch { /* garde le défaut */ }
      }
      // La réponse a été lue : elle n'a plus rien à faire en base.
      await admin.from("connector_relay_jobs").update({ result_enc: null, result_iv: null }).eq("id", job.id);
      if (st === "error" && !result.status) throw new CallError(`Le relais a échoué : ${result.error ?? "erreur inconnue"}`);
      return { ...result, relay_name: r.name };
    }
    if (st === "expired") break;
  }
  await admin.from("connector_relay_jobs").update({ status: "expired" }).eq("id", job.id).in("status", ["queued", "claimed"]);
  throw new CallError(`Le relais « ${r.name} » n'a pas répondu à temps.`);
}

// ── Identifiants ─────────────────────────────────────────────────────────────

async function loadCredentials(admin: SupabaseClient, connectorId: string): Promise<CredentialRow[]> {
  const { data } = await admin.from("custom_connector_credentials").select("*")
    .eq("connector_id", connectorId).eq("status", "active").order("created_at");
  return (data ?? []) as CredentialRow[];
}

async function payloadOf(cred: CredentialRow): Promise<Record<string, string>> {
  if (cred.location !== "cloud" || !cred.encrypted_payload || !cred.iv) return {};
  try {
    return JSON.parse(await decryptSecret(cred.encrypted_payload, cred.iv));
  } catch {
    throw new CallError("Identifiant illisible (clé de chiffrement changée ?) : ressaisissez-le.");
  }
}

interface TokenCache { access_token?: string; refresh_token?: string; id_token?: string }

async function tokenCacheOf(cred: CredentialRow): Promise<TokenCache> {
  if (!cred.token_enc || !cred.token_iv) return {};
  try {
    return JSON.parse(await decryptSecret(cred.token_enc, cred.token_iv));
  } catch {
    return {};
  }
}

async function storeToken(admin: SupabaseClient, credId: string, tok: TokenCache, ttlSeconds: number): Promise<void> {
  const { ciphertext, iv } = await encryptSecret(JSON.stringify(tok));
  await admin.from("custom_connector_credentials").update({
    token_enc: ciphertext, token_iv: iv,
    token_expires_at: new Date(Date.now() + Math.max(ttlSeconds - 30, 30) * 1000).toISOString(),
  }).eq("id", credId);
}

async function clearToken(admin: SupabaseClient, credId: string): Promise<void> {
  await admin.from("custom_connector_credentials")
    .update({ token_enc: null, token_iv: null, token_expires_at: null }).eq("id", credId);
}

function tokenFresh(cred: CredentialRow): boolean {
  return !!cred.token_enc && !!cred.token_expires_at && Date.parse(cred.token_expires_at) > Date.now() + 15_000;
}

/** Toutes les valeurs qu'un marqueur {{secret:x}} peut désigner. */
async function secretsFor(cred: CredentialRow | null): Promise<Record<string, string>> {
  if (!cred) return {};
  const base = await payloadOf(cred);
  const tok = await tokenCacheOf(cred);
  const extra: Record<string, string> = {};
  if (tok.access_token) extra.access_token = tok.access_token;
  if (tok.refresh_token) extra.refresh_token = tok.refresh_token;
  return { ...base, ...extra };
}

function parseJsonLoose(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** Demande de jeton au serveur OAuth (formulaire), secret en marqueur. */
function tokenRequest(c: ConnectorRow, form: Record<string, string>, withSecret: boolean): JobRequest {
  const cfg = normalizeAuthConfig(c.auth_config);
  const parts = Object.entries(form).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (withSecret && cfg.client_auth === "basic") {
    headers.Authorization = `Basic {{secret:__basic_client}}`;
  } else if (withSecret) {
    parts.push("client_secret={{secret:client_secret}}");
  }
  return {
    type: "http", method: "POST", url: cfg.token_url, headers, body: parts.join("&"),
    timeout_ms: 20_000, max_bytes: 64 * 1024, apply_auth: false, placeholder_encoding: "form",
  };
}

/** Une requête d'authentification, par le même chemin que les appels. */
async function authTransport(
  admin: SupabaseClient, c: ConnectorRow, cred: CredentialRow | null, req: JobRequest,
): Promise<TransportResult> {
  if (c.transport === "relay") return await relayRoundTrip(admin, c, cred?.id ?? null, req);
  const secrets = await secretsFor(cred);
  const cfg = normalizeAuthConfig(c.auth_config);
  if (secrets.client_secret !== undefined && cfg.client_id) {
    secrets.__basic_client = btoa(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(secrets.client_secret)}`);
  }
  return await directFetch(fillRequest(req, secrets));
}

function tokenFromResponse(res: TransportResult, what: string): { json: Record<string, unknown> } {
  const json = parseJsonLoose(res.body) as Record<string, unknown> | null;
  if (res.status < 200 || res.status >= 300 || !json) {
    const detail = json && typeof json === "object"
      ? String((json as Record<string, unknown>).error_description ?? (json as Record<string, unknown>).error ?? "")
      : res.body.slice(0, 200);
    throw new CallError(`${what} refusé (HTTP ${res.status}) ${detail}`.trim());
  }
  return { json };
}

/** SSO utilisateur : jeton d'accès valide, rafraîchi au besoin. */
async function ensureAuthCodeToken(admin: SupabaseClient, c: ConnectorRow, cred: CredentialRow): Promise<string> {
  const tok = await tokenCacheOf(cred);
  if (tokenFresh(cred) && tok.access_token) return tok.access_token;
  if (!tok.refresh_token) {
    throw new CallError("Session SSO expirée : reconnectez-vous depuis la fiche du connecteur.", "blocked");
  }
  const cfg = normalizeAuthConfig(c.auth_config);
  const hasSecret = !!(await payloadOf(cred)).client_secret || cred.location === "relay";
  const req = tokenRequest(c, {
    grant_type: "refresh_token", client_id: cfg.client_id ?? "",
  }, hasSecret);
  req.body = `${req.body}&refresh_token={{secret:refresh_token}}`;
  const res = await authTransport(admin, c, cred, req);
  const { json } = tokenFromResponse(res, "Rafraîchissement SSO");
  const access = String(json.access_token ?? "");
  if (!access) throw new CallError("Le serveur SSO n'a pas renvoyé de jeton.");
  await storeToken(admin, cred.id, {
    access_token: access,
    refresh_token: String(json.refresh_token ?? tok.refresh_token),
    id_token: tok.id_token,
  }, Number(json.expires_in) || 300);
  return access;
}

async function clientCredentialsToken(admin: SupabaseClient, c: ConnectorRow, cred: CredentialRow): Promise<string> {
  const tok = await tokenCacheOf(cred);
  if (tokenFresh(cred) && tok.access_token) return tok.access_token;
  const cfg = normalizeAuthConfig(c.auth_config);
  const res = await authTransport(admin, c, cred, tokenRequest(c, {
    grant_type: "client_credentials",
    client_id: cfg.client_auth === "basic" ? "" : cfg.client_id ?? "",
    scope: cfg.scope ?? "", audience: cfg.audience ?? "",
  }, true));
  const { json } = tokenFromResponse(res, "Obtention du jeton SSO");
  const access = String(json.access_token ?? "");
  if (!access) throw new CallError("Le serveur SSO n'a pas renvoyé de jeton.");
  await storeToken(admin, cred.id, { access_token: access }, Number(json.expires_in) || 300);
  return access;
}

async function sessionToken(admin: SupabaseClient, c: ConnectorRow, cred: CredentialRow): Promise<string> {
  const tok = await tokenCacheOf(cred);
  if (tokenFresh(cred) && tok.access_token) return tok.access_token;
  const cfg = normalizeAuthConfig(c.auth_config);
  const loginUrl = /^https?:/i.test(cfg.login_path ?? "") ? cfg.login_path! : joinUrl(c.base_url, cfg.login_path ?? "/").toString();
  const res = await authTransport(admin, c, cred, {
    type: "http", method: cfg.login_method ?? "POST", url: loginUrl,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(cfg.extra_headers ?? {}) },
    body: JSON.stringify(cfg.login_body ?? {}),
    timeout_ms: 20_000, max_bytes: 64 * 1024, apply_auth: false, placeholder_encoding: "json",
  });
  const json = parseJsonLoose(res.body);
  if (res.status < 200 || res.status >= 300 || !json) throw new CallError(`Connexion refusée (HTTP ${res.status}).`);
  const access = String(getPath(json, cfg.token_path || "token") ?? "");
  if (!access) throw new CallError(`Pas de jeton à l'emplacement « ${cfg.token_path || "token"} » de la réponse de connexion.`);
  const ttl = Number(cfg.ttl_path ? getPath(json, cfg.ttl_path) : undefined) || cfg.ttl_seconds || 1800;
  await storeToken(admin, cred.id, { access_token: access }, ttl);
  return access;
}

/** Pose l'authentification sur une requête directe. */
async function applyDirectAuth(
  admin: SupabaseClient, c: ConnectorRow, cred: CredentialRow | null, req: JobRequest,
): Promise<JobRequest> {
  const scheme = c.auth_scheme;
  if (scheme === "none") return req;
  if (!cred) throw new CallError("Aucun identifiant enregistré pour ce connecteur.", "blocked");
  if (cred.location === "relay") throw new CallError("Ce secret est détenu par le relais : le connecteur doit passer par le relais.", "blocked");
  if (scheme === "mtls") throw new CallError("Le mTLS exige le transport par relais.", "blocked");
  const cfg = normalizeAuthConfig(c.auth_config);
  const s = await payloadOf(cred);
  const headers = { ...(req.headers ?? {}) };
  let url = req.url ?? "";
  const need = (k: string) => {
    if (!s[k]) throw new CallError(`Identifiant incomplet : champ « ${k} » manquant.`, "blocked");
    return s[k];
  };
  switch (scheme) {
    case "bearer":
      headers[cfg.header || "Authorization"] = `${cfg.prefix ?? "Bearer "}${need("token")}`;
      break;
    case "api_key":
      if (cfg.in === "query") {
        const u = new URL(url);
        u.searchParams.set(cfg.name || "api_key", need("key"));
        url = u.toString();
      } else {
        headers[cfg.name || "X-API-Key"] = need("key");
      }
      break;
    case "basic": {
      const user = s.username ?? cfg.username ?? "";
      const bytes = new TextEncoder().encode(`${user}:${need("password")}`);
      headers.Authorization = `Basic ${btoa(String.fromCharCode(...bytes))}`;
      break;
    }
    case "headers":
      for (const h of cfg.header_names ?? []) headers[h] = need(h);
      break;
    case "oauth2_client_credentials":
      headers.Authorization = `Bearer ${await clientCredentialsToken(admin, c, cred)}`;
      break;
    case "oauth2_authorization_code":
      headers.Authorization = `Bearer ${await ensureAuthCodeToken(admin, c, cred)}`;
      break;
    case "session_login":
      headers[cfg.header || "Authorization"] = `${cfg.prefix ?? "Bearer "}${await sessionToken(admin, c, cred)}`;
      break;
  }
  return { ...req, url, headers };
}

// ── L'appel ──────────────────────────────────────────────────────────────────

export interface CallInput {
  connectorId: string;
  /** Nom d'opération déclarée, ou « request » pour la requête brute. */
  operation: string;
  params?: Record<string, unknown>;
  raw?: { method?: string; path?: string; query?: Record<string, unknown>; body?: unknown };
  credentialId?: string | null;
  /** Les opérations accordées au collaborateur (vide : toutes). */
  allowedOperations?: string[] | null;
  source: "collaborator" | "approval" | "test" | "assistant";
  agentId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  actorUserId?: string | null;
  approvalId?: string | null;
  /** Test d'une écriture depuis l'interface : accord explicite. */
  confirm?: boolean;
}

export interface CallOutcome {
  ok: boolean;
  decision: "allowed" | "approved" | "blocked" | "error";
  status?: number;
  /** Ce que lit le modèle (ou la personne qui teste). */
  text: string;
  call_id: string;
  duration_ms?: number;
  redactions?: number;
  risk?: Risk;
}

interface AuditDraft {
  workspace_id: string;
  project_id: string | null;
  connector_id: string | null;
  connector_name: string | null;
  connector_version: number | null;
  credential_id?: string | null;
  credential_label?: string | null;
  identity?: string | null;
  operation?: string | null;
  method?: string | null;
  target?: string | null;
  transport?: string | null;
  relay_id?: string | null;
  source: CallInput["source"];
  agent_id?: string | null;
  agent_name?: string | null;
  run_id?: string | null;
  conversation_id?: string | null;
  actor_user_id?: string | null;
  approval_id?: string | null;
  decision: CallOutcome["decision"];
  risk?: string | null;
  status_code?: number | null;
  duration_ms?: number | null;
  request_bytes?: number | null;
  response_bytes?: number | null;
  redactions?: number;
  error?: string | null;
}

async function audit(admin: SupabaseClient, id: string, row: AuditDraft): Promise<void> {
  const { error } = await admin.from("custom_connector_calls").insert({ id, ...row, error: row.error?.slice(0, 500) ?? null });
  if (error) console.error("custom_connector_calls insert", error.message);
}

export async function loadConnector(admin: SupabaseClient, id: string): Promise<ConnectorRow | null> {
  const { data } = await admin.from("custom_connectors").select(CONNECTOR_COLS).eq("id", id).maybeSingle();
  return (data as ConnectorRow | null) ?? null;
}

const RAW_OP: ConnectorOperation = { name: "request", description: "Requête brute", risk: "read", params: [] };

export async function executeCall(admin: SupabaseClient, input: CallInput): Promise<CallOutcome> {
  const callId = crypto.randomUUID();
  const c = await loadConnector(admin, input.connectorId);
  if (!c) return { ok: false, decision: "blocked", text: "ERREUR : connecteur introuvable.", call_id: callId };

  const policy = normalizePolicy(c.policy);
  const draft: AuditDraft = {
    workspace_id: c.workspace_id, project_id: c.project_id,
    connector_id: c.id, connector_name: c.name, connector_version: c.version,
    operation: input.operation, transport: c.transport, relay_id: c.transport === "relay" ? c.relay_id : null,
    source: input.source, agent_id: input.agentId ?? null, run_id: input.runId ?? null,
    conversation_id: input.conversationId ?? null, actor_user_id: input.actorUserId ?? null,
    approval_id: input.approvalId ?? null, decision: "error",
  };

  try {
    if (c.status !== "active" && input.source !== "test") {
      throw new CallError(c.status === "disabled" ? "Ce connecteur est désactivé." : "Ce connecteur est un brouillon, pas encore activé.", "blocked");
    }

    // Qui appelle, et en a-t-il le droit ?
    if (input.agentId) {
      const { data: ag } = await admin.from("internal_agents")
        .select("name, project_id, service_dashboard_id").eq("id", input.agentId).maybeSingle();
      const agent = ag as { name: string; project_id: string; service_dashboard_id: string | null } | null;
      if (!agent || agent.project_id !== c.project_id) throw new CallError("Ce collaborateur n'appartient pas au projet du connecteur.", "blocked");
      draft.agent_name = agent.name;
      if (c.service_dashboard_id && agent.service_dashboard_id !== c.service_dashboard_id) {
        throw new CallError("Ce connecteur est réservé aux collaborateurs d'un autre service.", "blocked");
      }
    }

    // L'opération.
    const ops = normalizeOperations(c.operations);
    let op: ConnectorOperation;
    if (input.operation === "request") {
      if (!policy.allow_raw) throw new CallError("La requête brute n'est pas autorisée sur ce connecteur.", "blocked");
      const method = String(input.raw?.method ?? "GET").toUpperCase();
      if (!policy.raw_methods.includes(method as never)) {
        throw new CallError(`Méthode ${method} non autorisée en requête brute (${policy.raw_methods.join(", ")}).`, "blocked");
      }
      const path = String(input.raw?.path ?? "");
      checkRawPath(path, policy);
      op = { ...RAW_OP, method: method as ConnectorOperation["method"], path, risk: method === "GET" || method === "HEAD" ? "read" : "write" };
    } else {
      const found = ops.find((o) => o.name === input.operation);
      if (!found) throw new CallError(`Opération inconnue : « ${input.operation} ». Disponibles : ${ops.map((o) => o.name).join(", ")}.`, "blocked");
      op = found;
    }
    if (input.allowedOperations?.length && !input.allowedOperations.includes(op.name)) {
      throw new CallError(`L'opération « ${op.name} » n'est pas accordée à ce collaborateur.`, "blocked");
    }
    draft.risk = op.risk;

    // La politique.
    if (policy.read_only && op.risk !== "read") throw new CallError("Connecteur en lecture seule : opération d'écriture refusée.", "blocked");
    if (input.source === "collaborator" && (op.risk === "destructive" || policy.approval === "all")) {
      // Plancher dur : le runtime ne contourne pas l'approbation d'un geste destructif.
      throw new CallError("Cette opération exige une approbation humaine.", "blocked");
    }
    if (input.source === "test" && op.risk !== "read" && !input.confirm) {
      throw new CallError("Test d'une opération d'écriture : confirmation explicite requise.", "blocked");
    }
    if (input.source === "approval" || input.source === "test") draft.decision = "approved";

    const { count } = await admin.from("custom_connector_calls")
      .select("seq", { count: "exact", head: true })
      .eq("connector_id", c.id).in("decision", ["allowed", "approved"])
      .gte("created_at", new Date(Date.now() - 60_000).toISOString());
    if ((count ?? 0) >= policy.rate_limit_per_min) {
      throw new CallError(`Débit maximal atteint (${policy.rate_limit_per_min} appels par minute).`, "blocked");
    }

    // L'identifiant.
    let cred: CredentialRow | null = null;
    if (c.auth_scheme !== "none") {
      const creds = await loadCredentials(admin, c.id);
      cred = input.credentialId ? creds.find((x) => x.id === input.credentialId) ?? null : creds[0] ?? null;
      if (!cred) {
        throw new CallError(input.credentialId ? "Le profil d'identifiants accordé n'existe plus ou a été révoqué." : "Aucun identifiant enregistré pour ce connecteur.", "blocked");
      }
      draft.credential_id = cred.id;
      draft.credential_label = cred.label;
      draft.identity = cred.identity;
      if (input.agentId && (cred.allowed_agent_ids ?? []).length && !cred.allowed_agent_ids!.includes(input.agentId)) {
        throw new CallError(`Le profil « ${cred.label} » n'est pas ouvert à ce collaborateur.`, "blocked");
      }
      if (cred.expires_at && Date.parse(cred.expires_at) < Date.now()) {
        throw new CallError(`Le profil « ${cred.label} » a expiré : renouvelez le secret.`, "blocked");
      }
      if (cred.binding !== await computeBinding(c)) {
        throw new CallError("L'URL du connecteur ou de son serveur d'identité a changé depuis la saisie du secret : ressaisissez-le.", "blocked");
      }
    }

    // La requête.
    const values = resolveParams(op, {
      ...(input.params ?? {}),
    });
    const timeout = op.timeout_ms ?? 30_000;
    const maxBytes = policy.max_response_kb * 1024;
    let req: JobRequest;
    if (op.kind === "exec") {
      if (c.transport !== "relay") throw new CallError("Une commande ne s'exécute que sur le relais.", "blocked");
      const args = renderArgs(op.args ?? [], values);
      req = { type: "exec", binary: op.binary, args, timeout_ms: timeout, max_bytes: maxBytes, apply_auth: false, placeholder_encoding: "raw" };
      draft.method = "EXEC";
      draft.target = `${op.binary} ${args.join(" ")}`.slice(0, 300);
    } else {
      const cfg = normalizeAuthConfig(c.auth_config);
      const path = op.name === "request" ? op.path! : renderPath(op.path ?? "/", values, op.params ?? []);
      const url = joinUrl(c.base_url, path);
      const queryTpl: Record<string, unknown> = op.name === "request" ? (input.raw?.query ?? {}) : (op.query ?? {});
      for (const [k, v] of Object.entries(queryTpl)) {
        const s = op.name === "request" ? (v === undefined || v === null ? null : String(v)) : renderText(String(v), values);
        if (s !== null && s !== "") url.searchParams.append(k, s);
      }
      const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
      for (const [k, v] of Object.entries(cfg.extra_headers ?? {})) if (v) headers[k] = v;
      for (const [k, v] of Object.entries(op.headers ?? {})) {
        const s = renderText(v, values);
        if (s) headers[k] = s;
      }
      if (policy.trace_headers) {
        headers["X-Request-Id"] = callId;
        headers["X-FounderOS-Call"] = callId;
        if (draft.agent_name) headers["X-FounderOS-Collaborator"] = headerSafe(draft.agent_name);
        if (input.runId) headers["X-FounderOS-Run"] = input.runId;
      }
      let body: string | null = null;
      const method = (op.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        const tpl = op.name === "request" ? input.raw?.body : op.body;
        if (tpl !== undefined && tpl !== null) {
          const rendered = op.name === "request" ? tpl : renderBody(tpl, values);
          body = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
          headers["Content-Type"] = op.content_type || "application/json";
        }
      }
      req = {
        type: "http", method, url: url.toString(), headers, body,
        timeout_ms: timeout, max_bytes: maxBytes, apply_auth: c.auth_scheme !== "none", placeholder_encoding: "raw",
      };
      draft.method = method;
      draft.target = url.pathname.slice(0, 300);
      draft.request_bytes = body ? new TextEncoder().encode(body).byteLength : 0;
    }

    // Le transport.
    let res: TransportResult & { relay_name?: string };
    if (c.transport === "relay") {
      if (c.auth_scheme === "oauth2_authorization_code" && cred) {
        await ensureAuthCodeToken(admin, c, cred);
      }
      res = await relayRoundTrip(admin, c, cred?.id ?? null, req);
    } else {
      const authed = await applyDirectAuth(admin, c, cred, req);
      res = await directFetch(authed);
      // Jeton de session ou SSO périmé côté outil : une seconde chance, jeton neuf.
      if (res.status === 401 && cred && ["session_login", "oauth2_client_credentials", "oauth2_authorization_code"].includes(c.auth_scheme)) {
        if (c.auth_scheme !== "oauth2_authorization_code") {
          await clearToken(admin, cred.id);
          const fresh = (await loadCredentials(admin, c.id)).find((x) => x.id === cred!.id) ?? cred;
          res = await directFetch(await applyDirectAuth(admin, c, fresh, req));
        }
      }
    }

    // La réponse, rédigée.
    const counter = { n: 0 };
    const mode = op.output ?? policy.output;
    const extra = policy.redact_fields.length
      ? new RegExp(`^(${policy.redact_fields.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "i")
      : null;
    const json = parseJsonLoose(res.body);
    let shown: string;
    if (json !== null && typeof json === "object") {
      const v = mode === "keys_only" ? keysOnly(json, counter) : mode === "full" ? json : redactJson(json, extra, counter);
      shown = JSON.stringify(v);
    } else {
      shown = mode === "full" ? res.body : redactText(res.body, counter);
      if (mode === "keys_only") shown = `(réponse non JSON de ${shown.length} caractères, contenu masqué)`;
    }
    const capChars = 12_000;
    const cut = shown.length > capChars;
    if (cut) shown = shown.slice(0, capChars);

    draft.status_code = res.status;
    draft.duration_ms = res.duration_ms;
    draft.response_bytes = new TextEncoder().encode(res.body).byteLength;
    draft.redactions = counter.n;
    if (draft.decision !== "approved") draft.decision = "allowed";
    const ok = res.status >= 200 && res.status < 400;
    if (!ok) draft.error = res.error ?? `HTTP ${res.status}`;
    await audit(admin, callId, draft);
    if (cred) {
      admin.from("custom_connector_credentials").update({ last_used_at: new Date().toISOString() }).eq("id", cred.id).then(() => {}, () => {});
    }

    const head = [
      op.kind === "exec" ? `Commande ${res.status === 200 ? "réussie" : `en échec (${res.status})`}` : `HTTP ${res.status}`,
      `${res.duration_ms} ms`,
      res.relay_name ? `via le relais « ${res.relay_name} »` : null,
      counter.n ? `${counter.n} valeur(s) masquée(s)` : null,
      res.truncated || cut ? "réponse tronquée" : null,
      res.headers?.location ? `redirection vers ${res.headers.location} (non suivie)` : null,
    ].filter(Boolean).join(" · ");
    return {
      ok, decision: draft.decision, status: res.status, call_id: callId,
      duration_ms: res.duration_ms, redactions: counter.n, risk: op.risk,
      text: `${head}\n${shown || "(réponse vide)"}`,
    };
  } catch (e) {
    const ce = e instanceof CallError ? e : new CallError(e instanceof Error ? e.message : String(e));
    draft.decision = ce.decision;
    draft.error = ce.message;
    await audit(admin, callId, draft);
    return { ok: false, decision: ce.decision, call_id: callId, text: `${ce.decision === "blocked" ? "REFUSÉ" : "ERREUR"} : ${ce.message}` };
  }
}

// ── Gestion des identifiants (interface, owner/admin) ────────────────────────

const REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\s]+)$/;

export interface SaveCredentialInput {
  connectorId: string;
  credentialId?: string | null;
  label?: string;
  location?: "cloud" | "relay";
  secrets?: Record<string, string>;
  relayRefs?: Record<string, string>;
  identity?: string | null;
  expiresAt?: string | null;
  allowedAgentIds?: string[];
  userId: string;
}

export async function saveCredential(admin: SupabaseClient, input: SaveCredentialInput): Promise<{ id: string }> {
  const c = await loadConnector(admin, input.connectorId);
  if (!c) throw new Error("Connecteur introuvable.");
  const cfg = normalizeAuthConfig(c.auth_config);
  const fields = secretFieldsFor(c.auth_scheme, cfg);
  if (c.auth_scheme === "basic") fields.push({ name: "username", label: "Identifiant", optional: true });
  const location = input.location ?? "cloud";
  if (location === "relay" && c.transport !== "relay") throw new Error("Un secret détenu par le relais suppose un connecteur qui passe par le relais.");
  if (location === "relay" && c.auth_scheme === "oauth2_authorization_code") throw new Error("Le SSO utilisateur garde ses jetons dans le cloud : emplacement « relais » impossible.");

  let existing: CredentialRow | null = null;
  if (input.credentialId) {
    const { data } = await admin.from("custom_connector_credentials").select("*")
      .eq("id", input.credentialId).eq("connector_id", c.id).maybeSingle();
    existing = data as CredentialRow | null;
    if (!existing) throw new Error("Profil d'identifiants introuvable.");
  }
  const binding = await computeBinding(c);
  const fresh = Object.fromEntries(Object.entries(input.secrets ?? {}).filter(([, v]) => typeof v === "string" && v !== ""));
  const required = fields.filter((f) => !f.optional).map((f) => f.name);

  const row: Record<string, unknown> = {
    connector_id: c.id, workspace_id: c.workspace_id,
    label: (input.label ?? existing?.label ?? "Par défaut").slice(0, 80),
    location, binding,
    identity: input.identity === undefined ? existing?.identity ?? null : (input.identity || null),
    expires_at: input.expiresAt === undefined ? existing?.expires_at ?? null : (input.expiresAt || null),
    allowed_agent_ids: input.allowedAgentIds ?? existing?.allowed_agent_ids ?? [],
    token_enc: null, token_iv: null, token_expires_at: null,
  };

  if (location === "cloud") {
    const rebound = existing && existing.binding !== binding;
    const prev = existing && existing.location === "cloud" ? await payloadOf(existing) : {};
    // Après un changement d'URL, on ne recycle pas l'ancien secret : il doit être ressaisi.
    const merged = rebound ? fresh : { ...prev, ...fresh };
    const missing = required.filter((k) => !merged[k]);
    if (missing.length) {
      throw new Error(rebound
        ? `L'URL a changé depuis la saisie : ressaisissez ${missing.join(", ")}.`
        : `Champs secrets manquants : ${missing.join(", ")}.`);
    }
    const allowed = new Set(fields.map((f) => f.name));
    const payload = Object.fromEntries(Object.entries(merged).filter(([k]) => allowed.has(k)));
    const { ciphertext, iv } = await encryptSecret(JSON.stringify(payload));
    row.encrypted_payload = ciphertext;
    row.iv = iv;
    row.relay_refs = {};
    row.hints = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, k === "username" ? v : hintOf(v)]));
  } else {
    const refs: Record<string, string> = Object.fromEntries(
      Object.entries(input.relayRefs ?? {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v),
    );
    for (const [k, v] of Object.entries(refs)) {
      if (!REF.test(v)) throw new Error(`Référence invalide pour « ${k} » : env:NOM_DE_VARIABLE ou file:/chemin/absolu.`);
    }
    const missing = required.filter((k) => !refs[k]);
    if (missing.length) throw new Error(`Références manquantes : ${missing.join(", ")}.`);
    row.encrypted_payload = null;
    row.iv = null;
    row.relay_refs = refs;
    row.hints = refs;
  }

  if (existing) {
    row.rotated_at = new Date().toISOString();
    const { error } = await admin.from("custom_connector_credentials").update(row).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { id: existing.id };
  }
  const { data, error } = await admin.from("custom_connector_credentials")
    .insert({ ...row, created_by: input.userId }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "Enregistrement impossible.");
  return { id: (data as { id: string }).id };
}

// ── SSO utilisateur : autorisation par code + PKCE ───────────────────────────

export async function oauthStart(admin: SupabaseClient, input: {
  connectorId: string; label: string; redirectUri: string; clientSecret?: string; userId: string;
}): Promise<{ authorize_url: string }> {
  const c = await loadConnector(admin, input.connectorId);
  if (!c) throw new Error("Connecteur introuvable.");
  if (c.auth_scheme !== "oauth2_authorization_code") throw new Error("Ce connecteur n'utilise pas le SSO utilisateur.");
  const cfg = normalizeAuthConfig(c.auth_config);
  if (!cfg.authorize_url || !cfg.token_url || !cfg.client_id) throw new Error("authorize_url, token_url et client_id sont requis.");
  const { verifier, challenge } = await pkce();
  const state = `ccx_${randomState()}`;
  const { ciphertext, iv } = await encryptSecret(JSON.stringify({ verifier, client_secret: input.clientSecret ?? "" }));
  await admin.from("custom_connector_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("custom_connector_oauth_states").insert({
    state, connector_id: c.id, workspace_id: c.workspace_id, label: input.label.slice(0, 80) || "SSO",
    verifier_enc: ciphertext, verifier_iv: iv, redirect_uri: input.redirectUri, created_by: input.userId,
  });
  if (error) throw new Error(error.message);
  const u = new URL(cfg.authorize_url);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.client_id);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("scope", cfg.scope || "openid profile email offline_access");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (cfg.audience) u.searchParams.set("audience", cfg.audience);
  return { authorize_url: u.toString() };
}

function identityFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
    return String(claims.email ?? claims.preferred_username ?? claims.upn ?? claims.sub ?? "") || null;
  } catch {
    return null;
  }
}

export async function oauthCallback(admin: SupabaseClient, input: { code: string; state: string; userId: string }): Promise<{ connector_id: string; identity: string | null }> {
  const { data: st } = await admin.from("custom_connector_oauth_states").select("*").eq("state", input.state).maybeSingle();
  if (!st) throw new Error("Autorisation inconnue ou déjà utilisée.");
  await admin.from("custom_connector_oauth_states").delete().eq("state", input.state);
  const s = st as { connector_id: string; label: string; verifier_enc: string; verifier_iv: string; redirect_uri: string; created_by: string; created_at: string };
  if (Date.now() - Date.parse(s.created_at) > 15 * 60_000) throw new Error("Autorisation expirée : recommencez.");
  if (s.created_by !== input.userId) throw new Error("Cette autorisation a été lancée par une autre personne.");
  const c = await loadConnector(admin, s.connector_id);
  if (!c) throw new Error("Connecteur introuvable.");
  const cfg = normalizeAuthConfig(c.auth_config);
  const { verifier, client_secret } = JSON.parse(await decryptSecret(s.verifier_enc, s.verifier_iv)) as { verifier: string; client_secret: string };

  // Le secret client entre dans un profil d'abord : l'échange par le relais le
  // désigne alors par marqueur, jamais en clair dans la file.
  const { data: prior } = await admin.from("custom_connector_credentials").select("id")
    .eq("connector_id", c.id).eq("label", s.label).eq("status", "active").maybeSingle();
  const { id: credId } = await saveCredential(admin, {
    connectorId: c.id, credentialId: (prior as { id?: string } | null)?.id ?? null, label: s.label,
    location: "cloud", secrets: client_secret ? { client_secret } : {}, userId: input.userId,
  });
  const { data: credRow } = await admin.from("custom_connector_credentials").select("*").eq("id", credId).single();
  const cred = credRow as CredentialRow;

  const req = tokenRequest(c, {
    grant_type: "authorization_code", code: input.code, redirect_uri: s.redirect_uri,
    client_id: cfg.client_auth === "basic" && client_secret ? "" : cfg.client_id ?? "", code_verifier: verifier,
  }, !!client_secret);
  let res: TransportResult;
  try {
    res = await authTransport(admin, c, cred, req);
  } catch (e) {
    if (!prior) await admin.from("custom_connector_credentials").delete().eq("id", credId);
    throw e;
  }
  let json: Record<string, unknown>;
  try {
    ({ json } = tokenFromResponse(res, "Échange du code SSO"));
  } catch (e) {
    if (!prior) await admin.from("custom_connector_credentials").delete().eq("id", credId);
    throw e;
  }
  const idToken = typeof json.id_token === "string" ? json.id_token : undefined;
  const identity = identityFromIdToken(idToken);
  await storeToken(admin, credId, {
    access_token: String(json.access_token ?? ""), refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined, id_token: idToken,
  }, Number(json.expires_in) || 300);
  if (identity) await admin.from("custom_connector_credentials").update({ identity: `${identity} (SSO)` }).eq("id", credId);
  return { connector_id: c.id, identity };
}

/** Lit la configuration OIDC d'un émetteur (par le relais si le connecteur y passe). */
export async function discoverOidc(admin: SupabaseClient, connectorId: string, issuer: string): Promise<Record<string, string>> {
  const c = await loadConnector(admin, connectorId);
  if (!c) throw new Error("Connecteur introuvable.");
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await authTransport(admin, c, null, {
    type: "http", method: "GET", url, headers: { Accept: "application/json" }, body: null,
    timeout_ms: 15_000, max_bytes: 128 * 1024, apply_auth: false, placeholder_encoding: "raw",
  });
  const json = parseJsonLoose(res.body) as Record<string, unknown> | null;
  if (res.status !== 200 || !json) throw new Error(`Découverte OIDC impossible (HTTP ${res.status}).`);
  return {
    issuer: String(json.issuer ?? issuer),
    authorize_url: String(json.authorization_endpoint ?? ""),
    token_url: String(json.token_endpoint ?? ""),
  };
}

// ── Le relais : réclamer, rendre ─────────────────────────────────────────────

export async function authenticateRelay(admin: SupabaseClient, token: string | null): Promise<RelayRow | null> {
  if (!token || token.length < 20) return null;
  const hash = await sha256Hex(token);
  const { data } = await admin.from("connector_relays")
    .select("id, workspace_id, project_id, name, status, last_seen_at").eq("token_hash", hash).maybeSingle();
  const r = data as RelayRow | null;
  return r && r.status === "active" ? r : null;
}

export async function newRelayToken(): Promise<{ token: string; hash: string; hint: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `fosr_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  return { token, hash: await sha256Hex(token), hint: token.slice(-4) };
}

/** Ce que le relais reçoit : la requête, secrets résolus si le cloud les détient. */
async function claimPayload(admin: SupabaseClient, job: { id: string; request: JobRequest; connector_id: string | null; credential_id: string | null }) {
  const req = job.request;
  let cred: CredentialRow | null = null;
  let c: ConnectorRow | null = null;
  if (job.connector_id) c = await loadConnector(admin, job.connector_id);
  if (job.credential_id) {
    const { data } = await admin.from("custom_connector_credentials").select("*").eq("id", job.credential_id).maybeSingle();
    cred = data as CredentialRow | null;
  }
  const secrets = cred && cred.location === "cloud" ? await secretsFor(cred) : {};
  if (c && cred && cred.location === "cloud") {
    const cfg = normalizeAuthConfig(c.auth_config);
    if (secrets.client_secret !== undefined && cfg.client_id) {
      secrets.__basic_client = btoa(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(secrets.client_secret)}`);
    }
  }
  const request = Object.keys(secrets).length ? fillRequest(req, secrets) : req;

  let auth: Record<string, unknown> | null = null;
  if (req.apply_auth && c && c.auth_scheme !== "none") {
    const cfg = normalizeAuthConfig(c.auth_config);
    if (c.auth_scheme === "oauth2_authorization_code") {
      auth = { scheme: "bearer", config: { header: "Authorization", prefix: "Bearer " }, secrets: { token: secrets.access_token ?? "" } };
    } else {
      auth = {
        scheme: c.auth_scheme,
        config: cfg,
        base_url: c.base_url,
        // Clé de cache du relais : un secret tourné invalide son jeton en mémoire.
        cache_key: cred ? `${cred.id}:${cred.rotated_at ?? ""}` : null,
        ...(cred?.location === "relay" ? { refs: cred.relay_refs ?? {} } : { secrets: await payloadOf(cred!) }),
      };
    }
  }
  return { id: job.id, request, auth, refs: cred?.location === "relay" ? cred.relay_refs ?? {} : {} };
}

export async function relayClaim(
  admin: SupabaseClient, relay: RelayRow, report: { version?: string; hostname?: string; allowed_hosts?: string[]; allowed_binaries?: string[]; ip?: string | null },
  waitMs: number,
) {
  await admin.from("connector_relays").update({
    last_seen_at: new Date().toISOString(),
    last_ip: report.ip ?? null,
    version: report.version?.slice(0, 40) ?? null,
    hostname: report.hostname?.slice(0, 120) ?? null,
    reported_hosts: (report.allowed_hosts ?? []).slice(0, 100).map((h) => String(h).slice(0, 200)),
    reported_binaries: (report.allowed_binaries ?? []).slice(0, 30).map((h) => String(h).slice(0, 40)),
  }).eq("id", relay.id);

  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 25_000);
  let beat = Date.now();
  while (true) {
    const { data } = await admin.rpc("ccx_claim_relay_job", { p_relay: relay.id });
    const job = Array.isArray(data) ? data[0] : data;
    if (job && job.id) return await claimPayload(admin, job);
    if (Date.now() >= deadline) return null;
    await sleep(700);
    // Le relais reste « en ligne » pendant qu'il attend.
    if (Date.now() - beat > 20_000) {
      beat = Date.now();
      await admin.from("connector_relays").update({ last_seen_at: new Date().toISOString() }).eq("id", relay.id);
    }
  }
}

export async function relayComplete(admin: SupabaseClient, relay: RelayRow, body: Record<string, unknown>): Promise<boolean> {
  const jobId = String(body.job_id ?? "");
  const { data: job } = await admin.from("connector_relay_jobs")
    .select("id, status").eq("id", jobId).eq("relay_id", relay.id).maybeSingle();
  if (!job || (job as { status: string }).status !== "claimed") return false;
  const result: TransportResult = {
    status: Number(body.status) || 0,
    headers: (body.headers && typeof body.headers === "object" ? body.headers : {}) as Record<string, string>,
    body: String(body.body ?? "").slice(0, 600_000),
    truncated: body.truncated === true,
    duration_ms: Number(body.duration_ms) || 0,
    error: body.error ? String(body.error).slice(0, 500) : undefined,
  };
  const { ciphertext, iv } = await encryptSecret(JSON.stringify(result));
  await admin.from("connector_relay_jobs").update({
    status: result.error && !result.status ? "error" : "done",
    result_enc: ciphertext, result_iv: iv, completed_at: new Date().toISOString(),
  }).eq("id", jobId);
  return true;
}
