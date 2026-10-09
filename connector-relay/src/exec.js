// Une commande sur le relais (helm, kubectl, argocd…), quand l'outil n'a pas
// d'API. Pas de shell : execFile reçoit le binaire et ses arguments un par un,
// rien n'est interprété. Le binaire doit figurer dans RELAY_ALLOWED_BINARIES,
// et ses droits réels sont ceux du compte qui fait tourner le relais (le
// ServiceAccount Kubernetes du chart Helm, ClusterRole « view » par défaut).

import { execFile } from "node:child_process";
import { commandAllowed } from "./policy.js";

const HARD_MAX_BYTES = Number(process.env.RELAY_MAX_BYTES || 1024 * 1024);

// L'environnement transmis à la commande : le strict nécessaire, jamais les
// secrets du relais (RELAY_TOKEN et consorts restent hors de portée).
function childEnv() {
  const keep = ["PATH", "HOME", "KUBECONFIG", "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT",
    "HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export function runCommand(job) {
  const verdict = commandAllowed(job.binary, job.args);
  if (!verdict.ok) return Promise.reject(new Error(`refusé par le relais : ${verdict.reason}`));
  const maxBytes = Math.min(Number(job.max_bytes) || 65536, HARD_MAX_BYTES);
  const timeout = Math.min(Number(job.timeout_ms) || 30000, 60000);
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(job.binary, job.args, { timeout, maxBuffer: maxBytes * 2, env: childEnv(), shell: false, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const body = code === 0 ? out : `${out}${out && errText ? "\n" : ""}${errText}` || String(err?.message ?? "");
        resolve({
          // Le cloud lit 200 comme un succès, le reste comme un échec avec le code de sortie.
          status: code === 0 ? 200 : 500,
          headers: { "x-exit-code": String(code) },
          body: body.slice(0, maxBytes),
          truncated: body.length > maxBytes,
          duration_ms: Date.now() - started,
        });
      });
  });
}
