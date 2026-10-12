// Jetons d'API du serveur MCP (mode par défaut) : générateur, vérification,
// révocation à chaud, et intégration : OPA, catalogue et approbations PRD
// s'appliquent au jeton comme à un jeton d'IdP.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiTokenVerifier, generateToken, parseTokenFile, tokenHash } from "../src/lib/api-tokens.ts";
import { createApprovalVerifier } from "../src/lib/approval.ts";
import type { AuditEvent } from "../src/lib/audit.ts";
import { loadCatalog } from "../src/lib/catalog.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import { startServer, type RunningServer } from "../src/lib/server.ts";
import { combineModules } from "../src/servers/index.ts";
import { approvalToken, APPROVAL_ISSUER, fakeUpstream, resultJson, signingKey } from "./helpers.ts";

const tmpFile = (content: unknown) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "mcpt-")), "tokens.json");
  writeFileSync(f, JSON.stringify(content));
  return f;
};

describe("générateur", () => {
  it("un jeton mcpt_<id>_<secret> de 256 bits ; l'entrée ne garde que son empreinte", () => {
    const { token, entry } = generateToken({ label: "founderos-lecture", roles: ["ai-ops-reader"], scopes: ["ocp:read"], expiresInDays: 90 });
    assert.match(token, /^mcpt_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(entry.hash, tokenHash(token));
    assert.ok(!JSON.stringify(entry).includes(token.split("_")[2]), "le secret n'est pas dans l'entrée");
    assert.ok(entry.expires_at && Date.parse(entry.expires_at) > Date.now() + 89 * 86_400_000);
    assert.throws(() => generateToken({ label: "a b; drop", roles: [], scopes: [] }), /libellé/);
  });

  it("la commande : scopes déduits des rôles du catalogue, jeton affiché une fois, empreinte écrite", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "mcpt-cli-")), "tokens.json");
    const cli = fileURLToPath(new URL("../src/token-cli.ts", import.meta.url));
    const run = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...a], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
    const gen = run("generate", "--label", "founderos-lecture", "--role", "ai-ops-reader", "--file", file);
    assert.equal(gen.status, 0, gen.stderr);
    const token = gen.stdout.match(/mcpt_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(token, gen.stdout);
    const saved = parseTokenFile(readFileSync(file, "utf8"));
    assert.equal(saved.tokens.length, 1);
    assert.deepEqual(saved.tokens[0].scopes.sort(), loadCatalog().role_scopes["ai-ops-reader"].slice().sort());
    assert.ok(!readFileSync(file, "utf8").includes(token!), "le fichier ne contient pas le jeton");
    const bad = run("generate", "--label", "x", "--role", "admin-inconnu", "--file", file);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /rôle inconnu/);
    const rev = run("revoke", "--id", saved.tokens[0].id, "--file", file);
    assert.equal(rev.status, 0, rev.stderr);
    assert.ok(parseTokenFile(readFileSync(file, "utf8")).tokens[0].revoked_at);
  });
});

describe("vérification", () => {
  const { token, entry } = generateToken({ label: "founderos", roles: ["ai-ops-reader"], scopes: ["ocp:read"], expiresInDays: 30 });
  const verify = createApiTokenVerifier({ entries: [entry] });

  it("accepte le bon jeton ; la personne et l'agent affirmés servent à l'audit, pas aux droits", async () => {
    const plain = await verify(token);
    assert.equal(plain.sub, `token:${entry.id}`);
    assert.equal(plain.azp, "founderos");
    assert.deepEqual(plain.scopes, ["ocp:read"]);
    const asserted = await verify(token, { user: "u-alice", agent: "ops-investigator" });
    assert.equal(asserted.sub, "u-alice");
    assert.equal(asserted.azp, "ops-investigator");
    assert.deepEqual(asserted.roles, ["ai-ops-reader"], "les droits restent ceux du jeton");
    const junk = await verify(token, { user: "alice\nX-Injected: 1", agent: "<script>" });
    assert.equal(junk.sub, `token:${entry.id}`, "une valeur affirmée suspecte est ignorée");
  });

  it("refuse un autre secret, un id inconnu, un format inconnu", async () => {
    const forged = `${token.slice(0, -4)}AAAA`;
    await assert.rejects(verify(forged), /jeton refusé/);
    await assert.rejects(verify(token.replace(entry.id, "zzzzzzzz")), /jeton refusé/);
    await assert.rejects(verify("Bearer-ou-n-importe-quoi"), /format inconnu/);
  });

  it("refuse un jeton expiré ou révoqué", async () => {
    const old = generateToken({ label: "vieux", roles: [], scopes: [], expiresInDays: 1, now: new Date(Date.now() - 3 * 86_400_000) });
    await assert.rejects(createApiTokenVerifier({ entries: [old.entry] })(old.token), /expiré/);
    const rev = generateToken({ label: "rev", roles: [], scopes: [] });
    await assert.rejects(createApiTokenVerifier({ entries: [{ ...rev.entry, revoked_at: new Date().toISOString() }] })(rev.token), /révoqué/);
  });

  it("une révocation dans le Secret s'applique sans redémarrage", async () => {
    const t = generateToken({ label: "rot", roles: [], scopes: [] });
    const file = tmpFile({ tokens: [t.entry] });
    const v = createApiTokenVerifier({ file, recheckMs: 0 });
    assert.equal((await v(t.token)).tokenId, t.entry.id);
    writeFileSync(file, JSON.stringify({ tokens: [{ ...t.entry, revoked_at: new Date().toISOString() }] }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    await assert.rejects(v(t.token), /révoqué/);
  });
});

describe("intégration : serveur PRD en mode jeton d'API", async () => {
  const keys = await signingKey();
  const reader = generateToken({ label: "founderos-lecture", roles: ["ai-ops-reader"], scopes: loadCatalog().role_scopes["ai-ops-reader"] });
  const operator = generateToken({ label: "founderos-ops", roles: ["ai-ops-operator"], scopes: loadCatalog().role_scopes["ai-ops-operator"] });
  const audit: AuditEvent[] = [];
  let k8s: Awaited<ReturnType<typeof fakeUpstream>>;
  let server: RunningServer;
  let url = "";

  before(async () => {
    k8s = await fakeUpstream({
      "GET /api/v1/namespaces/app-a-prd/pods": () => ({ json: { items: [] } }),
      "PATCH /apis/apps/v1/namespaces/app-a-prd/deployments/api": () => ({ json: { metadata: { name: "api" } } }),
    });
    const catalog = loadCatalog();
    const mod = combineModules(["openshift", "argocd"]);
    server = await startServer({
      module: mod,
      config: mod.configSchema.parse({
        openshift: { api: { url: k8s.url }, namespaces: ["app-a-prd"], readCredential: { type: "env", name: "X" }, writeCredential: { type: "env", name: "X" } },
        argocd: { url: k8s.url, token: { type: "env", name: "X" }, projects: ["team-a"] },
      }),
      cluster: "prd", catalog, policy: new BuiltinPolicyEngine(catalog),
      verifyToken: createApiTokenVerifier({ file: tmpFile({ tokens: [reader.entry, operator.entry] }) }),
      verifyApproval: createApprovalVerifier({ issuer: APPROVAL_ISSUER, audience: "mcp-prd", jwks: keys.jwks }),
      secrets: { resolve: async () => "sa-token" }, audit: (e: AuditEvent) => audit.push(e),
      mcpPort: 0, mgmtPort: 0, insecureHttp: true, host: "127.0.0.1",
    });
    url = `http://127.0.0.1:${(server.mcp.address() as AddressInfo).port}/mcp`;
  });
  after(async () => {
    await server.close();
    await k8s.close();
  });

  const connect = async (token: string, user?: string, agent?: string) => {
    const client = new Client({ name: "founderos", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...(user ? { "X-FounderOS-User": user } : {}), ...(agent ? { "X-FounderOS-Agent": agent } : {}) } },
    }));
    return client;
  };

  it("sans jeton valide : 401", async () => {
    const res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer mcpt_aaaaaaaa_" + "A".repeat(43), "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(res.status, 401);
  });

  it("le jeton lecture lit ; l'audit nomme la personne, l'agent et le jeton", async () => {
    audit.length = 0;
    const c = await connect(reader.token, "u-alice", "ops-investigator");
    const out = await c.callTool({ name: "pods_list", arguments: { namespace: "app-a-prd" } });
    assert.ok(!out.isError, JSON.stringify(out));
    const e = audit.at(-1)!;
    assert.equal(e.user, "u-alice");
    assert.equal(e.agent, "ops-investigator");
    assert.equal(e.token_id, reader.entry.id);
    await c.close();
  });

  it("le jeton lecture ne redémarre rien : scope absent", async () => {
    const c = await connect(reader.token, "u-alice", "ops-investigator");
    const out = await c.callTool({ name: "deployment_restart", arguments: { namespace: "app-a-prd", name: "api" } });
    assert.equal(resultJson(out as never).reason, "scope_missing");
    await c.close();
  });

  it("le jeton opérateur en PRD : approbation exigée, puis exécution avec le jeton d'approbation d'une autre personne", async () => {
    const c = await connect(operator.token, "u-alice", "ops-change");
    const first = resultJson(await c.callTool({ name: "deployment_restart", arguments: { namespace: "app-a-prd", name: "api" } }) as never);
    assert.equal(first.error, "approval_required");
    await c.close();
    const approval = await approvalToken(keys.privateKey, {
      aud: "mcp-prd", sub: "u-alice", approver: "u-bob", tool: "deployment_restart", target_cluster: "prd", params_hash: first.params_hash,
    });
    const client = new Client({ name: "founderos", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${operator.token}`, "X-FounderOS-User": "u-alice", "X-FounderOS-Agent": "ops-change", "X-Approval-Token": approval } },
    }));
    const done = await client.callTool({ name: "deployment_restart", arguments: { namespace: "app-a-prd", name: "api" } });
    assert.ok(!done.isError, JSON.stringify(done));
    assert.equal(k8s.calls.filter((x) => x.method === "PATCH").length, 1);
    await client.close();
  });

  it("une auto-approbation (approbateur = demandeur affirmé) reste refusée par OPA", async () => {
    const c = await connect(operator.token, "u-carol", "ops-change");
    const first = resultJson(await c.callTool({ name: "deployment_restart", arguments: { namespace: "app-a-prd", name: "api" } }) as never);
    await c.close();
    const self = await approvalToken(keys.privateKey, {
      aud: "mcp-prd", sub: "u-carol", approver: "u-carol", tool: "deployment_restart", target_cluster: "prd", params_hash: first.params_hash,
    });
    const client = new Client({ name: "founderos", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${operator.token}`, "X-FounderOS-User": "u-carol", "X-Approval-Token": self } },
    }));
    const out = resultJson(await client.callTool({ name: "deployment_restart", arguments: { namespace: "app-a-prd", name: "api" } }) as never);
    assert.equal(out.error, "approval_required");
    await client.close();
  });
});
