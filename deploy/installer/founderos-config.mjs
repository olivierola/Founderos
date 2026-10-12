#!/usr/bin/env node
// founderos.yaml → ce qu'il faut pour installer (G5).
//
//   node deploy/installer/founderos-config.mjs founderos.yaml --out ./install [--rotate]
//
// target kubernetes ou openshift :
//   values.generated.yaml        les valeurs du chart deploy/helm/founderos (aucun secret)
//   secrets.generated.yaml       les Secrets (secrets.source: generate) — à appliquer, ne pas versionner
//   externalsecrets.generated.yaml  (secrets.source: vault) les ExternalSecret qui les recopient de Vault
// target vm :
//   .env                         celui de deploy/compose (secrets compris, ne pas versionner)
// Supabase auto-hébergé (supabase.mode: selfhosted) :
//   supabase.env                 les clés à reporter dans le compose ou le chart de Supabase
//
// founderos.secrets.json garde les secrets générés : relancer l'installateur ne
// les change pas (les jetons chiffrés et les approbations signées restent
// valables). --rotate en génère de nouveaux.
//
// Dépendance : js-yaml, déjà dans le package.json de la racine (npm ci).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  ConfigError, composeEnv, externalSecrets, generateSecrets, helmValues, k8sSecrets, normalizeConfig, supabaseEnv,
} from "./config.mjs";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
const outIdx = args.indexOf("--out");
const out = path.resolve(outIdx >= 0 ? args[outIdx + 1] : ".");
const rotate = args.includes("--rotate");

if (!input) {
  console.error("Usage : node deploy/installer/founderos-config.mjs founderos.yaml --out <dossier> [--rotate]");
  process.exit(2);
}

let cfg;
try {
  cfg = normalizeConfig(yaml.load(readFileSync(input, "utf8")));
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : `Lecture de ${input} impossible : ${e.message}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const write = (name, content, secret = false) => {
  const file = path.join(out, name);
  writeFileSync(file, content, { mode: secret ? 0o600 : 0o644 });
  if (secret) try { chmodSync(file, 0o600); } catch { /* Windows */ }
  console.log(`  ${secret ? "secret " : "       "} ${path.relative(process.cwd(), file)}`);
};
const dump = (docs) => docs.map((d) => yaml.dump(d, { lineWidth: 200, noRefs: true })).join("---\n");

const stateFile = path.join(out, "founderos.secrets.json");
const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const needsSecrets = cfg.secrets.source === "generate" || cfg.supabase.mode === "selfhosted";
const secrets = needsSecrets ? generateSecrets(cfg, previous, { rotate }) : null;

console.log(`FounderOS — cible ${cfg.target}, interface ${cfg.urls.web}`);
if (secrets) write("founderos.secrets.json", `${JSON.stringify(secrets, null, 2)}\n`, true);

if (cfg.target === "vm") {
  write(".env", composeEnv(cfg, secrets), true);
} else {
  write("values.generated.yaml", `# Généré par deploy/installer/founderos-config.mjs — aucun secret.\n${yaml.dump(helmValues(cfg), { lineWidth: 200 })}`);
  if (cfg.secrets.source === "generate") write("secrets.generated.yaml", `# Contient des secrets : à appliquer, puis à ranger hors du dépôt.\n${dump(k8sSecrets(cfg, secrets))}`, true);
  if (cfg.secrets.source === "vault") write("externalsecrets.generated.yaml", `# External Secrets Operator : recopie les secrets de ${cfg.secrets.vault.path}.\n${dump(externalSecrets(cfg))}`);
}
if (cfg.supabase.mode === "selfhosted") write("supabase.env", supabaseEnv(cfg, secrets), true);

console.log("\nEnsuite :");
const rel = (name) => path.join(path.relative(process.cwd(), out) || ".", name);
const steps = [];
if (cfg.target === "vm") {
  steps.push("Supabase : reportez supabase.env dans le .env de son docker compose officiel, puis démarrez-le.");
  steps.push(`docker compose -f deploy/compose/docker-compose.yml --env-file ${rel(".env")} up -d`);
} else {
  const ns = "founderos";
  if (cfg.supabase.mode === "selfhosted") steps.push("Supabase : reportez supabase.env dans les valeurs de son chart (ou de son compose), puis installez-le.");
  if (cfg.secrets.source === "generate") steps.push(`kubectl create namespace ${ns}; kubectl -n ${ns} apply -f ${rel("secrets.generated.yaml")}`);
  if (cfg.secrets.source === "vault") steps.push(`Rangez les secrets dans Vault (${cfg.secrets.vault.path}), puis : kubectl -n ${ns} apply -f ${rel("externalsecrets.generated.yaml")}`);
  steps.push(`helm upgrade --install founderos deploy/helm/founderos -n ${ns} -f ${rel("values.generated.yaml")}`);
}
steps.push(`${cfg.urls.web}/setup : premier compte, diagnostic, SSO, premier agent.`);
steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
if (secrets && !secrets.LLM_API_KEY && cfg.llm.gateway === "litellm") {
  console.log("\n  Attention : LLM_API_KEY absente (exportez-la avant de relancer, ou ajoutez-la au Secret du backend).");
}
