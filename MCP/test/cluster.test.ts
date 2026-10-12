// Un serveur MCP par cluster (MCP_SERVER=openshift,argocd), et le JWKS
// d'approbation lu dans un fichier (ConfigMap), relu à chaque rotation.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApprovalVerifier, fileJwks } from "../src/lib/approval.ts";
import type { AuditEvent } from "../src/lib/audit.ts";
import { createAccessTokenVerifier } from "../src/lib/auth.ts";
import { loadCatalog, type Cluster } from "../src/lib/catalog.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import { checkAgainstCatalog, startServer, type RunningServer } from "../src/lib/server.ts";
import { combineModules, resolveServerModule, SERVERS } from "../src/servers/index.ts";
import { accessToken, APPROVAL_ISSUER, fakeSecrets, fakeUpstream, ISSUER, resultJson, signingKey } from "./helpers.ts";

const catalog = loadCatalog();
const example = (f: string) => JSON.parse(readFileSync(new URL(`../config/examples/${f}`, import.meta.url), "utf8"));

describe("un serveur par cluster", () => {
  it("une seule clé : le module tel quel ; plusieurs : un module composite « mcp »", () => {
    assert.equal(resolveServerModule("openshift"), SERVERS.openshift);
    assert.equal(resolveServerModule(" openshift , argocd ").name, "mcp");
    assert.throws(() => resolveServerModule("openshift,kubectl"), /MCP_SERVER inconnu : kubectl/);
    assert.throws(() => resolveServerModule("openshift,openshift"), /en double/);
    assert.throws(() => resolveServerModule(" , "), /vide/);
  });

  it("chaque module garde sa configuration ; une clé inconnue ou manquante est refusée", () => {
    const mod = combineModules(["openshift", "argocd"]);
    const config = mod.configSchema.parse({ openshift: example("openshift.prd.json"), argocd: example("argocd.prd.json") });
    const tools = mod.createTools({ config, cluster: "prd", secrets: fakeSecrets }).map((t) => t.name);
    assert.ok(tools.includes("deployment_restart") && tools.includes("app_status"));
    checkAgainstCatalog(mod.name, mod.createTools({ config, cluster: "prd", secrets: fakeSecrets }), catalog);
    assert.throws(() => mod.configSchema.parse({ openshift: example("openshift.prd.json") }));
    // Les regroupements de la doc (12.3) : aucun tool en double, tous au catalogue.
    const groups: Array<[Cluster, Record<string, string>]> = [
      ["hub", { observability: "observability.hub.json", fleet: "fleet.hub.json" }],
      ["ips", { openshift: "openshift.npr.json", argocd: "argocd.prd.json", git: "git.ips.json", prtg: "prtg.ips.json" }],
    ];
    for (const [cluster, files] of groups) {
      const group = combineModules(Object.keys(files));
      const cfg = group.configSchema.parse(Object.fromEntries(Object.entries(files).map(([k, f]) => [k, example(f)])));
      checkAgainstCatalog(group.name, group.createTools({ config: cfg, cluster, secrets: fakeSecrets }), catalog);
    }
    assert.throws(() => mod.configSchema.parse({
      openshift: example("openshift.prd.json"), argocd: example("argocd.prd.json"), git: example("git.ips.json"),
    }));
  });

  describe("intégration : PRD, OpenShift et Argo CD derrière mcp-prd", async () => {
    const keys = await signingKey();
    const audit: AuditEvent[] = [];
    let up: Awaited<ReturnType<typeof fakeUpstream>>;
    let server: RunningServer;

    before(async () => {
      up = await fakeUpstream({
        "GET /api/v1/applications/payment": () => ({ json: { metadata: { name: "payment" }, spec: { project: "team-a" }, status: { sync: { status: "Synced", revision: "abc" }, health: { status: "Healthy" } } } }),
      });
      const mod = combineModules(["openshift", "argocd"]);
      server = await startServer({
        module: mod,
        config: mod.configSchema.parse({
          openshift: { ...example("openshift.prd.json"), api: { url: up.url } },
          argocd: { ...example("argocd.prd.json"), url: up.url, caFile: undefined },
        }),
        cluster: "prd",
        catalog,
        policy: new BuiltinPolicyEngine(catalog),
        verifyToken: createAccessTokenVerifier({ issuer: ISSUER, audience: "mcp-prd", jwks: keys.jwks }),
        secrets: fakeSecrets,
        audit: (e) => audit.push(e),
        mcpPort: 0,
        mgmtPort: 0,
        insecureHttp: true,
        host: "127.0.0.1",
      });
    });
    after(async () => {
      await server.close();
      await up.close();
    });

    const connect = async (token: string) => {
      const client = new Client({ name: "founderos-test", version: "0.0.1" });
      const port = (server.mcp.address() as AddressInfo).port;
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      return client;
    };

    it("expose les tools des deux modules prévus pour PRD, et ceux-là seulement", async () => {
      const token = await accessToken(keys.privateKey, { aud: "mcp-prd", scope: "argocd:read ocp:read", roles: ["ai-ops-reader"] });
      const client = await connect(token);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "app_diff", "app_history", "app_status",
        "deployment_restart", "deployment_status", "events_list", "pod_logs", "pods_list",
      ]);
      await client.close();
    });

    it("un tool d'Argo CD s'exécute avec l'identifiant Argo CD, audité sous mcp", async () => {
      audit.length = 0;
      const token = await accessToken(keys.privateKey, { aud: "mcp-prd", scope: "argocd:read", roles: ["ai-ops-reader"] });
      const client = await connect(token);
      const body = resultJson(await client.callTool({ name: "app_status", arguments: { app: "payment" } }) as never);
      assert.equal(body.health, "Healthy");
      assert.equal(up.calls.at(-1)!.headers.authorization, "Bearer secret-mcp/prd/argocd/project-role");
      assert.equal(audit[0].mcp_server, "mcp");
      assert.equal(audit[0].cluster, "prd");
      await client.close();
    });

    it("le jeton d'un serveur par outil (mcp-argocd-prd) n'ouvre pas le serveur du cluster", async () => {
      const token = await accessToken(keys.privateKey, { aud: "mcp-argocd-prd", scope: "argocd:read", roles: ["ai-ops-reader"] });
      const port = (server.mcp.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 401);
    });
  });
});

describe("JWKS d'approbation dans un fichier", () => {
  const expected = { requester: "u-alice", tool: "deployment_restart", targetCluster: "prd", paramsHash: "a".repeat(64) };

  async function es256Key(kid: string) {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" } };
  }
  const sign = (privateKey: CryptoKey, kid: string) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ approver: "u-bob", tool: expected.tool, target_cluster: "prd", params_hash: expected.paramsHash })
      .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
      .setIssuer(APPROVAL_ISSUER).setAudience("mcp-prd").setSubject("u-alice").setJti("ap-1")
      .setIssuedAt(now).setExpirationTime(now + 300)
      .sign(privateKey);
  };

  it("accepte la clé publiée, puis la nouvelle après rotation de la ConfigMap", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jwks-"));
    const file = path.join(dir, "jwks.json");
    const k1 = await es256Key("k1");
    const k2 = await es256Key("k2");
    writeFileSync(file, JSON.stringify({ keys: [k1.jwk] }));
    const verify = createApprovalVerifier({ issuer: APPROVAL_ISSUER, audience: "mcp-prd", jwks: fileJwks(file, 0) });

    assert.equal((await verify(await sign(k1.privateKey as CryptoKey, "k1"), expected)).approver, "u-bob");
    await assert.rejects(verify(await sign(k2.privateKey as CryptoKey, "k2"), expected), /refusé/);

    // Rotation : la nouvelle clé est publiée avant d'être utilisée (17.3).
    writeFileSync(file, JSON.stringify({ keys: [k1.jwk, k2.jwk] }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.equal((await verify(await sign(k2.privateKey as CryptoKey, "k2"), expected)).id, "ap-1");
  });

  it("un fichier qui n'est pas un JWKS est refusé dès le démarrage", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jwks-"));
    const file = path.join(dir, "jwks.json");
    writeFileSync(file, JSON.stringify({ nope: true }));
    assert.throws(() => fileJwks(file), /n'est pas un JWKS/);
  });
});
