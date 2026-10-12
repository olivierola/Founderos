// Jeton d'API tournant : calculé à chaque période depuis une graine qui ne
// quitte pas le serveur, livré par le serveur lui-même à FounderOS.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApiTokenVerifier, generateToken } from "../src/lib/api-tokens.ts";
import { AuthError } from "../src/lib/auth.ts";
import { loadCatalog } from "../src/lib/catalog.ts";
import { Metrics } from "../src/lib/metrics.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import {
  composeTokenVerifiers, createRotatingTokenVerifier, currentToken, epochOf, generateSeed, parseDuration, parseSeed,
  tokenFor, tokenIdOf, TokenPusher, type PushTransport,
} from "../src/lib/rotating-token.ts";
import { startServer, type RunningServer } from "../src/lib/server.ts";
import { combineModules } from "../src/servers/index.ts";
import { fakeUpstream } from "./helpers.ts";

const DAY = 86_400_000;
const seed = parseSeed(generateSeed());
// Au milieu d'une période : loin des deux bords.
const T0 = 20_000 * DAY + DAY / 2;
const E0 = epochOf(T0, DAY);

describe("le jeton se calcule", () => {
  it("même graine, même période : même jeton, sur toutes les répliques ; l'id ne change pas d'une période à l'autre", () => {
    const t = tokenFor(seed, E0);
    assert.match(t, /^mcpt_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokenFor(parseSeed(seed.toString("base64url")), E0), t);
    assert.notEqual(tokenFor(seed, E0 + 1), t);
    assert.equal(tokenFor(seed, E0 + 1).slice(0, 14), t.slice(0, 14));
    assert.equal(t.slice(5, 13), tokenIdOf(seed));
    assert.notEqual(tokenFor(parseSeed(generateSeed()), E0), t, "une autre graine, un autre jeton");
    assert.equal(currentToken(seed, DAY, T0), t);
  });

  it("graine et durée : formes refusées", () => {
    assert.throws(() => parseSeed("trop-court"), /trop courte/);
    assert.throws(() => parseSeed("pas de base64 !"), /base64url/);
    assert.equal(parseDuration("24h"), DAY);
    assert.equal(parseDuration("30m"), 1_800_000);
    assert.equal(parseDuration("7d"), 7 * DAY);
    assert.throws(() => parseDuration("1 semaine"), /durée invalide/);
  });
});

describe("ce que le serveur accepte", () => {
  let now = T0;
  const v = createRotatingTokenVerifier({ seed, periodMs: DAY, roles: ["ai-ops-reader"], scopes: ["ocp:read"], now: () => now });

  it("la période courante et la précédente ; ni l'avant-dernière, ni la suivante loin du bord", async () => {
    now = T0;
    assert.equal((await v.verify(tokenFor(seed, E0))).tokenId, v.tokenId);
    assert.ok(await v.verify(tokenFor(seed, E0 - 1)));
    await assert.rejects(v.verify(tokenFor(seed, E0 - 2)), /périmé ou inconnu/);
    await assert.rejects(v.verify(tokenFor(seed, E0 + 1)), /périmé ou inconnu/);
  });

  it("la suivante, dans les dernières minutes de la période (horloges décalées entre répliques)", async () => {
    now = (E0 + 1) * DAY - 60_000;
    assert.ok(await v.verify(tokenFor(seed, E0 + 1)));
    now = (E0 + 1) * DAY - 10 * 60_000;
    await assert.rejects(v.verify(tokenFor(seed, E0 + 1)));
  });

  it("l'identité : les rôles du jeton, la personne affirmée par FounderOS, sinon token:<id>", async () => {
    now = T0;
    const who = await v.verify(tokenFor(seed, E0), { user: "u-alice", agent: "agent-ops-investigator" });
    assert.deepEqual([who.sub, who.azp, who.roles, who.scopes], ["u-alice", "agent-ops-investigator", ["ai-ops-reader"], ["ocp:read"]]);
    assert.equal((await v.verify(tokenFor(seed, E0))).sub, `token:${v.tokenId}`);
  });

  it("un jeton d'une autre graine, ou mal formé, est refusé ; les jetons du fichier restent acceptés à côté", async () => {
    now = T0;
    const other = parseSeed(generateSeed());
    await assert.rejects(v.verify(tokenFor(other, E0)), AuthError);
    await assert.rejects(v.verify("Bearer n'importe quoi"), /format inconnu/);
    const fixed = generateToken({ label: "secours", roles: ["ai-ops-reader"], scopes: ["ocp:read"] });
    const both = composeTokenVerifiers(v, createApiTokenVerifier({ entries: [fixed.entry] }));
    assert.equal((await both(fixed.token)).username, "secours");
    assert.equal((await both(tokenFor(seed, E0))).tokenId, v.tokenId);
    await assert.rejects(composeTokenVerifiers(v)(fixed.token), /jeton refusé/);
  });

  it("durée trop courte refusée", () => {
    assert.throws(() => createRotatingTokenVerifier({ seed, periodMs: 1000, roles: [], scopes: [] }), /une minute/);
  });
});

describe("le serveur MCP, avec le jeton tournant", () => {
  let server: RunningServer;
  let k8s: Awaited<ReturnType<typeof fakeUpstream>>;
  let url = "";
  let now = T0;

  before(async () => {
    k8s = await fakeUpstream({ "GET /api/v1/namespaces/app-a/pods": () => ({ json: { items: [] } }) });
    const catalog = loadCatalog();
    const mod = combineModules(["openshift"]);
    const rotating = createRotatingTokenVerifier({ seed, periodMs: DAY, roles: ["ai-ops-reader"], scopes: catalog.role_scopes["ai-ops-reader"], now: () => now });
    server = await startServer({
      module: mod,
      config: mod.configSchema.parse({ openshift: { api: { url: k8s.url }, namespaces: ["app-a"], readCredential: { type: "env", name: "X" } } }),
      cluster: "npr", catalog, policy: new BuiltinPolicyEngine(catalog),
      verifyToken: composeTokenVerifiers(rotating), secrets: { resolve: async () => "sa" }, audit: () => {},
      mcpPort: 0, mgmtPort: 0, insecureHttp: true, host: "127.0.0.1",
    });
    url = `http://127.0.0.1:${(server.mcp.address() as AddressInfo).port}/mcp`;
  });
  after(async () => {
    await server.close();
    await k8s.close();
  });

  const list = (token: string) => fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  it("le jeton de la période répond ; celui d'avant-hier est refusé en 401", async () => {
    now = T0;
    assert.equal((await list(tokenFor(seed, E0))).status, 200);
    const old = await list(tokenFor(seed, E0 - 2));
    assert.equal(old.status, 401);
    assert.match(await old.text(), /périmé ou inconnu/);
  });
});

/** FounderOS, vu du serveur : la règle de connector-action (mode mcp.token_push). */
function fakeFounderOS(initial: string | null) {
  const state = { stored: initial, calls: [] as Array<{ auth: string; token: string }> };
  const transport: PushTransport = async (_url, auth, body) => {
    state.calls.push({ auth, token: String(body.token) });
    if (state.stored === body.token) return { status: 200, body: { ok: true, unchanged: true, updated: 0 } };
    if (state.stored !== null && state.stored === auth) {
      state.stored = String(body.token);
      return { status: 200, body: { ok: true, updated: 1 } };
    }
    return { status: 401, body: { ok: false } };
  };
  return { state, transport };
}

describe("la livraison à FounderOS", () => {
  const logs: string[] = [];
  const log = (level: string, msg: string, extra?: Record<string, unknown>) => { logs.push(JSON.stringify({ level, msg, ...extra })); };
  const pusher = (transport: PushTransport, now: () => number, metrics?: Metrics) =>
    new TokenPusher({ seed, periodMs: DAY, founderosUrl: "https://founderos.test/", transport, now, log, metrics });

  it("nouvelle période : le jeton est poussé, avec pour preuve celui que FounderOS détient", async () => {
    const f = fakeFounderOS(tokenFor(seed, E0 - 1));
    const p = pusher(f.transport, () => T0);
    assert.equal(await p.tick(), "delivered");
    assert.equal(f.state.stored, tokenFor(seed, E0));
    assert.deepEqual(f.state.calls, [{ auth: tokenFor(seed, E0 - 1), token: tokenFor(seed, E0) }]);
    assert.equal(p.delivered(), true);
    assert.equal(await p.tick(), "skipped", "une fois par période");
  });

  it("juste après l'enrôlement, FounderOS a déjà le jeton : rien ne change", async () => {
    const f = fakeFounderOS(tokenFor(seed, E0));
    assert.equal(await pusher(f.transport, () => T0).tick(), "current");
  });

  it("deux répliques : la seconde trouve le jeton déjà livré", async () => {
    const f = fakeFounderOS(tokenFor(seed, E0 - 1));
    assert.equal(await pusher(f.transport, () => T0).tick(), "delivered");
    assert.equal(await pusher(f.transport, () => T0).tick(), "current");
    assert.equal(f.state.stored, tokenFor(seed, E0));
  });

  it("FounderOS a manqué trois périodes : la livraison reprend seule ; au-delà de lookback, réenrôlement demandé", async () => {
    const late = fakeFounderOS(tokenFor(seed, E0 - 3));
    assert.equal(await pusher(late.transport, () => T0).tick(), "delivered");
    assert.equal(late.state.stored, tokenFor(seed, E0));
    assert.equal(late.state.calls.length, 3);
    const lost = fakeFounderOS(tokenFor(seed, E0 - 9));
    assert.equal(await pusher(lost.transport, () => T0).tick(), "unknown");
    assert.equal(lost.state.calls.length, 7);
    assert.match(logs.at(-1)!, /réenrôlez le serveur/);
  });

  it("FounderOS injoignable : nouvel essai au tick suivant ; une erreur 5xx n'essaie pas d'autres jetons", async () => {
    let down = true;
    const f = fakeFounderOS(tokenFor(seed, E0 - 1));
    const flaky: PushTransport = async (u, a, b) => { if (down) throw new Error("ECONNREFUSED"); return f.transport(u, a, b); };
    const metrics = new Metrics();
    const p = pusher(flaky, () => T0, metrics);
    assert.equal(await p.tick(), "error");
    down = false;
    assert.equal(await p.tick(), "delivered");
    const five: PushTransport = async () => ({ status: 503, body: null });
    let n = 0;
    assert.equal(await pusher(async (...args) => { n++; return five(...args); }, () => T0).tick(), "error");
    assert.equal(n, 1);
    assert.match(metrics.render(), /mcp_token_push_total\{result="error"\} 1/);
    assert.match(metrics.render(), /mcp_token_push_total\{result="delivered"\} 1/);
  });

  it("aucun jeton dans les journaux : l'id et la période seulement", () => {
    const all = logs.join("\n");
    for (let e = E0 - 10; e <= E0 + 1; e++) assert.ok(!all.includes(tokenFor(seed, e).slice(14)), `jeton de la période ${e} dans les journaux`);
    assert.match(all, new RegExp(`"token_id":"${tokenIdOf(seed)}"`));
  });

  it("par HTTP : POST /functions/v1/connector-action, la preuve en Bearer, le nouveau jeton dans le corps", async () => {
    let seen: { url?: string; auth?: string; body?: any } = {};
    const srv = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated: 2 }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const p = new TokenPusher({ seed, periodMs: DAY, founderosUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, now: () => T0, log });
      assert.equal(await p.tick(), "delivered");
      assert.equal(seen.url, "/functions/v1/connector-action");
      assert.equal(seen.auth, `Bearer ${tokenFor(seed, E0 - 1)}`);
      assert.deepEqual(seen.body, { mode: "mcp.token_push", token: tokenFor(seed, E0), period_seconds: 86400 });
    } finally {
      srv.close();
    }
  });
});
