#!/usr/bin/env node
// Passerelle d'entreprise FounderOS (G7) : le seul composant installé chez le
// client en mode cloud. Le relais (connector-relay) et, en option, les serveurs
// MCP (MCP/) dans un même conteneur ; aucun port entrant.
//
//   FOUNDEROS_URL, RELAY_TOKEN, RELAY_ALLOWED_HOSTS…   le relais (connector-relay/src/index.js)
//   GATEWAY_MCP_SERVERS   modules MCP à servir (ex. openshift,argocd) ; vide : relais seul
//   GATEWAY_MCP_PORT      port local du serveur MCP (défaut 8443)
//   MCP_CLUSTER, MCP_CONFIG_FILE, MCP_TOKENS_FILE, VAULT_*, OPA_URL…   le serveur MCP (MCP/src/main.ts)
//
// Dans FounderOS, le serveur se déclare « par le relais » de cette passerelle,
// à l'adresse http://127.0.0.1:<GATEWAY_MCP_PORT>/mcp.
// Si l'un des deux processus s'arrête, la passerelle s'arrête : le pod redémarre.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayPlan } from "./plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const plan = gatewayPlan(process.env, {
  mcpMain: process.env.GATEWAY_MCP_MAIN ?? path.join(here, "mcp/dist/main.js"),
  relayMain: process.env.GATEWAY_RELAY_MAIN ?? path.join(here, "relay/src/index.js"),
});
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, component: "gateway", msg, ...extra }));

if (plan.issues.length) {
  for (const issue of plan.issues) log("error", issue);
  process.exit(1);
}

const children = [];
let stopping = false;

function start(name, spec) {
  const child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    log("error", `${name} s'est arrêté : la passerelle s'arrête`, { code, signal });
    stop(code || 1);
  });
  children.push(child);
  log("info", `${name} lancé`, { pid: child.pid });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  // Le relais finit ses requêtes en cours ; au-delà, on coupe.
  setTimeout(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    process.exit(code);
  }, 25_000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => process.exit(code));
}

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => stop(0));

if (plan.mcp) {
  start("serveur MCP", plan.mcp);
  log("info", "serveur MCP sur la boucle locale", { servers: plan.servers, url: plan.mcpUrl });
}
start("relais", plan.relay);
log("info", "passerelle démarrée", {
  relay: true, mcp: !!plan.mcp,
  ...(plan.mcp ? { declare_in_founderos: `serveur MCP « par le relais », adresse ${plan.mcpUrl}` } : {}),
});
