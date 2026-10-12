// Identité déléguée pour tout IdP (G1) : fournisseur réglé en base, Entra ID
// (On-Behalf-Of) et un IdP RFC 8693 dont le point de jeton n'est pas celui de
// Keycloak. Contre de faux IdP qui appliquent les règles des vrais :
//   · Entra : le jeton d'une personne adressé à l'application A ne peut être
//     échangé (OBO) que PAR A ; `sub` change d'une application à l'autre,
//     `oid` non ; les jetons vivent plus d'une heure ;
//   · RFC 8693 (type Okta) : audiences permises par client.

import "../test-env.ts";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { IdpDirectory } from "../edge/_shared/idp-directory.ts";
import type { IdpConfig } from "../edge/_shared/idp-tokens.ts";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const now = () => Math.floor(Date.now() / 1000);

type Form = Record<string, string>;
const calls: Array<{ idp: string; form: Form }> = [];

function readForm(req: IncomingMessage): Promise<Form> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}
const reply = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

// ── Faux Entra ID ────────────────────────────────────────────────────────────
// Personnes : un oid stable ; sub = « pairwise » par application.
const ENTRA_APPS: Record<string, { secret: string; uri: string }> = {
  "portal-app": { secret: "portal-secret", uri: "api://portal-app" },
  "agent-inv-app": { secret: "inv-secret", uri: "api://agent-inv-app" },
};
const entraRefresh = new Map<string, { oid: string; valid: boolean }>();
const pairwise = (oid: string, app: string) => `pw-${app}-${oid}`;
function entraRt(oid: string) {
  const rt = `ert-${randomBytes(6).toString("hex")}`;
  entraRefresh.set(rt, { oid, valid: true });
  return rt;
}

const entra = createServer(async (req, res) => {
  const form = await readForm(req);
  calls.push({ idp: "entra", form });
  const app = ENTRA_APPS[form.client_id];
  if (!app || app.secret !== form.client_secret) return reply(res, 401, { error: "invalid_client", error_description: "AADSTS7000215: secret invalide" });
  const resource = (form.scope ?? "").split(" ").find((s) => s.endsWith("/.default"))?.replace(/\/\.default$/, "");

  if (form.grant_type === "refresh_token") {
    const r = entraRefresh.get(form.refresh_token);
    if (!r?.valid) return reply(res, 400, { error: "invalid_grant", error_description: "AADSTS70008: jeton expiré" });
    r.valid = false;
    const aud = resource ?? "00000003-0000-0000-c000-000000000000"; // Graph par défaut
    return reply(res, 200, {
      access_token: jwt({ aud, oid: r.oid, sub: pairwise(r.oid, form.client_id), azp: form.client_id, scp: "access_as_user", iat: now(), exp: now() + 3900 }),
      id_token: jwt({ aud: form.client_id, oid: r.oid, sub: pairwise(r.oid, form.client_id) }),
      refresh_token: entraRt(r.oid),
      expires_in: 3900,
    });
  }
  if (form.grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    if (form.requested_token_use !== "on_behalf_of") return reply(res, 400, { error: "invalid_request", error_description: "requested_token_use" });
    const a = claimsOf(form.assertion);
    // L'assertion doit être adressée à l'application qui fait l'OBO.
    if (a.aud !== app.uri) return reply(res, 400, { error: "invalid_grant", error_description: `AADSTS50013: assertion destinée à ${a.aud}` });
    if (!resource) return reply(res, 400, { error: "invalid_scope", error_description: "AADSTS70011: scope" });
    return reply(res, 200, {
      access_token: jwt({ aud: resource, oid: a.oid, sub: pairwise(a.oid, resource), azp: form.client_id, scp: "ocp.read", iat: now(), exp: now() + 3900 }),
      expires_in: 3900,
    });
  }
  if (form.grant_type === "client_credentials") {
    if (!resource) return reply(res, 400, { error: "invalid_scope", error_description: "AADSTS1002012: scope requis" });
    return reply(res, 200, {
      access_token: jwt({ aud: resource, oid: `sp-${form.client_id}`, sub: `sp-${form.client_id}`, azp: form.client_id, roles: ["Agent.Read"], iat: now(), exp: now() + 3900 }),
      expires_in: 3900,
    });
  }
  return reply(res, 400, { error: "unsupported_grant_type" });
});

// ── Faux IdP RFC 8693 (point de jeton type Okta) ─────────────────────────────
const OKTA_CLIENTS: Record<string, { secret: string; audiences: string[] }> = {
  "agent-okta": { secret: "okta-secret", audiences: ["mcp-npr"] },
};
const okta = createServer(async (req, res) => {
  if (req.url !== "/oauth2/default/v1/token") return reply(res, 404, { error: "not_found" });
  const form = await readForm(req);
  calls.push({ idp: "okta", form });
  const c = OKTA_CLIENTS[form.client_id];
  if (!c || c.secret !== form.client_secret) return reply(res, 401, { error: "invalid_client" });
  if (form.grant_type === "client_credentials") {
    return reply(res, 200, { access_token: jwt({ sub: `svc-${form.client_id}`, cid: form.client_id, iat: now(), exp: now() + 300 }), expires_in: 300 });
  }
  if (form.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange") {
    if (!c.audiences.includes(form.audience)) return reply(res, 400, { error: "invalid_target", error_description: `audience ${form.audience} non permise` });
    const s = claimsOf(form.subject_token);
    return reply(res, 200, { access_token: jwt({ sub: s.sub, azp: form.client_id, aud: form.audience, iat: now(), exp: now() + 300 }), expires_in: 300 });
  }
  return reply(res, 400, { error: "unsupported_grant_type" });
});

// ── Annuaire en mémoire (ce que la migration 0276 stocke) ────────────────────
let entraCfg: IdpConfig;
let oktaCfg: IdpConfig;
const identities = new Map<string, { client_id: string; client_secret: string; user_scope?: string | null }>();
const directory = (providers: () => IdpConfig[]): IdpDirectory => ({
  providers: async () => providers(),
  agentIdentity: async (agentId, providerId) => identities.get(`${agentId}|${providerId}`) ?? null,
  agentIdentities: async (providerId) => [...identities.entries()].filter(([k]) => k.endsWith(`|${providerId}`)).map(([, v]) => v),
});

function memoryStore() {
  const rows = new Map<string, { refresh_enc: string; iv: string; source_hash: string | null; idp_subject: string }>();
  return {
    rows,
    async get(u: string, p: string) { return rows.get(`${u}|${p}`) ?? null; },
    async put(u: string, p: string, row: { refresh_enc: string; iv: string; source_hash: string | null; idp_subject: string; refreshed: boolean }) {
      const { refreshed: _r, ...rest } = row;
      rows.set(`${u}|${p}`, rest);
    },
    async remove(u: string, p: string) { rows.delete(`${u}|${p}`); },
  };
}

let idp: typeof import("../edge/_shared/idp-tokens.ts");
let dirmod: typeof import("../edge/_shared/idp-directory.ts");
let auth: typeof import("../edge/_shared/mcp-auth.ts");
let approval: typeof import("../edge/_shared/mcp-approval.ts");
let idpToken: typeof import("../functions/idp-token.ts");

before(async () => {
  await new Promise<void>((r) => entra.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => okta.listen(0, "127.0.0.1", r));
  delete process.env.KEYCLOAK_ISSUER;
  delete process.env.KEYCLOAK_PORTAL_SECRET;
  delete process.env.AGENT_IDP_CLIENTS;
  const e = `http://127.0.0.1:${(entra.address() as AddressInfo).port}/tenant`;
  entraCfg = {
    provider: "custom:entra", providerId: "prov-entra", issuer: `${e}/v2.0`, tokenEndpoint: `${e}/oauth2/v2.0/token`,
    delegation: "entra_obo", subjectClaim: "oid", portalClientId: "portal-app", portalClientSecret: "portal-secret",
  };
  const o = `http://127.0.0.1:${(okta.address() as AddressInfo).port}`;
  oktaCfg = {
    provider: "custom:okta", providerId: "prov-okta", issuer: `${o}/oauth2/default`, tokenEndpoint: `${o}/oauth2/default/v1/token`,
    delegation: "token_exchange", subjectClaim: "sub", portalClientId: "portal-okta", portalClientSecret: "x",
  };
  identities.set("agent-1|prov-entra", { client_id: "agent-inv-app", client_secret: "inv-secret", user_scope: "api://agent-inv-app/.default" });
  identities.set("agent-1|prov-okta", { client_id: "agent-okta", client_secret: "okta-secret" });
  idp = await import("../edge/_shared/idp-tokens.ts");
  dirmod = await import("../edge/_shared/idp-directory.ts");
  auth = await import("../edge/_shared/mcp-auth.ts");
  approval = await import("../edge/_shared/mcp-approval.ts");
  idpToken = await import("../functions/idp-token.ts");
});

after(() => {
  entra.closeAllConnections(); entra.close();
  okta.closeAllConnections(); okta.close();
});

beforeEach(() => {
  calls.length = 0;
  idp.forgetUserAccessToken();
  auth.resetMcpAuthCaches();
  delete process.env.KEYCLOAK_ISSUER;
  delete process.env.KEYCLOAK_PORTAL_SECRET;
});

describe("quel fournisseur délègue", () => {
  it("celui réglé en base, désigné ou unique ; plusieurs sans désignation : erreur claire", async () => {
    assert.equal((await dirmod.resolveIdpConfig(directory(() => [entraCfg]), null))?.provider, "custom:entra");
    assert.equal((await dirmod.resolveIdpConfig(directory(() => [entraCfg, oktaCfg]), "custom:okta"))?.provider, "custom:okta");
    await assert.rejects(dirmod.resolveIdpConfig(directory(() => [entraCfg, oktaCfg]), null), /Plusieurs fournisseurs délèguent/);
    assert.equal(await dirmod.resolveIdpConfig(directory(() => [entraCfg]), "custom:inconnu"), null);
  });

  it("sans réglage en base, les variables KEYCLOAK_* servent de repli ; la base l'emporte", async () => {
    process.env.KEYCLOAK_ISSUER = "https://kc.test/realms/platform";
    process.env.KEYCLOAK_PORTAL_SECRET = "s";
    const env = await dirmod.resolveIdpConfig(directory(() => []), null);
    assert.equal(env?.provider, "custom:keycloak");
    assert.equal(env?.tokenEndpoint, "https://kc.test/realms/platform/protocol/openid-connect/token");
    assert.equal((await dirmod.resolveIdpConfig(directory(() => [entraCfg]), null))?.provider, "custom:entra");
  });
});

describe("Entra ID : On-Behalf-Of", () => {
  it("le dépôt vérifie la personne par son oid (le sub change d'une application à l'autre)", async () => {
    const store = memoryStore();
    assert.deepEqual(await idp.storeUserRefreshToken(entraCfg, store, "u-alice", entraRt("oid-alice"), "oid-alice"), { stored: true });
    assert.equal(store.rows.get("u-alice|custom:entra")!.idp_subject, "oid-alice");
    await assert.rejects(idp.storeUserRefreshToken(entraCfg, store, "u-mallory", entraRt("oid-alice"), "oid-mallory"), /n'appartient pas/);
  });

  it("au nom d'une personne : jeton adressé à l'application de l'agent, puis OBO vers le serveur", async () => {
    const store = memoryStore();
    await idp.storeUserRefreshToken(entraCfg, store, "u-alice", entraRt("oid-alice"), "oid-alice");
    calls.length = 0;
    idp.forgetUserAccessToken();
    const req = { userId: "u-alice", agent: { id: "agent-1" }, audience: "api://mcp-prd" };
    const t1 = await auth.mcpCallToken(null, req, store, directory(() => [entraCfg]));
    const c = claimsOf(t1);
    assert.equal(c.aud, "api://mcp-prd");
    assert.equal(c.oid, "oid-alice");
    assert.equal(c.azp, "agent-inv-app");
    assert.deepEqual(calls.map((x) => x.form.grant_type), ["refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"]);
    assert.equal(calls[0].form.scope, "api://agent-inv-app/.default");
    assert.equal(calls[1].form.scope, "api://mcp-prd/.default");
    // Mis en cache : pas de nouvel aller-retour.
    assert.equal(await auth.mcpCallToken(null, req, store, directory(() => [entraCfg])), t1);
    assert.equal(calls.length, 2);
  });

  it("une assertion adressée à une autre application est refusée par Entra, avec sa raison", async () => {
    const store = memoryStore();
    await idp.storeUserRefreshToken(entraCfg, store, "u-alice", entraRt("oid-alice"), "oid-alice");
    identities.set("agent-2|prov-entra", { client_id: "agent-inv-app", client_secret: "inv-secret", user_scope: "api://portal-app/.default" });
    await assert.rejects(
      auth.mcpCallToken(null, { userId: "u-alice", agent: { id: "agent-2" }, audience: "api://mcp-prd" }, store, directory(() => [entraCfg])),
      /Entra ID refuse l'On-Behalf-Of.*AADSTS50013/,
    );
    identities.delete("agent-2|prov-entra");
  });

  it("exécution planifiée : l'application de l'agent seule, avec ses rôles d'application", async () => {
    const t = await auth.mcpCallToken(null, { userId: null, agent: { id: "agent-1" }, audience: "api://mcp-prd" }, memoryStore(), directory(() => [entraCfg]));
    const c = claimsOf(t);
    assert.equal(c.aud, "api://mcp-prd");
    assert.deepEqual(c.roles, ["Agent.Read"]);
    assert.equal(calls[0].form.grant_type, "client_credentials");
    assert.equal(calls[0].form.scope, "api://mcp-prd/.default");
  });

  it("quatre yeux : la demande et l'approbateur sont identifiés par le même oid", async () => {
    const store = memoryStore();
    await idp.storeUserRefreshToken(entraCfg, store, "u-alice", entraRt("oid-alice"), "oid-alice");
    const callToken = await auth.mcpCallToken(null, { userId: "u-alice", agent: { id: "agent-1" }, audience: "api://mcp-prd" }, store, directory(() => [entraCfg]));
    const payload = approval.buildMcpApprovalPayload({
      server: { id: "srv", name: "cluster-prd", auth: { mode: "token_exchange", audience: "api://mcp-prd", provider: "custom:entra" } },
      args: {}, required: { tool: "deployment_restart", target_cluster: "prd", params_hash: "a".repeat(64), params: {}, message: "" }, callToken,
    });
    assert.equal(payload.requester_sub, "oid-alice");
    assert.equal(payload.provider, "custom:entra");
    // La même personne, vue par le portail (autre sub, même oid), est reconnue.
    const identity = await approval.liveIdpIdentity(null, "u-alice", store, "custom:entra", directory(() => [entraCfg]));
    assert.equal(identity.sub, "oid-alice");
  });

  it("le dépôt lit l'oid attendu dans l'identité enregistrée par Supabase Auth", () => {
    const cfg = { subjectClaim: "oid" as const };
    assert.equal(idpToken.expectedSubjectOf(cfg, { id: "x", identity_data: { oid: "oid-alice", sub: "pw" } }), "oid-alice");
    assert.equal(idpToken.expectedSubjectOf(cfg, { id: "x", identity_data: { custom_claims: { oid: "oid-bob" } } }), "oid-bob");
    // Pas d'oid : jamais de repli sur l'id de l'identité, qui n'est pas un oid.
    assert.equal(idpToken.expectedSubjectOf(cfg, { id: "x", identity_data: { sub: "pw" } }), "");
    assert.equal(idpToken.expectedSubjectOf({ subjectClaim: "sub" }, { id: "ident-1", identity_data: {} }), "ident-1");
  });
});

describe("IdP RFC 8693 hors Keycloak", () => {
  it("le point de jeton réglé est utilisé, et les audiences restent celles que l'IdP permet", async () => {
    const t = await auth.mcpCallToken(null, { userId: null, agent: { id: "agent-1" }, audience: "mcp-npr" }, memoryStore(), directory(() => [oktaCfg]));
    assert.equal(claimsOf(t).aud, "mcp-npr");
    assert.ok(calls.every((c) => c.idp === "okta"));
    await assert.rejects(
      auth.mcpCallToken(null, { userId: null, agent: { id: "agent-1" }, audience: "mcp-prd" }, memoryStore(), directory(() => [oktaCfg])),
      /refuse l'échange vers mcp-prd.*non permise/,
    );
  });

  it("un agent sans identité auprès de ce fournisseur : erreur qui dit où la régler", async () => {
    await assert.rejects(
      auth.mcpCallToken(null, { userId: null, agent: { id: "agent-9", name: "Support" }, audience: "mcp-npr" }, memoryStore(), directory(() => [oktaCfg])),
      /Aucune identité auprès de l'IdP pour l'agent Support.*Identités des agents/,
    );
  });
});

describe("pré-décision OPA avec un jeton Entra", () => {
  it("scp, appid et roles sont lus comme scope, azp et rôles", async () => {
    let seen: Record<string, unknown> | null = null;
    const opa = createServer(async (req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        seen = JSON.parse(raw).input;
        reply(res, 200, { result: { decision: "allow", reason: "allow" } });
      });
    });
    await new Promise<void>((r) => opa.listen(0, "127.0.0.1", r));
    process.env.OPA_URL = `http://127.0.0.1:${(opa.address() as AddressInfo).port}`;
    try {
      const token = jwt({ oid: "oid-alice", sub: "pw", appid: "agent-inv-app", scp: "ocp.read ocp.restart", roles: ["ai-ops-operator"] });
      const out = await auth.opaPreDecision({ tool: "pods_list", cluster: "prd", callToken: token });
      assert.equal(out?.decision, "allow");
      const t = (seen as unknown as { token: { azp: string; scopes: string[]; roles: string[] } }).token;
      assert.equal(t.azp, "agent-inv-app");
      assert.deepEqual(t.scopes, ["ocp.read", "ocp.restart"]);
      assert.deepEqual(t.roles, ["ai-ops-operator"]);
    } finally {
      delete process.env.OPA_URL;
      opa.closeAllConnections(); opa.close();
    }
  });
});
