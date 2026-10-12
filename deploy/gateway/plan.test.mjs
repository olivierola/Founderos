// La passerelle d'entreprise (G7) : ce qu'elle démarre, avec quels secrets, et
// comment elle s'arrête.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { gatewayPlan } from "./plan.mjs";

const base = {
  PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/etc/ca/ca.pem",
  FOUNDEROS_URL: "https://founderos.acme.fr", RELAY_TOKEN: "fosr_secret", RELAY_ALLOWED_HOSTS: "argocd.acme.svc:443",
};
const withMcp = {
  ...base, GATEWAY_MCP_SERVERS: "openshift, argocd", MCP_CLUSTER: "prd", MCP_TOKEN_SEED_FILE: "/etc/mcp-token-seed/seed",
  VAULT_ADDR: "https://vault.acme.fr", OPA_URL: "http://127.0.0.1:8181", APPROVAL_JWKS_FILE: "/etc/approval-jwks/jwks.json",
  TLS_CERT_FILE: "/etc/tls/tls.crt", MTLS_ALLOWED_CN: "founderos",
};

describe("le plan", () => {
  it("relais seul : rien à ajouter à sa liste blanche, pas de serveur MCP", () => {
    const p = gatewayPlan(base);
    assert.deepEqual(p.issues, []);
    assert.equal(p.mcp, null);
    assert.equal(p.relay.env.RELAY_ALLOWED_HOSTS, "argocd.acme.svc:443");
    assert.equal(p.relay.env.RELAY_TOKEN, "fosr_secret");
  });

  it("avec serveurs MCP : la boucle locale seulement, en clair, et le relais autorisé vers ce seul port", () => {
    const p = gatewayPlan(withMcp);
    assert.deepEqual(p.issues, []);
    assert.deepEqual(p.servers, ["openshift", "argocd"]);
    assert.equal(p.mcpUrl, "http://127.0.0.1:8443/mcp");
    assert.equal(p.mcp.env.MCP_SERVER, "openshift,argocd");
    assert.equal(p.mcp.env.MCP_HOST, "127.0.0.1");
    assert.equal(p.mcp.env.MCP_PORT, "8443");
    assert.equal(p.mcp.env.MCP_INSECURE_HTTP, "1");
    assert.equal(p.mcp.env.MGMT_HOST, "0.0.0.0");
    assert.equal(p.relay.env.RELAY_ALLOWED_HOSTS, "argocd.acme.svc:443,127.0.0.1:8443");
    assert.equal(gatewayPlan({ ...withMcp, GATEWAY_MCP_PORT: "9443" }).relay.env.RELAY_ALLOWED_HOSTS, "argocd.acme.svc:443,127.0.0.1:9443");
  });

  it("chacun ses secrets : le serveur MCP ne voit pas le jeton du relais, le relais ne voit ni Vault ni les jetons MCP", () => {
    const p = gatewayPlan(withMcp);
    for (const k of ["RELAY_TOKEN", "RELAY_ALLOWED_HOSTS", "FOUNDEROS_URL", "TLS_CERT_FILE", "MTLS_ALLOWED_CN"]) {
      assert.equal(p.mcp.env[k], undefined, `${k} ne doit pas atteindre le serveur MCP`);
    }
    for (const k of ["MCP_TOKEN_SEED_FILE", "MCP_CLUSTER", "VAULT_ADDR", "OPA_URL", "APPROVAL_JWKS_FILE", "AUTH_MODE", "TLS_CERT_FILE"]) {
      assert.equal(p.relay.env[k], undefined, `${k} ne doit pas atteindre le relais`);
    }
    // Ce qui est commun reste aux deux : l'AC interne, le PATH.
    assert.equal(p.mcp.env.NODE_EXTRA_CA_CERTS, "/etc/ca/ca.pem");
    assert.equal(p.relay.env.NODE_EXTRA_CA_CERTS, "/etc/ca/ca.pem");
  });

  it("jeton tournant : le serveur MCP livre ses jetons à l'adresse de FounderOS du relais, sans voir le jeton du relais", () => {
    const p = gatewayPlan(withMcp);
    assert.equal(p.mcp.env.AUTH_MODE, "rotating");
    assert.equal(p.mcp.env.MCP_FOUNDEROS_URL, "https://founderos.acme.fr");
    assert.equal(p.mcp.env.RELAY_TOKEN, undefined);
    assert.equal(gatewayPlan({ ...withMcp, MCP_FOUNDEROS_URL: "https://api.acme.fr" }).mcp.env.MCP_FOUNDEROS_URL, "https://api.acme.fr");
    const fixed = gatewayPlan({ ...withMcp, MCP_TOKEN_SEED_FILE: undefined, MCP_TOKENS_FILE: "/t.json" });
    assert.equal(fixed.mcp.env.AUTH_MODE, "token");
    assert.equal(fixed.mcp.env.MCP_FOUNDEROS_URL, undefined);
  });

  it("ce qui manque est nommé, tout d'un coup", () => {
    assert.equal(gatewayPlan({}).issues.length, 2);
    const p = gatewayPlan({ ...base, GATEWAY_MCP_SERVERS: "openshift", GATEWAY_MCP_PORT: "0" });
    assert.equal(p.issues.length, 3);
    assert.match(p.issues.join("\n"), /GATEWAY_MCP_PORT/);
    assert.match(p.issues.join("\n"), /MCP_CLUSTER/);
    assert.match(p.issues.join("\n"), /MCP_TOKEN_SEED_FILE/);
    assert.deepEqual(gatewayPlan({ ...base, GATEWAY_MCP_SERVERS: "openshift", MCP_CLUSTER: "prd", AUTH_MODE: "oidc" }).issues, []);
    assert.deepEqual(gatewayPlan({ ...base, GATEWAY_MCP_SERVERS: "openshift", MCP_CLUSTER: "prd", MCP_TOKENS_FILE: "/t.json" }).issues, []);
    assert.match(gatewayPlan({ ...base, GATEWAY_MCP_SERVERS: "openshift", MCP_CLUSTER: "prd", AUTH_MODE: "rotating" }).issues.join(), /MCP_TOKEN_SEED_FILE/);
  });
});

// ── Le lanceur, avec deux faux processus ─────────────────────────────────────

const gateway = path.join(import.meta.dirname, "gateway.mjs");
// Un faux processus : écrit son environnement, puis attend ; s'arrête seul si EXIT_AFTER_MS.
const FAKE = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify(process.env));
if (process.env.FAKE_EXIT_ROLE && process.argv[2].endsWith(process.env.FAKE_EXIT_ROLE + ".json")) {
  setTimeout(() => process.exit(3), 300);
}
process.on("SIGTERM", () => { writeFileSync(process.argv[2] + ".stopped", "1"); process.exit(0); });
setInterval(() => {}, 1000);
`;

function runGateway(env) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gw-"));
  const fake = path.join(dir, "fake.mjs");
  writeFileSync(fake, FAKE);
  // Le chemin du « main » est passé en argument au faux : on y glisse le fichier de sortie.
  const mcpOut = path.join(dir, "mcp.json");
  const relayOut = path.join(dir, "relay.json");
  const fakeUrl = JSON.stringify(pathToFileURL(fake).href);
  writeFileSync(path.join(dir, "mcp.mjs"), `process.argv[2] = ${JSON.stringify(mcpOut)}; await import(${fakeUrl});`);
  writeFileSync(path.join(dir, "relay.mjs"), `process.argv[2] = ${JSON.stringify(relayOut)}; await import(${fakeUrl});`);
  const child = spawn(process.execPath, [gateway], {
    env: { ...env, GATEWAY_MCP_MAIN: path.join(dir, "mcp.mjs"), GATEWAY_RELAY_MAIN: path.join(dir, "relay.mjs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, mcpOut, relayOut, logs: () => out };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fn()) return; } catch { /* pas encore */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("délai dépassé");
};

describe("le lanceur", () => {
  it("configuration incomplète : refuse de démarrer, en nommant ce qui manque", async () => {
    const { exited, logs } = runGateway({ PATH: process.env.PATH });
    assert.equal(await exited, 1);
    assert.match(logs(), /FOUNDEROS_URL/);
    assert.match(logs(), /RELAY_TOKEN/);
  });

  it("démarre les deux processus, chacun avec ses seuls secrets ; SIGTERM les arrête", { skip: process.platform === "win32" && "signaux POSIX" }, async () => {
    const run = runGateway({ ...withMcp, PATH: process.env.PATH });
    await until(() => readFileSync(run.mcpOut, "utf8") && readFileSync(run.relayOut, "utf8"));
    const mcpEnv = JSON.parse(readFileSync(run.mcpOut, "utf8"));
    const relayEnv = JSON.parse(readFileSync(run.relayOut, "utf8"));
    assert.equal(mcpEnv.MCP_HOST, "127.0.0.1");
    assert.equal(mcpEnv.RELAY_TOKEN, undefined);
    assert.equal(relayEnv.RELAY_TOKEN, "fosr_secret");
    assert.equal(relayEnv.MCP_TOKENS_FILE, undefined);
    run.child.kill("SIGTERM");
    assert.equal(await run.exited, 0);
    assert.equal(readFileSync(run.mcpOut + ".stopped", "utf8"), "1");
    assert.equal(readFileSync(run.relayOut + ".stopped", "utf8"), "1");
  });

  it("si le serveur MCP tombe, le relais est arrêté et la passerelle sort en erreur : le pod redémarre", async () => {
    const run = runGateway({ ...withMcp, PATH: process.env.PATH, FAKE_EXIT_ROLE: "mcp" });
    const code = await run.exited;
    assert.notEqual(code, 0);
    assert.match(run.logs(), /serveur MCP s'est arrêté/);
    // Les secrets de chacun, vus par les processus eux-mêmes.
    const mcpEnv = JSON.parse(readFileSync(run.mcpOut, "utf8"));
    const relayEnv = JSON.parse(readFileSync(run.relayOut, "utf8"));
    assert.equal(mcpEnv.MCP_HOST, "127.0.0.1");
    assert.equal(mcpEnv.RELAY_TOKEN, undefined);
    assert.equal(relayEnv.RELAY_TOKEN, "fosr_secret");
    assert.equal(relayEnv.VAULT_ADDR, undefined);
    if (process.platform !== "win32") assert.equal(readFileSync(run.relayOut + ".stopped", "utf8"), "1");
  });
});
