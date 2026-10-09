// Les secrets détenus par le relais.
//
// Un profil d'identifiants à l'emplacement « relais » ne contient, côté
// FounderOS, que des RÉFÉRENCES : env:ARGOCD_TOKEN, file:/var/run/secrets/…
// Le relais les lit ici, au moment de l'appel. Les valeurs viennent de ce que
// le client branche sur le conteneur : Secret Kubernetes, Vault Agent,
// External Secrets Operator, variables d'environnement.

import { readFileSync } from "node:fs";

const REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\s]+)$/;

/** Résout une référence ; jamais de valeur en clair acceptée ici. */
export function resolveRef(ref) {
  const r = String(ref ?? "").trim();
  if (!REF.test(r)) throw new Error(`référence de secret invalide : ${r.slice(0, 40)}`);
  if (r.startsWith("env:")) {
    const v = process.env[r.slice(4)];
    if (v === undefined || v === "") throw new Error(`variable ${r.slice(4)} absente sur le relais`);
    return v;
  }
  try {
    return readFileSync(r.slice(5), "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Error(`fichier ${r.slice(5)} illisible sur le relais`);
  }
}

/** Les secrets d'un appel : fournis par le cloud, ou résolus localement. */
export function secretsOf(auth, refs) {
  if (auth?.secrets && typeof auth.secrets === "object") return { ...auth.secrets };
  const map = auth?.refs ?? refs ?? {};
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = resolveRef(v);
  return out;
}

/** Remplace {{secret:x}} selon l'endroit où la valeur atterrit. */
export function fillSecrets(s, secrets, encoding) {
  if (typeof s !== "string") return s;
  return s.replace(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g, (m, name) => {
    const v = secrets[name];
    if (v === undefined) throw new Error(`secret « ${name} » introuvable sur le relais`);
    if (encoding === "form") return encodeURIComponent(v);
    if (encoding === "json") return JSON.stringify(v).slice(1, -1);
    return v;
  });
}

/** Les marqueurs restants d'une requête, résolus par les références du relais. */
export function fillRequest(req, refs) {
  const hasMarkers = JSON.stringify(req).includes("{{secret:");
  if (!hasMarkers) return req;
  const secrets = secretsOf(null, refs);
  const enc = req.placeholder_encoding ?? "raw";
  return {
    ...req,
    url: req.url ? fillSecrets(req.url, secrets, "form") : req.url,
    headers: Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k, fillSecrets(v, secrets, "raw")])),
    body: typeof req.body === "string" ? fillSecrets(req.body, secrets, enc) : req.body,
    args: Array.isArray(req.args) ? req.args.map((a) => fillSecrets(a, secrets, "raw")) : req.args,
  };
}
