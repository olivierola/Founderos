// Passerelle d'entreprise (G7), de bout en bout, telle qu'elle est livrée :
// le lanceur deploy/gateway/gateway.mjs démarre le VRAI relais et le VRAI
// serveur MCP (jeton d'API, catalogue), comme dans l'image.
//
//   client MCP de FounderOS → file du relais (claim / complete, protocole réel)
//     → relais de la passerelle (liste blanche) → 127.0.0.1:<port> → serveur MCP
//     → faux Kubernetes
//
// Vérifie : un tool s'exécute ; le jeton d'API ne passe jamais en clair dans la
// file ; le relais ne joint que le serveur MCP voisin ; le port MCP n'écoute que
// sur la boucle locale ; un jeton faux est refusé ; un serveur MCP qui tombe
// arrête la passerelle. Seule la base de FounderOS est simulée.

import "../test-env.ts";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const cc = await import("../edge/_shared/custom-connectors.ts");
const relayMod = await import("../edge/_shared/mcp-relay.ts");
const { mcpCallTool } = await import("../edge/_shared/mcp-client.ts");
const { apiTokenHeaders } = await import("../edge/_shared/mcp-api-token.ts");
const { isRelayReachableMcpUrl } = await import("../edge/_shared/mcp-auth.ts");

const root = fileURLToPath(new URL("../../../", import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any */
const mcp = (p: string) => import(new URL(`../../../MCP/${p}`, import.meta.url).href);
const { generateToken } = await mcp("src/lib/api-tokens.ts") as { generateToken: (i: any) => { token: string; entry: any } };
const helpers = await mcp("test/helpers.ts") as {
  fakeUpstream: (r: Record<string, () => { json?: unknown }>) => Promise<{ url: string; calls: any[]; close(): Promise<void> }>;
};

type Job = { id: string; request: unknown; auth: null; refs: Record<string, string> };
type Done = { resolve: (r: any) => void; reject: (e: Error) => void };

/**
 * FounderOS, côté relais : connector-action en modes relay.claim / relay.complete.
 * La tâche porte ses secrets scellés jusqu'à la réclamation, comme claimPayload.
 */
function fakeFounderOS(relayToken: string) {
  const queue: Job[] = [];
  const waiting: Array<(j: Job | null) => void> = [];
  const pending = new Map<string, Done>();
  const queued: string[] = [];
  let claims = 0;
  const readBody = (req: IncomingMessage) => new Promise<any>((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => resolve(s ? JSON.parse(s) : {}));
  });
  const server: Server = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const reply = (status: number, json: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.url !== "/functions/v1/connector-action") return reply(404, { error: "inconnu" });
    if (req.headers["x-relay-token"] !== relayToken) return reply(401, { error: "Jeton de relais inconnu ou révoqué" });
    if (body.mode === "relay.claim") {
      claims++;
      const job = queue.shift() ?? await new Promise<Job | null>((resolve) => {
        waiting.push(resolve);
        setTimeout(() => { const i = waiting.indexOf(resolve); if (i >= 0) { waiting.splice(i, 1); resolve(null); } }, 500);
      });
      return reply(200, { ok: true, job });
    }
    if (body.mode === "relay.complete") {
      const done = pending.get(body.job_id);
      pending.delete(body.job_id);
      if (done) {
        if (body.error && !body.status) done.reject(new Error(`Le relais a échoué : ${body.error}`));
        else done.resolve({ status: body.status, headers: body.headers ?? {}, body: body.body ?? "", truncated: !!body.truncated, duration_ms: body.duration_ms ?? 0 });
      }
      return reply(200, { ok: !!done });
    }
    return reply(400, { error: "mode inconnu" });
  });
  /** Ce que relayJob fait : mettre la tâche en file, attendre son résultat. */
  const submit = (req: any, secrets: Record<string, string>) => new Promise<any>((resolve, reject) => {
    queued.push(JSON.stringify(req));
    const job: Job = { id: randomUUID(), request: cc.materializeJobRequest(req, secrets), auth: null, refs: {} };
    pending.set(job.id, { resolve, reject });
    const w = waiting.shift();
    if (w) w(job); else queue.push(job);
  });
  return { server, submit, queued, claims: () => claims };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Démarre la passerelle ; renvoie le processus, ses journaux et les PID de ses enfants. */
function startGateway(env: Record<string, string>) {
  const child = spawn(process.execPath, [path.join(root, "deploy/gateway/gateway.mjs")], {
    env: {
      PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
      // Le serveur MCP depuis ses sources (l'image, elle, lance mcp/dist/main.js).
      NODE_OPTIONS: `--import ${import.meta.resolve("tsx")}`,
      GATEWAY_MCP_MAIN: path.join(root, "MCP/src/main.ts"),
      GATEWAY_RELAY_MAIN: path.join(root, "connector-relay/src/index.js"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", (c) => { logs += c; });
  child.stderr!.on("data", (c) => { logs += c; });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const pids = () => [...logs.matchAll(/"pid":(\d+)/g)].map((m) => Number(m[1]));
  return { child, exited, logs: () => logs, pids };
}

/** Sous Windows, tuer la passerelle ne tue pas ses enfants. */
function killTree(gw: { child: ChildProcess; pids: () => number[] }) {
  for (const pid of gw.pids()) { try { process.kill(pid); } catch { /* déjà arrêté */ } }
  try { gw.child.kill(); } catch { /* déjà arrêté */ }
}

async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string, logs: () => string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch { /* pas encore */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`délai dépassé : ${what}\n${logs()}`);
}

describe("passerelle d'entreprise (G7), de bout en bout", { timeout: 60_000 }, () => {
  const relayToken = `fosr_${randomBytes(16).toString("hex")}`;
  const founderos = fakeFounderOS(relayToken);
  let k8s: Awaited<ReturnType<typeof helpers.fakeUpstream>>;
  let gw: ReturnType<typeof startGateway>;
  let mcpPort = 0;
  let mgmtPort = 0;
  let mcpUrl = "";
  let apiToken = "";
  let dir = "";
  let founderosUrl = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "g7-"));
    k8s = await helpers.fakeUpstream({
      "GET /api/v1/namespaces/app-a-prd/pods": () => ({
        json: { items: [{ metadata: { name: "api-1", creationTimestamp: "2026-10-11T00:00:00Z" }, spec: { nodeName: "n1", containers: [{ name: "api" }] }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] } }] },
      }),
    });
    await new Promise<void>((r) => founderos.server.listen(0, "127.0.0.1", r));
    founderosUrl = `http://127.0.0.1:${(founderos.server.address() as AddressInfo).port}`;

    // « À l'installation » : le jeton d'API, dont la passerelle ne garde que l'empreinte.
    const gen = generateToken({ label: "founderos", roles: ["ai-ops-reader"], scopes: ["ocp:read"] });
    apiToken = gen.token;
    writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ tokens: [gen.entry] }));
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      api: { url: k8s.url }, namespaces: ["app-a-prd"],
      readCredential: { type: "env", name: "K8S_TOKEN" }, writeCredential: { type: "env", name: "K8S_TOKEN" },
    }));

    mcpPort = await freePort();
    mgmtPort = await freePort();
    mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
    gw = startGateway({
      FOUNDEROS_URL: founderosUrl, RELAY_TOKEN: relayToken, RELAY_ALLOWED_HOSTS: "",
      GATEWAY_MCP_SERVERS: "openshift", GATEWAY_MCP_PORT: String(mcpPort), MGMT_PORT: String(mgmtPort),
      MCP_CLUSTER: "prd", MCP_TOKENS_FILE: path.join(dir, "tokens.json"), MCP_CONFIG_FILE: path.join(dir, "config.json"),
      CATALOG_FILE: path.join(root, "MCP/policies/catalog/data.json"), POLICY_ENGINE: "builtin",
      K8S_TOKEN: "sa-token",
    });
    await until(async () => (await fetch(`http://127.0.0.1:${mgmtPort}/readyz`)).ok, 30_000, "serveur MCP prêt", gw.logs);
    await until(() => founderos.claims() > 0, 15_000, "le relais réclame des tâches", gw.logs);
  });

  after(async () => {
    if (gw) killTree(gw);
    founderos.server.closeAllConnections();
    await new Promise<void>((r) => founderos.server.close(() => r()));
    await k8s?.close();
  });

  const viaGateway = () => relayMod.relayFetchFor(null, { relayId: "gw-1", workspaceId: "ws-1", mcpServerId: "srv-1" }, founderos.submit);

  it("FounderOS accepte l'adresse en boucle locale par un relais, jamais en direct", () => {
    assert.equal(isRelayReachableMcpUrl(mcpUrl), true);
    assert.equal(isRelayReachableMcpUrl("http://localhost:8443/mcp"), true);
    assert.equal(isRelayReachableMcpUrl("http://10.0.0.5:8443/mcp"), false);
    assert.equal(isRelayReachableMcpUrl("https://mcp-prd.interne/mcp"), true);
  });

  it("un tool s'exécute par la passerelle, au nom de la personne, sans jeton en clair dans la file", async () => {
    const headers = apiTokenHeaders({ token: apiToken, userId: "u-alice", agentName: "agent-ops-investigator" });
    const out = await mcpCallTool(mcpUrl, headers, "pods_list", { namespace: "app-a-prd" }, undefined, { fetch: viaGateway() });
    assert.ok(!out.startsWith("ERROR:"), `${out}\n${gw.logs()}`);
    assert.match(out, /api-1/);
    assert.ok(founderos.queued.length >= 2, "initialize puis tools/call");
    assert.ok(founderos.queued.every((q) => !q.includes(apiToken)), "aucune tâche en file ne contient le jeton d'API");
    assert.equal(k8s.calls.at(-1)!.headers.authorization, "Bearer sa-token");
    // L'audit du serveur MCP nomme la personne et l'agent.
    assert.match(gw.logs(), /u-alice/);
  });

  it("un jeton d'API faux est refusé par le serveur MCP", async () => {
    const forged = `${apiToken.slice(0, -4)}AAAA`;
    const out = await mcpCallTool(mcpUrl, apiTokenHeaders({ token: forged, userId: "u-alice" }), "pods_list", { namespace: "app-a-prd" }, undefined, { fetch: viaGateway() })
      .catch((e: Error) => `ERROR: ${e.message}`);
    assert.match(out, /^ERROR:/);
    assert.match(out, /initialize failed.*jeton refusé/, out);
  });

  it("le relais ne joint que le serveur MCP voisin : un autre port local est refusé chez le client", async () => {
    const k8sPort = new URL(k8s.url).port;
    const fetchVia = relayMod.relayFetchFor(null, { relayId: "gw-1", workspaceId: "ws-1" }, founderos.submit);
    await assert.rejects(
      mcpCallTool(`http://127.0.0.1:${k8sPort}/mcp`, { Authorization: "Bearer x" }, "pods_list", {}, undefined, { fetch: fetchVia }),
      new RegExp(`127\\.0\\.0\\.1:${k8sPort} n'est pas dans RELAY_ALLOWED_HOSTS`),
    );
  });

  it("le port MCP n'écoute que sur la boucle locale ; la supervision, partout", async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!lan) return t.skip("aucune adresse IPv4 hors boucle locale");
    const reach = (host: string, port: number) => new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port, timeout: 1500 });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
      s.once("timeout", () => { s.destroy(); resolve(false); });
    });
    assert.equal(await reach("127.0.0.1", mcpPort), true);
    assert.equal(await reach(lan, mcpPort), false, `le port MCP ne doit pas répondre sur ${lan}`);
    assert.equal(await reach(lan, mgmtPort), true, "/metrics et les sondes restent joignables");
  });

  it("si le serveur MCP tombe, la passerelle s'arrête en erreur : le pod redémarre", async () => {
    const mcpPid = gw.pids()[0];
    process.kill(mcpPid);
    const code = await gw.exited;
    assert.notEqual(code, 0);
    assert.match(gw.logs(), /serveur MCP s'est arrêté : la passerelle s'arrête/);
  });
});
