// Un appel HTTP vers un outil interne, depuis le réseau du client.
//
// node:https plutôt que fetch : c'est le seul moyen portable de passer un
// certificat client (mTLS) et une autorité de certification interne par appel.
// Aucune redirection n'est suivie : un 302 vers un autre hôte emporterait
// l'en-tête d'authentification hors de la liste blanche.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { readFileSync, statSync } from "node:fs";
import { clientCertWanted, hostAllowed } from "./policy.js";

const HARD_MAX_BYTES = Number(process.env.RELAY_MAX_BYTES || 1024 * 1024);

let extraCa = null;
if (process.env.RELAY_CA_FILE) {
  try {
    extraCa = [...tls.rootCertificates, readFileSync(process.env.RELAY_CA_FILE, "utf8")];
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: `RELAY_CA_FILE illisible : ${e.message}` }));
  }
}

// Certificat client du relais, pour les serveurs de RELAY_CLIENT_CERT_HOSTS
// (serveurs MCP en mTLS). Relu quand le fichier change : cert-manager le fait
// tourner sans redémarrage.
const CERT_FILE = process.env.RELAY_CLIENT_CERT_FILE || "";
const KEY_FILE = process.env.RELAY_CLIENT_KEY_FILE || "";
let certCache = null;
function relayClientCert() {
  if (!CERT_FILE || !KEY_FILE) return null;
  try {
    const mtime = statSync(CERT_FILE).mtimeMs + statSync(KEY_FILE).mtimeMs;
    if (!certCache || certCache.mtime !== mtime) {
      certCache = { mtime, cert: readFileSync(CERT_FILE, "utf8"), key: readFileSync(KEY_FILE, "utf8") };
    }
    return certCache;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: `certificat client illisible : ${e.message}` }));
    return null;
  }
}

/**
 * @param {{method?: string, url: string, headers?: Record<string,string>, body?: string|null, timeout_ms?: number, max_bytes?: number}} req
 * @param {{cert?: string, key?: string}} [tlsOpts]
 */
export function httpCall(req, tlsOpts = {}) {
  const verdict = hostAllowed(req.url);
  if (!verdict.ok) return Promise.reject(new Error(`refusé par le relais : ${verdict.reason}`));
  // Le certificat du profil (mTLS d'un connecteur) l'emporte ; sinon, celui du relais pour les hôtes déclarés.
  if (!tlsOpts.cert && clientCertWanted(req.url)) {
    const own = relayClientCert();
    if (own) tlsOpts = { cert: own.cert, key: own.key };
  }
  const u = new URL(req.url);
  const lib = u.protocol === "https:" ? https : http;
  const maxBytes = Math.min(Number(req.max_bytes) || 65536, HARD_MAX_BYTES);
  const timeout = Math.min(Number(req.timeout_ms) || 30000, 60000);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const r = lib.request(u, {
      method: req.method || "GET",
      headers: { "User-Agent": "founderos-connector-relay", ...(req.headers ?? {}) },
      timeout,
      ...(u.protocol === "https:" ? {
        ...(extraCa ? { ca: extraCa } : {}),
        ...(tlsOpts.cert ? { cert: tlsOpts.cert } : {}),
        ...(tlsOpts.key ? { key: tlsOpts.key } : {}),
      } : {}),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      res.on("data", (c) => {
        if (truncated) return;
        if (bytes + c.length > maxBytes) {
          chunks.push(c.subarray(0, maxBytes - bytes));
          bytes = maxBytes;
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push(c);
        bytes += c.length;
      });
      const done = () => {
        const headers = {};
        // mcp-session-id : les serveurs MCP à session ; www-authenticate : la raison d'un 401.
        for (const k of ["content-type", "location", "retry-after", "x-request-id", "mcp-session-id", "www-authenticate"]) {
          if (res.headers[k]) headers[k] = String(res.headers[k]);
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
          truncated,
          duration_ms: Date.now() - started,
        });
      };
      res.on("end", done);
      res.on("close", () => { if (truncated) done(); });
      res.on("error", (e) => (truncated ? done() : reject(e)));
    });
    r.on("timeout", () => r.destroy(new Error(`délai dépassé (${timeout} ms)`)));
    r.on("error", reject);
    if (req.body && req.method !== "GET" && req.method !== "HEAD") r.write(req.body);
    r.end();
  });
}
