// Jeton tournant d'un serveur MCP, de bout en bout :
//
//   1. à l'installation, le jeton de la période est collé dans FounderOS ;
//   2. l'agent appelle le VRAI serveur MCP avec ce jeton ;
//   3. à la période suivante, le serveur livre lui-même le nouveau jeton à
//      FounderOS (vrai TokenPusher, par HTTP, mode mcp.token_push) ;
//      l'ancien reste accepté le temps de la livraison ;
//   4. FounderOS arrêté trois périodes : le jeton qu'il détient est refusé,
//      puis la livraison reprend seule et les appels repassent ;
//   5. un jeton volé hier ne permet pas de livrer un jeton.
//
// Seule la base de FounderOS est en mémoire ; l'horloge est commune et avancée à la main.

import "../test-env.ts";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { memoryDb } from "../test-memory-db.ts";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { mcpCallTool } = await import("../edge/_shared/mcp-client.ts");
const { acceptPushedMcpToken, apiTokenHeaders, loadMcpApiTokens, saveMcpApiToken } = await import("../edge/_shared/mcp-api-token.ts");

/* eslint-disable @typescript-eslint/no-explicit-any */
const mcp = (p: string) => import(new URL(`../../../MCP/${p}`, import.meta.url).href);
const { startServer } = await mcp("src/lib/server.ts") as { startServer: (o: any) => Promise<any> };
const { combineModules } = await mcp("src/servers/index.ts") as { combineModules: (k: string[]) => any };
const { BuiltinPolicyEngine } = await mcp("src/lib/policy.ts") as { BuiltinPolicyEngine: new (c: any) => any };
const { loadCatalog } = await mcp("src/lib/catalog.ts") as { loadCatalog: () => any };
const rt = await mcp("src/lib/rotating-token.ts") as {
  generateSeed: () => string; parseSeed: (s: string) => Buffer; tokenFor: (s: Buffer, e: number) => string; epochOf: (n: number, p: number) => number;
  currentToken: (s: Buffer, p: number, n?: number) => string;
  createRotatingTokenVerifier: (o: any) => any; composeTokenVerifiers: (r: any, f?: any) => any;
  TokenPusher: new (o: any) => { tick(): Promise<string> };
};
const helpers = await mcp("test/helpers.ts") as {
  fakeUpstream: (r: Record<string, () => { json?: unknown }>) => Promise<{ url: string; calls: any[]; close(): Promise<void> }>;
};

const DAY = 86_400_000;
const T0 = 20_000 * DAY + DAY / 2;
const E0 = rt.epochOf(T0, DAY);

describe("jeton tournant d'un serveur MCP, de bout en bout", { timeout: 30_000 }, () => {
  const seed = rt.parseSeed(rt.generateSeed());
  let now = T0;
  const db = memoryDb({ mcp_servers: [{ id: "srv-prd", workspace_id: "ws-1" }], mcp_server_secrets: [] }, { mcp_server_secrets: "server_id" });
  let server: any;
  let k8s: Awaited<ReturnType<typeof helpers.fakeUpstream>>;
  let founderos: Server;
  let mcpUrl = "";
  let founderosUrl = "";
  const pushes: number[] = [];

  before(async () => {
    k8s = await helpers.fakeUpstream({
      "GET /api/v1/namespaces/app-a-prd/pods": () => ({ json: { items: [{ metadata: { name: "api-1" }, spec: { containers: [] }, status: { phase: "Running" } }] } }),
    });
    const catalog = loadCatalog();
    const mod = combineModules(["openshift"]);
    const rotating = rt.createRotatingTokenVerifier({
      seed, periodMs: DAY, roles: ["ai-ops-reader"], scopes: catalog.role_scopes["ai-ops-reader"], now: () => now,
    });
    server = await startServer({
      module: mod,
      config: mod.configSchema.parse({ openshift: { api: { url: k8s.url }, namespaces: ["app-a-prd"], readCredential: { type: "env", name: "X" } } }),
      cluster: "prd", catalog, policy: new BuiltinPolicyEngine(catalog),
      verifyToken: rt.composeTokenVerifiers(rotating), secrets: { resolve: async () => "sa-token" }, audit: () => {},
      mcpPort: 0, mgmtPort: 0, insecureHttp: true, host: "127.0.0.1",
    });
    mcpUrl = `http://127.0.0.1:${(server.mcp.address() as AddressInfo).port}/mcp`;

    // FounderOS : la branche mcp.token_push de connector-action.
    founderos = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        const body = JSON.parse(raw || "{}");
        if (req.url !== "/functions/v1/connector-action" || body.mode !== "mcp.token_push") { res.writeHead(404); res.end(); return; }
        const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        const out = await acceptPushedMcpToken(db.admin, presented, String(body.token ?? ""));
        pushes.push(out.status);
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => founderos.listen(0, "127.0.0.1", r));
    founderosUrl = `http://127.0.0.1:${(founderos.address() as AddressInfo).port}`;
  });

  after(async () => {
    await server.close();
    await k8s.close();
    founderos.close();
  });

  /** Ce que fait internal-agent-run : le jeton détenu, la personne et l'agent. */
  const agentCall = async () => {
    const token = (await loadMcpApiTokens(db.admin, ["srv-prd"])).get("srv-prd")!;
    return await mcpCallTool(mcpUrl, apiTokenHeaders({ token, userId: "u-alice", agentName: "agent-ops-investigator" }), "pods_list", { namespace: "app-a-prd" });
  };
  const pusher = () => new rt.TokenPusher({ seed, periodMs: DAY, founderosUrl, now: () => now, log: () => {} });

  it("1-2. enrôlement : le jeton de la période, collé une fois ; l'agent appelle le serveur", async () => {
    await saveMcpApiToken(db.admin, "srv-prd", rt.currentToken(seed, DAY, now), "u-admin");
    const out = await agentCall();
    assert.ok(!out.startsWith("ERROR:"), out);
    assert.match(out, /api-1/);
    assert.equal(await pusher().tick(), "current", "FounderOS a déjà le jeton de la période");
  });

  it("3. période suivante : l'ancien jeton passe encore ; le serveur livre le nouveau ; FounderOS l'utilise", async () => {
    now = T0 + DAY;
    assert.ok(!(await agentCall()).startsWith("ERROR:"), "le jeton d'hier, le temps de la livraison");
    assert.equal(await pusher().tick(), "delivered");
    assert.equal((await loadMcpApiTokens(db.admin, ["srv-prd"])).get("srv-prd"), rt.tokenFor(seed, E0 + 1));
    assert.equal(db.tables.mcp_servers[0].token_origin, "push");
    assert.match(await agentCall(), /api-1/);
    assert.equal(await pusher().tick(), "current", "deuxième réplique : déjà livré");
  });

  it("4. FounderOS arrêté trois périodes : appels refusés, puis livraison reprise seule, appels rétablis", async () => {
    now = T0 + 4 * DAY;
    const refused = await agentCall();
    assert.match(refused, /^ERROR:/);
    assert.match(refused, /périmé ou inconnu/);
    assert.equal(await pusher().tick(), "delivered");
    assert.equal((await loadMcpApiTokens(db.admin, ["srv-prd"])).get("srv-prd"), rt.tokenFor(seed, E0 + 4));
    assert.match(await agentCall(), /api-1/);
    assert.equal(k8s.calls.at(-1)!.headers.authorization, "Bearer sa-token");
  });

  it("5. un jeton volé hier ne livre rien ; le jeton détenu ne bouge pas", async () => {
    const res = await fetch(`${founderosUrl}/functions/v1/connector-action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rt.tokenFor(seed, E0 + 3)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "mcp.token_push", token: rt.tokenFor(seed, E0 + 9) }),
    });
    assert.equal(res.status, 401);
    assert.equal((await loadMcpApiTokens(db.admin, ["srv-prd"])).get("srv-prd"), rt.tokenFor(seed, E0 + 4));
    assert.ok(pushes.includes(401));
  });
});
