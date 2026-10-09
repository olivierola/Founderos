// L'authentification appliquée par le relais.
//
// Le cloud envoie le schéma et sa configuration non secrète ; les secrets
// arrivent soit avec la tâche (profil chiffré chez FounderOS, transmis par TLS
// au moment de la réclamer, jamais stocké en clair), soit sont lus ici par
// référence (profil « relais » : ils ne quittent jamais votre réseau).
// Les jetons obtenus (SSO machine, session) restent en mémoire du relais.

import { httpCall } from "./http.js";
import { fillSecrets, secretsOf } from "./secrets.js";

const tokenCache = new Map(); // cache_key → { token, exp }

function cached(key) {
  const hit = key ? tokenCache.get(key) : null;
  return hit && hit.exp > Date.now() + 15000 ? hit.token : null;
}

export function forgetToken(key) {
  if (key) tokenCache.delete(key);
}

function getPath(obj, path) {
  return String(path || "").split(".").filter(Boolean).reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), obj);
}

function joinUrl(base, path) {
  if (/^https?:/i.test(path)) return path;
  const b = new URL(base);
  return `${b.origin}${b.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function clientCredentials(auth, s) {
  const hit = cached(auth.cache_key);
  if (hit) return hit;
  const cfg = auth.config ?? {};
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (cfg.scope) form.set("scope", cfg.scope);
  if (cfg.audience) form.set("audience", cfg.audience);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.client_auth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(s.client_secret)}`).toString("base64")}`;
  } else {
    form.set("client_id", cfg.client_id ?? "");
    form.set("client_secret", s.client_secret ?? "");
  }
  const res = await httpCall({ method: "POST", url: cfg.token_url, headers, body: form.toString(), timeout_ms: 20000, max_bytes: 65536 });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* plus bas */ }
  if (res.status < 200 || res.status >= 300 || !json?.access_token) {
    throw new Error(`jeton SSO refusé (HTTP ${res.status}) ${json?.error_description ?? json?.error ?? ""}`.trim());
  }
  const ttl = Number(json.expires_in) || 300;
  if (auth.cache_key) tokenCache.set(auth.cache_key, { token: json.access_token, exp: Date.now() + ttl * 1000 });
  return json.access_token;
}

async function sessionLogin(auth, s) {
  const hit = cached(auth.cache_key);
  if (hit) return hit;
  const cfg = auth.config ?? {};
  const body = fillSecrets(JSON.stringify(cfg.login_body ?? {}), s, "json");
  const res = await httpCall({
    method: cfg.login_method || "POST",
    url: joinUrl(auth.base_url, cfg.login_path || "/"),
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(cfg.extra_headers ?? {}) },
    body, timeout_ms: 20000, max_bytes: 65536,
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* plus bas */ }
  const token = json ? getPath(json, cfg.token_path || "token") : null;
  if (res.status < 200 || res.status >= 300 || !token) throw new Error(`connexion refusée (HTTP ${res.status})`);
  const ttl = Number(cfg.ttl_path ? getPath(json, cfg.ttl_path) : undefined) || cfg.ttl_seconds || 1800;
  if (auth.cache_key) tokenCache.set(auth.cache_key, { token: String(token), exp: Date.now() + ttl * 1000 });
  return String(token);
}

/**
 * Pose l'authentification sur la requête. Rend les options TLS (mTLS) à part.
 * @returns {Promise<{ req: object, tlsOpts: {cert?: string, key?: string} }>}
 */
export async function applyAuth(req, auth, refs) {
  if (!auth || !auth.scheme || auth.scheme === "none") return { req, tlsOpts: {} };
  const s = secretsOf(auth, refs);
  const cfg = auth.config ?? {};
  const headers = { ...(req.headers ?? {}) };
  let url = req.url;
  const need = (k) => {
    if (!s[k]) throw new Error(`secret « ${k} » manquant pour ${auth.scheme}`);
    return s[k];
  };
  let tlsOpts = {};
  switch (auth.scheme) {
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
    case "basic":
      headers.Authorization = `Basic ${Buffer.from(`${s.username ?? cfg.username ?? ""}:${need("password")}`).toString("base64")}`;
      break;
    case "headers":
      for (const h of cfg.header_names ?? []) headers[h] = need(h);
      break;
    case "oauth2_client_credentials":
      need("client_secret");
      headers.Authorization = `Bearer ${await clientCredentials(auth, s)}`;
      break;
    case "session_login":
      headers[cfg.header || "Authorization"] = `${cfg.prefix ?? "Bearer "}${await sessionLogin(auth, s)}`;
      break;
    case "mtls":
      tlsOpts = { cert: need("cert"), key: need("key") };
      break;
    default:
      throw new Error(`schéma d'authentification inconnu : ${auth.scheme}`);
  }
  return { req: { ...req, url, headers }, tlsOpts };
}
