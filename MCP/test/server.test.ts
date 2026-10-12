// Intégration : un vrai client MCP (SDK) contre le serveur démarré, avec un
// Keycloak simulé (clés locales) et un faux Argo CD.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuditEvent } from "../src/lib/audit.ts";
import { createAccessTokenVerifier } from "../src/lib/auth.ts";
import { loadCatalog, type Cluster } from "../src/lib/catalog.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import { checkAgainstCatalog, startServer, type RunningServer } from "../src/lib/server.ts";
import { SERVERS } from "../src/servers/index.ts";
import { accessToken, fakeSecrets, fakeUpstream, ISSUER, resultJson, signingKey } from "./helpers.ts";

const catalog = loadCatalog();

function openshiftServerConfigOk() {
  SERVERS.openshift.configSchema.parse(JSON.parse(readFileSync(new URL("../config/examples/openshift.npr.json", import.meta.url), "utf8")));
}

async function start(cluster: Cluster, upstreamUrl: string, jwks: Awaited<ReturnType<typeof signingKey>>["jwks"], audit: AuditEvent[]) {
  return startServer({
    module: SERVERS.argocd,
    config: { url: upstreamUrl, token: { type: "kv", path: "mcp-argocd/token", key: "token" }, projects: ["team-pay"] },
    cluster,
    catalog,
    policy: new BuiltinPolicyEngine(catalog),
    verifyToken: createAccessTokenVerifier({ issuer: ISSUER, audience: `mcp-argocd-${cluster}`, jwks }),
    secrets: fakeSecrets,
    audit: (e) => audit.push(e),
    mcpPort: 0,
    mgmtPort: 0,
    insecureHttp: true,
    host: "127.0.0.1",
  });
}

const portOf = (s: RunningServer["mcp"]) => (s.address() as AddressInfo).port;

async function connect(port: number, token?: string) {
  const client = new Client({ name: "founderos-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "x-session-id": "run-123", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } },
  });
  await client.connect(transport);
  return client;
}

describe("serveur MCP (intégration)", async () => {
  const keys = await signingKey();
  const audit: AuditEvent[] = [];
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let prd: RunningServer;
  let npr: RunningServer;

  before(async () => {
    up = await fakeUpstream({
      "GET /api/v1/applications/payment": () => ({ json: { metadata: { name: "payment" }, spec: { project: "team-pay" }, status: { sync: { status: "Synced", revision: "abc" }, health: { status: "Healthy" } } } }),
    });
    prd = await start("prd", up.url, keys.jwks, audit);
    npr = await start("npr", up.url, keys.jwks, audit);
  });
  after(async () => {
    await prd.close();
    await npr.close();
    await up.close();
  });

  it("les configurations d'exemple sont valides, et chaque module correspond au catalogue", () => {
    const examples: Record<string, string> = {
      observability: "observability.hub.json", fleet: "fleet.hub.json", openshift: "openshift.prd.json",
      argocd: "argocd.prd.json", git: "git.ips.json", prtg: "prtg.ips.json",
    };
    for (const [key, mod] of Object.entries(SERVERS)) {
      const raw = JSON.parse(readFileSync(new URL(`../config/examples/${examples[key]}`, import.meta.url), "utf8"));
      const config = mod.configSchema.parse(raw);
      checkAgainstCatalog(mod.name, mod.createTools({ config, cluster: "npr", secrets: fakeSecrets }), catalog);
    }
    openshiftServerConfigOk();
  });

  it("refuse une connexion sans jeton d'appel", async () => {
    const res = await fetch(`http://127.0.0.1:${portOf(prd.mcp)}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
  });

  it("refuse un jeton destiné à un autre serveur", async () => {
    const token = await accessToken(keys.privateKey, { aud: "mcp-argocd-npr", scope: "argocd:read", roles: ["ai-ops-reader"] });
    const res = await fetch(`http://127.0.0.1:${portOf(prd.mcp)}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(res.status, 401);
  });

  it("en PRD, app_sync n'existe pas ; en NPR, si", async () => {
    const tPrd = await accessToken(keys.privateKey, { aud: "mcp-argocd-prd", scope: "argocd:read", roles: ["ai-ops-reader"] });
    const tNpr = await accessToken(keys.privateKey, { aud: "mcp-argocd-npr", scope: "argocd:read", roles: ["ai-ops-reader"] });
    const cPrd = await connect(portOf(prd.mcp), tPrd);
    const cNpr = await connect(portOf(npr.mcp), tNpr);
    const namesPrd = (await cPrd.listTools()).tools.map((t) => t.name).sort();
    const namesNpr = (await cNpr.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(namesPrd, ["app_diff", "app_history", "app_status"]);
    assert.deepEqual(namesNpr, ["app_diff", "app_history", "app_status", "app_sync"]);
    const sync = (await cNpr.listTools()).tools.find((t) => t.name === "app_sync");
    assert.equal(sync?.annotations?.readOnlyHint, false);
    await cPrd.close();
    await cNpr.close();
  });

  it("appel de bout en bout : résultat, audit corrélé (trace, session, utilisateur, agent)", async () => {
    audit.length = 0;
    const token = await accessToken(keys.privateKey, { aud: "mcp-argocd-prd", sub: "u-alice", azp: "agent-ops-investigator", scope: "argocd:read", roles: ["ai-ops-reader"] });
    const client = await connect(portOf(prd.mcp), token);
    const result = await client.callTool({ name: "app_status", arguments: { app: "payment" } });
    const body = resultJson(result as never);
    assert.equal(body.health, "Healthy");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(audit[0].session_id, "run-123");
    assert.equal(audit[0].user, "u-alice");
    assert.equal(audit[0].agent, "agent-ops-investigator");
    assert.equal(audit[0].policy_decision, "allow");
    // Le jeton d'appel n'est jamais relayé vers l'outil : seul l'identifiant Vault y va.
    assert.equal(up.calls.at(-1)!.headers.authorization, "Bearer secret-mcp-argocd/token");
    await client.close();
  });

  it("le port de gestion sert la santé et les métriques", async () => {
    const port = portOf(prd.mgmt);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(metrics, /ai_tool_calls_total\{cluster="prd",status="ok",tool="app_status"\} 1/);
  });
});
