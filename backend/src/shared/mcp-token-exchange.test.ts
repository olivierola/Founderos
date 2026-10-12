// Jetons Keycloak conservés (idp-tokens) et jeton d'appel MCP (mcp-auth),
// contre un faux Keycloak qui applique les mêmes règles que le vrai : rotation
// du jeton de rafraîchissement, audiences autorisées par client, sub et azp.

import "../test-env.ts";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

// ── Faux Keycloak ────────────────────────────────────────────────────────────
const CLIENTS: Record<string, { secret: string; audiences: string[] }> = {
  "ai-portal": { secret: "portal-secret", audiences: [] },
  "agent-ops-investigator": { secret: "inv-secret", audiences: ["mcp-openshift-prd", "mcp-argocd-prd"] },
  "agent-ops-change": { secret: "chg-secret", audiences: ["mcp-git-ips"] },
};
const refreshTokens = new Map<string, { sub: string; valid: boolean }>();
const accessTokens = new Map<string, { sub: string }>();
const calls: Array<Record<string, string>> = [];

function issueAccess(sub: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt({ sub, iat: now, exp: now + 300, jti: randomBytes(6).toString("hex"), realm_access: { roles: ["ai-ops-reader"] }, ...extra });
  accessTokens.set(token, { sub });
  return token;
}
function issueRefresh(sub: string) {
  const rt = `rt-${randomBytes(8).toString("hex")}`;
  refreshTokens.set(rt, { sub, valid: true });
  return rt;
}

const kc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const f = Object.fromEntries(new URLSearchParams(body));
    calls.push(f);
    const send = (status: number, json: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.url?.endsWith("/revoke")) {
      const r = refreshTokens.get(f.token);
      if (r) r.valid = false;
      return send(200, {});
    }
    const client = CLIENTS[f.client_id];
    if (!client || client.secret !== f.client_secret) return send(401, { error: "unauthorized_client" });
    if (f.grant_type === "refresh_token") {
      const r = refreshTokens.get(f.refresh_token);
      if (!r || !r.valid) return send(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
      r.valid = false; // rotation : un jeton ne sert qu'une fois
      return send(200, { access_token: issueAccess(r.sub, { azp: "ai-portal" }), expires_in: 300, refresh_token: issueRefresh(r.sub) });
    }
    if (f.grant_type === "client_credentials") {
      return send(200, { access_token: issueAccess(`service-account-${f.client_id}`, { azp: f.client_id }), expires_in: 300 });
    }
    if (f.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange") {
      const subject = accessTokens.get(f.subject_token);
      if (!subject) return send(400, { error: "invalid_token" });
      if (!client.audiences.includes(f.audience)) return send(400, { error: "invalid_request", error_description: "Requested audience not available" });
      return send(200, { access_token: issueAccess(subject.sub, { azp: f.client_id, aud: f.audience, scope: f.scope ?? "" }), expires_in: 300 });
    }
    send(400, { error: "unsupported_grant_type" });
  });
});

// ── Faux OPA ─────────────────────────────────────────────────────────────────
let opaDecision = { decision: "deny", reason: "scope_missing" };
const opaInputs: unknown[] = [];
const opa = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    opaInputs.push(JSON.parse(body).input);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: opaDecision }));
  });
});

// Modules sous test (générés depuis supabase/functions) : chargés après l'environnement.
type IdpMod = typeof import("../edge/_shared/idp-tokens.ts");
type AuthMod = typeof import("../edge/_shared/mcp-auth.ts");
let idp: IdpMod;
let auth: AuthMod;

interface Row { refresh_enc: string; iv: string; source_hash: string | null; idp_subject: string }
function memoryStore() {
  const rows = new Map<string, Row>();
  return {
    rows,
    async get(userId: string, provider: string) { return rows.get(`${userId}|${provider}`) ?? null; },
    async put(userId: string, provider: string, row: Row & { refreshed: boolean }) {
      const { refreshed: _r, ...rest } = row;
      rows.set(`${userId}|${provider}`, rest);
    },
    async remove(userId: string, provider: string) { rows.delete(`${userId}|${provider}`); },
  };
}

before(async () => {
  await new Promise<void>((r) => kc.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => opa.listen(0, "127.0.0.1", r));
  process.env.KEYCLOAK_ISSUER = `http://127.0.0.1:${(kc.address() as AddressInfo).port}/realms/platform`;
  process.env.KEYCLOAK_PORTAL_SECRET = "portal-secret";
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AGENT_IDP_CLIENTS = JSON.stringify({
    "agent-uuid-inv": { client_id: "agent-ops-investigator", client_secret: "inv-secret" },
    "ops-change": { client_id: "agent-ops-change", client_secret: "chg-secret" },
  });
  process.env.MCP_INTERNAL_HOSTS = "*.apps-int.*.interne.exemple";
  process.env.CATALOG_FILE = fileURLToPath(new URL("../../../MCP/policies/catalog/data.json", import.meta.url));
  idp = await import("../edge/_shared/idp-tokens.ts");
  auth = await import("../edge/_shared/mcp-auth.ts");
});

after(async () => {
  kc.closeAllConnections(); kc.close();
  opa.closeAllConnections(); opa.close();
});

beforeEach(() => {
  idp.forgetUserAccessToken();
  auth.resetMcpAuthCaches();
  calls.length = 0;
  delete process.env.OPA_URL;
});

describe("jeton Keycloak de l'utilisateur (D2)", () => {
  it("le dépôt vérifie le sub, fait tourner le jeton et ne garde que le nouveau", async () => {
    const store = memoryStore();
    const browserRt = issueRefresh("kc-alice");
    const out = await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", browserRt, "kc-alice");
    assert.deepEqual(out, { stored: true });
    const row = store.rows.get("u-alice|custom:keycloak")!;
    assert.equal(row.idp_subject, "kc-alice");
    assert.equal(refreshTokens.get(browserRt)!.valid, false, "le jeton vu par le navigateur ne sert plus");
    assert.ok(!row.refresh_enc.includes("rt-"), "stocké chiffré");
  });

  it("refuse le jeton d'une autre personne", async () => {
    const store = memoryStore();
    await assert.rejects(
      idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", issueRefresh("kc-mallory"), "kc-alice"),
      (e: Error & { code?: string }) => e.code === "subject_mismatch",
    );
    assert.equal(store.rows.size, 0);
  });

  it("un jeton déjà remis n'est ni rafraîchi ni réécrit", async () => {
    const store = memoryStore();
    const rt = issueRefresh("kc-alice");
    await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", rt, "kc-alice");
    const before = calls.length;
    const again = await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", rt, "kc-alice");
    assert.deepEqual(again, { stored: false, reason: "already_stored" });
    assert.equal(calls.length, before);
  });

  it("chaque rafraîchissement fait tourner le jeton conservé", async () => {
    const store = memoryStore();
    await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", issueRefresh("kc-alice"), "kc-alice");
    const first = store.rows.get("u-alice|custom:keycloak")!.refresh_enc;
    idp.forgetUserAccessToken();
    const access = await idp.getUserIdpAccessToken(idp.idpConfig()!, store, "u-alice");
    assert.equal(claimsOf(access).sub, "kc-alice");
    assert.notEqual(store.rows.get("u-alice|custom:keycloak")!.refresh_enc, first);
  });

  it("une autre réplique a déjà fait tourner le jeton : relecture, puis succès", async () => {
    const store = memoryStore();
    await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", issueRefresh("kc-alice"), "kc-alice");
    idp.forgetUserAccessToken();
    const stale = { ...store.rows.get("u-alice|custom:keycloak")! };
    // L'« autre réplique » rafraîchit et écrit le nouveau jeton.
    await idp.getUserIdpAccessToken(idp.idpConfig()!, store, "u-alice");
    idp.forgetUserAccessToken();
    let firstRead = true;
    const racing = { ...store, get: async (u: string, p: string) => (firstRead ? ((firstRead = false), stale) : store.get(u, p)) };
    const access = await idp.getUserIdpAccessToken(idp.idpConfig()!, racing, "u-alice");
    assert.equal(claimsOf(access).sub, "kc-alice");
  });

  it("session SSO expirée : erreur claire, et le jeton est oublié", async () => {
    const store = memoryStore();
    await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", issueRefresh("kc-alice"), "kc-alice");
    idp.forgetUserAccessToken();
    for (const r of refreshTokens.values()) r.valid = false;
    await assert.rejects(idp.getUserIdpAccessToken(idp.idpConfig()!, store, "u-alice"), (e: Error & { code?: string }) => e.code === "session_expired");
    assert.equal(store.rows.size, 0);
  });

  it("sans session conservée : erreur claire", async () => {
    await assert.rejects(idp.getUserIdpAccessToken(idp.idpConfig()!, memoryStore(), "u-nobody"), (e: Error & { code?: string }) => e.code === "no_session");
  });
});

describe("jeton d'appel MCP (D3)", () => {
  async function aliceStore() {
    const store = memoryStore();
    await idp.storeUserRefreshToken(idp.idpConfig()!, store, "u-alice", issueRefresh("kc-alice"), "kc-alice");
    return store;
  }
  const internal = "https://mcp-openshift.apps-int.prd.interne.exemple/mcp";

  it("au nom de la personne et de l'agent, pour une audience, avec le scope du tool", async () => {
    const store = await aliceStore();
    const headers = await auth.mcpRequestHeaders(null, {
      url: internal, auth: { mode: "token_exchange", audience: "mcp-openshift-prd", cluster: "prd" },
      agent: { id: "agent-uuid-inv", name: "ops-investigator" }, userId: "u-alice", tool: "pods_list",
      runId: "4bf92f35-77b3-4da6-a3ce-929d0e0e4736",
    }, store);
    const c = claimsOf(headers.Authorization.slice(7));
    assert.equal(c.sub, "kc-alice");
    assert.equal(c.azp, "agent-ops-investigator");
    assert.equal(c.aud, "mcp-openshift-prd");
    assert.equal(c.scope, "ocp:read");
    const ex = calls.find((x) => x.grant_type?.endsWith("token-exchange"))!;
    assert.equal(ex.requested_token_type, "urn:ietf:params:oauth:token-type:access_token");
    assert.match(headers.traceparent, /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    assert.equal(headers["X-Session-Id"], "4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
  });

  it("le jeton d'appel est réutilisé tant qu'il est valable", async () => {
    const store = await aliceStore();
    const req = { userId: "u-alice", agent: { id: "agent-uuid-inv" }, audience: "mcp-openshift-prd", scope: "ocp:read" };
    const t1 = await auth.mcpCallToken(null, req, store);
    const n = calls.length;
    const t2 = await auth.mcpCallToken(null, req, store);
    assert.equal(t1, t2);
    assert.equal(calls.length, n);
  });

  it("exécution planifiée : le compte de service de l'agent, réduit à l'audience", async () => {
    const t = await auth.mcpCallToken(null, { userId: null, agent: { id: "x", name: "agent-uuid-inv" }, audience: "mcp-argocd-prd" });
    const c = claimsOf(t);
    assert.equal(c.sub, "service-account-agent-ops-investigator");
    assert.equal(c.aud, "mcp-argocd-prd");
    assert.ok(calls.some((x) => x.grant_type === "client_credentials"));
  });

  it("une audience hors de la liste de l'agent est refusée par Keycloak", async () => {
    const store = await aliceStore();
    await assert.rejects(
      auth.mcpCallToken(null, { userId: "u-alice", agent: { id: "ops-change" }, audience: "mcp-openshift-prd" }, store),
      (e: Error & { code?: string }) => e.code === "exchange_refused" && /audience not available/.test(e.message),
    );
  });

  it("un agent sans client Keycloak ne reçoit rien", async () => {
    await assert.rejects(
      auth.mcpCallToken(null, { userId: null, agent: { id: "inconnu", name: "Support" }, audience: "mcp-openshift-prd" }),
      (e: Error & { code?: string }) => e.code === "agent_client_missing",
    );
  });

  it("aucun jeton ne part vers un hôte externe ou en clair", async () => {
    for (const url of ["https://mcp.evil.example/mcp", "http://mcp-openshift.apps-int.prd.interne.exemple/mcp"]) {
      await assert.rejects(
        auth.mcpRequestHeaders(null, { url, auth: { mode: "token_exchange", audience: "mcp-openshift-prd" }, agent: { id: "agent-uuid-inv" }, userId: null }),
        (e: Error & { code?: string }) => e.code === "host_not_allowed",
      );
    }
    assert.equal(calls.length, 0, "Keycloak n'a même pas été sollicité");
  });

  it("découverte : le premier client d'agent autorisé pour l'audience", async () => {
    const h = await auth.mcpDiscoveryHeaders("https://mcp-git.apps-int.ips.interne.exemple/mcp", "mcp-git-ips");
    assert.equal(claimsOf(h.Authorization.slice(7)).azp, "agent-ops-change");
  });
});

describe("pré-décision OPA (D5)", () => {
  const token = jwt({ sub: "kc-alice", azp: "agent-ops-investigator", scope: "openid ocp:read", realm_access: { roles: ["ai-ops-reader"] } });

  it("sans OPA_URL : pas de pré-décision", async () => {
    assert.equal(await auth.opaPreDecision({ tool: "pods_list", cluster: "prd", callToken: token }), null);
  });

  it("transmet les revendications du jeton et rend la décision", async () => {
    process.env.OPA_URL = `http://127.0.0.1:${(opa.address() as AddressInfo).port}`;
    opaDecision = { decision: "deny", reason: "role_missing" };
    const d = await auth.opaPreDecision({ tool: "deployment_restart", cluster: "prd", callToken: token });
    assert.deepEqual(d, { decision: "deny", reason: "role_missing" });
    assert.deepEqual((opaInputs.at(-1) as { token: unknown }).token, { sub: "kc-alice", azp: "agent-ops-investigator", scopes: ["openid", "ocp:read"], roles: ["ai-ops-reader"] });
  });

  it("OPA injoignable : null (le serveur MCP reste l'autorité)", async () => {
    process.env.OPA_URL = "http://127.0.0.1:1";
    assert.equal(await auth.opaPreDecision({ tool: "pods_list", cluster: "prd", callToken: token }), null);
  });
});

describe("garde SSRF et serveurs MCP internes (D8)", () => {
  it("les hôtes internes en https passent, le reste est toujours filtré", async () => {
    const { assertSafeUrl, hostMatches } = await import("../edge/_shared/ssrf.ts");
    assert.ok(hostMatches("mcp-openshift.apps-int.prd.interne.exemple", ["*.apps-int.*.interne.exemple"]));
    assert.ok(!hostMatches("mcp.apps-int.prd.interne.exemple.evil.com", ["*.apps-int.*.interne.exemple"]));
    assert.ok(!hostMatches("a.b.apps-int.prd.interne.exemple", ["*.apps-int.*.interne.exemple"]));
    assert.deepEqual(await assertSafeUrl("https://mcp-openshift.apps-int.prd.interne.exemple/mcp"), { ok: true });
    assert.equal((await assertSafeUrl("https://127.0.0.1/mcp")).ok, false);
    assert.equal((await assertSafeUrl("http://localhost/mcp")).ok, false);
  });
});
