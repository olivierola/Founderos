// FounderOS — relais d'outils internes.
//
// Il tourne DANS votre réseau, à côté d'Argo CD, Vault, Grafana, Loki ou de
// votre cluster, et ne fait que des appels SORTANTS vers FounderOS : il vient
// chercher les requêtes des collaborateurs (long polling), les exécute contre
// vos outils si sa propre liste blanche le permet, et renvoie la réponse.
// Aucun port entrant à ouvrir, aucune adresse interne exposée.
//
// Variables :
//   FOUNDEROS_URL             https://<projet>.supabase.co (obligatoire)
//   RELAY_TOKEN               jeton du relais, créé dans FounderOS (obligatoire)
//   RELAY_ALLOWED_HOSTS       hôtes joignables, refus par défaut (voir policy.js)
//   RELAY_ALLOWED_BINARIES    CLI autorisées (helm, kubectl…), vide par défaut
//   RELAY_DENIED_SUBCOMMANDS  sous-commandes interdites (défaut : gestes destructifs)
//   RELAY_CONCURRENCY         requêtes simultanées (défaut 4)
//   RELAY_MAX_BYTES           taille maximale d'une réponse (défaut 1 Mo)
//   RELAY_CA_FILE             autorité de certification interne (PEM)
//   RELAY_HEALTH_PORT         port d'une sonde /healthz (désactivé si absent)

import os from "node:os";
import http from "node:http";
import { ALLOWED_BINARIES, ALLOWED_HOSTS } from "./policy.js";
import { httpCall } from "./http.js";
import { applyAuth, forgetToken } from "./auth.js";
import { fillRequest } from "./secrets.js";
import { runCommand } from "./exec.js";

const VERSION = "0.1.0";
const BASE = String(process.env.FOUNDEROS_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.RELAY_TOKEN ?? "";
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.RELAY_CONCURRENCY) || 4, 16));
const ENDPOINT = `${BASE}/functions/v1/connector-action`;

if (!BASE || !TOKEN) {
  console.error("FOUNDEROS_URL et RELAY_TOKEN sont obligatoires.");
  process.exit(1);
}

// Journal local, une ligne JSON par événement : à brancher sur votre collecte
// (Loki, Elastic, Splunk). Jamais de corps de requête ni de secret.
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

let stopping = false;
let inFlight = 0;
let lastContact = 0;

async function call(body, timeoutMs = 35000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay-Token": TOKEN },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error("jeton de relais refusé (révoqué ou renouvelé)"), { fatal: true });
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    lastContact = Date.now();
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function execute(job) {
  const req = fillRequest(job.request ?? {}, job.refs ?? {});
  const started = Date.now();
  const base = { job_id: job.id, type: req.type };
  try {
    let result;
    if (req.type === "exec") {
      result = await runCommand(req);
      log("info", "commande", { ...base, binary: req.binary, sub: (req.args ?? [])[0], status: result.status, ms: result.duration_ms });
    } else {
      let { req: authed, tlsOpts } = req.apply_auth ? await applyAuth(req, job.auth, job.refs) : { req, tlsOpts: {} };
      result = await httpCall(authed, tlsOpts);
      // Jeton de session ou SSO périmé côté outil : un seul nouvel essai, jeton neuf.
      if (result.status === 401 && req.apply_auth && ["session_login", "oauth2_client_credentials"].includes(job.auth?.scheme)) {
        forgetToken(job.auth.cache_key);
        ({ req: authed, tlsOpts } = await applyAuth(req, job.auth, job.refs));
        result = await httpCall(authed, tlsOpts);
      }
      const u = new URL(req.url);
      log("info", "appel", { ...base, method: req.method, host: u.host, path: u.pathname, status: result.status, bytes: result.body.length, ms: result.duration_ms });
    }
    await call({ mode: "relay.complete", job_id: job.id, ...result });
  } catch (e) {
    log("warn", "échec", { ...base, error: e.message, ms: Date.now() - started });
    await call({ mode: "relay.complete", job_id: job.id, status: 0, error: e.message, duration_ms: Date.now() - started })
      .catch((err) => log("error", "rendu impossible", { ...base, error: err.message }));
  }
}

async function loop() {
  let backoff = 1000;
  log("info", "démarrage", {
    version: VERSION, endpoint: ENDPOINT, concurrency: CONCURRENCY,
    allowed_hosts: ALLOWED_HOSTS, allowed_binaries: ALLOWED_BINARIES,
  });
  if (!ALLOWED_HOSTS.length) log("warn", "RELAY_ALLOWED_HOSTS est vide : toutes les requêtes HTTP seront refusées");
  while (!stopping) {
    if (inFlight >= CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    try {
      const res = await call({
        mode: "relay.claim", version: VERSION, hostname: os.hostname(),
        allowed_hosts: ALLOWED_HOSTS, allowed_binaries: ALLOWED_BINARIES, wait_ms: 20000,
      });
      backoff = 1000;
      if (res.job) {
        inFlight++;
        execute(res.job).finally(() => { inFlight--; });
      }
    } catch (e) {
      if (e.fatal) {
        log("error", e.message);
        process.exit(2);
      }
      log("warn", "FounderOS injoignable", { error: e.message, retry_ms: backoff });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

if (process.env.RELAY_HEALTH_PORT) {
  http.createServer((req, res) => {
    const healthy = Date.now() - lastContact < 90000;
    res.writeHead(req.url === "/healthz" && healthy ? 200 : 503, { "Content-Type": "text/plain" });
    res.end(healthy ? "ok" : "no contact");
  }).listen(Number(process.env.RELAY_HEALTH_PORT));
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    log("info", "arrêt demandé", { in_flight: inFlight });
    const wait = setInterval(() => {
      if (inFlight === 0) { clearInterval(wait); process.exit(0); }
    }, 200);
    setTimeout(() => process.exit(0), 30000);
  });
}

loop();
