// Connexions unifiées (G2) :
//   · la file du relais ne contient jamais un jeton en clair : secrets de
//     tâche chiffrés, remplis au moment où le relais réclame la tâche ;
//   · contexte utilisateur signé par FounderOS, vérifié par le code du serveur
//     MCP, jamais accepté comme approbation ;
//   · un serveur MCP joint PAR LE RELAIS, de bout en bout : vrai client MCP de
//     FounderOS → file → vrai code du relais (liste blanche) → vrai serveur MCP.

import "../test-env.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APPROVAL_ISSUER = "https://founderos.test";
process.env.APPROVAL_SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// Le relais lit sa liste blanche au chargement.
process.env.RELAY_ALLOWED_HOSTS = "127.0.0.1";

const { encryptSecret, decryptSecret } = await import("../edge/_shared/crypto.ts");
const cc = await import("../edge/_shared/custom-connectors.ts");
const relayMod = await import("../edge/_shared/mcp-relay.ts");
const ctx = await import("../edge/_shared/user-context.ts");
const { approvalJwks } = await import("../edge/_shared/mcp-approval.ts");
const { mcpCallTool } = await import("../edge/_shared/mcp-client.ts");

/* eslint-disable @typescript-eslint/no-explicit-any */
const dyn = (p: string) => import(new URL(p, import.meta.url).href);
const relayHttp = await dyn("../../../connector-relay/src/http.js") as { httpCall: (req: any, tls?: any) => Promise<any> };
const mcpApproval = await dyn("../../../MCP/src/lib/approval.ts") as { fileJwks: (f: string, ms?: number) => any; createApprovalVerifier: (o: any) => any };
const mcpAuth = await dyn("../../../MCP/src/lib/auth.ts") as { createAccessTokenVerifier: (o: any) => (t: string) => Promise<any> };
const { startServer } = await dyn("../../../MCP/src/lib/server.ts") as { startServer: (o: any) => Promise<any> };
const { combineModules } = await dyn("../../../MCP/src/servers/index.ts") as { combineModules: (k: string[]) => any };
const { BuiltinPolicyEngine } = await dyn("../../../MCP/src/lib/policy.ts") as { BuiltinPolicyEngine: new (c: any) => any };
const { loadCatalog } = await dyn("../../../MCP/src/lib/catalog.ts") as { loadCatalog: () => any };
const helpers = await dyn("../../../MCP/test/helpers.ts") as { fakeUpstream: (r: Record<string, () => { json?: unknown }>) => Promise<{ url: string; calls: any[]; close(): Promise<void> }> };

/** Faux client Supabase : chaque table répond par une fonction (opération, charge, filtres). */
function fakeAdmin(handlers: Record<string, (op: string, payload: any, filters: Record<string, unknown>) => any>, extra: Record<string, unknown> = {}) {
  const log: Array<{ table: string; op: string; payload: any; filters: Record<string, unknown> }> = [];
  const from = (table: string) => {
    let op = "select";
    let payload: any = null;
    const filters: Record<string, unknown> = {};
    const run = () => {
      log.push({ table, op, payload, filters: { ...filters } });
      return handlers[table]?.(op, payload, filters) ?? { data: null, error: null };
    };
    const q: any = {
      select: () => q, eq: (k: string, v: unknown) => { filters[k] = v; return q; }, in: () => q, gte: () => q, neq: () => q,
      order: () => q, limit: () => q, lt: () => q,
      insert: (p: any) => { op = "insert"; payload = p; return q; },
      update: (p: any) => { op = "update"; payload = p; return q; },
      upsert: (p: any) => { op = "upsert"; payload = p; return q; },
      delete: () => { op = "delete"; return q; },
      maybeSingle: async () => run(), single: async () => run(),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { admin: { from, ...extra } as any, log };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const RELAY = { id: "relay-1", workspace_id: "ws-1", project_id: "p-1", name: "relais-prd", status: "active", last_seen_at: new Date().toISOString() };

describe("file du relais : aucun jeton en clair", () => {
  it("les en-têtes d'identité deviennent des secrets de tâche ; le reste reste lisible", () => {
    const { headers, secrets } = relayMod.sealHeaders({
      Authorization: "Bearer secret-call-token", "X-Approval-Token": "secret-approval", "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", traceparent: "00-abc-def-01", "Mcp-Session-Id": "s1",
    });
    assert.equal(headers.Authorization, "{{secret:__h_authorization}}");
    assert.equal(headers["X-Approval-Token"], "{{secret:__h_x_approval_token}}");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.traceparent, "00-abc-def-01");
    assert.equal(headers["Mcp-Session-Id"], "s1");
    assert.deepEqual(secrets, { __h_authorization: "Bearer secret-call-token", __h_x_approval_token: "secret-approval" });
  });

  it("mise en file : marqueur seulement, secret chiffré ; le résultat revient déchiffré", async () => {
    const result = { status: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}", truncated: false, duration_ms: 12 };
    const sealedResult = await encryptSecret(JSON.stringify(result));
    let inserted: any;
    const { admin } = fakeAdmin({
      connector_relays: () => ({ data: RELAY }),
      connector_relay_jobs: (op, payload) => {
        if (op === "insert") { inserted = payload; return { data: { id: "job-1" }, error: null }; }
        if (op === "select") return { data: { status: "done", result_enc: sealedResult.ciphertext, result_iv: sealedResult.iv } };
        return { data: null, error: null };
      },
    });
    const req = {
      type: "http" as const, method: "POST", url: "https://mcp.interne/mcp", headers: { Authorization: "{{secret:__identity}}" },
      body: "{}", timeout_ms: 1000, max_bytes: 1000, apply_auth: false, placeholder_encoding: "raw" as const,
    };
    const out = await cc.relayJob(admin, { relayId: "relay-1", workspaceId: "ws-1", mcpServerId: "srv-1", jobSecrets: { __identity: "Bearer TOP-SECRET" } }, req);
    assert.equal(out.status, 200);
    assert.equal(out.relay_name, "relais-prd");
    assert.ok(!JSON.stringify(inserted).includes("TOP-SECRET"), "le jeton ne doit pas apparaître dans la file");
    assert.equal(inserted.mcp_server_id, "srv-1");
    assert.deepEqual(JSON.parse(await decryptSecret(inserted.job_secrets_enc, inserted.job_secrets_iv)), { __identity: "Bearer TOP-SECRET" });
  });

  it("à la réclamation : les marqueurs sont remplis, puis les secrets effacés de la file", async () => {
    const sealed = await encryptSecret(JSON.stringify({ __h_authorization: "Bearer TOP-SECRET" }));
    const { admin, log } = fakeAdmin({
      connector_relays: () => ({ data: null, error: null }),
      connector_relay_jobs: () => ({ data: null, error: null }),
    }, {
      rpc: async () => ({
        data: [{
          id: "job-2", connector_id: null, credential_id: null, job_secrets_enc: sealed.ciphertext, job_secrets_iv: sealed.iv,
          request: {
            type: "http", method: "POST", url: "https://mcp.interne/mcp", headers: { Authorization: "{{secret:__h_authorization}}" },
            body: "{}", timeout_ms: 1000, max_bytes: 1000, apply_auth: false, placeholder_encoding: "raw",
          },
        }],
      }),
    });
    const job = await cc.relayClaim(admin, RELAY as never, {}, 0);
    assert.equal(job?.request.headers?.Authorization, "Bearer TOP-SECRET");
    const cleared = log.find((l) => l.table === "connector_relay_jobs" && l.op === "update");
    assert.deepEqual(cleared?.payload, { job_secrets_enc: null, job_secrets_iv: null });
  });
});

describe("contexte utilisateur signé par FounderOS", () => {
  let jwksFile = "";
  before(async () => {
    jwksFile = path.join(mkdtempSync(path.join(tmpdir(), "ctx-")), "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(await approvalJwks()));
    ctx.resetUserContextCache();
  });

  it("le serveur MCP le lit comme un jeton d'appel : personne, agent, scope, rôles", async () => {
    const token = await ctx.signUserContext(null, {
      audience: "mcp-prd", userId: "u-alice", agent: { id: "agent-1", name: "ops-investigator" }, runId: "run-1", scope: "ocp:read",
    }, ["ai-ops-reader"]);
    const verify = mcpAuth.createAccessTokenVerifier({ issuer: "https://founderos.test", audience: "mcp-prd", jwks: mcpApproval.fileJwks(jwksFile) });
    const id = await verify(token);
    assert.equal(id.sub, "u-alice");
    assert.equal(id.azp, "ops-investigator");
    assert.deepEqual(id.scopes, ["ocp:read"]);
    assert.deepEqual(id.roles, ["ai-ops-reader"]);
  });

  it("jamais accepté comme jeton d'approbation, même clé, même émetteur", async () => {
    const token = await ctx.signUserContext(null, { audience: "mcp-prd", userId: "u-alice", agent: { id: "agent-1", name: "ops" } }, []);
    const approvals = mcpApproval.createApprovalVerifier({ issuer: "https://founderos.test", audience: "mcp-prd", jwksFile });
    await assert.rejects(approvals(token, { requester: "u-alice", tool: "deployment_restart", targetCluster: "prd", paramsHash: "a".repeat(64) }), /refusé/);
  });

  it("les rôles viennent des jetons de l'IdP et des groupes lus à la connexion SSO, jamais de user_metadata", async () => {
    const { admin } = fakeAdmin({
      user_idp_roles: () => ({ data: [{ roles: ["ai-ops-operator"] }] }),
      enterprise_sso_providers: () => ({ data: [{ auth_ref: "custom:entra", groups_claim: "roles" }, { auth_ref: "custom:kc", groups_claim: "realm_access.roles" }] }),
    }, {
      auth: {
        admin: {
          getUserById: async () => ({
            data: {
              user: {
                email: "alice@corp.test",
                user_metadata: { roles: ["admin-auto-proclame"] },
                identities: [
                  { provider: "custom:entra", identity_data: { roles: ["ai-ops-reader"] } },
                  { provider: "custom:kc", identity_data: { realm_access: { roles: ["ai-ops-prd-approver"] } } },
                  { provider: "email", identity_data: { roles: ["ignoré"] } },
                ],
              },
            },
          }),
        },
      },
    });
    const roles = await ctx.userContextRoles(admin, "u-alice");
    assert.deepEqual(roles.sort(), ["ai-ops-operator", "ai-ops-prd-approver", "ai-ops-reader"]);
  });
});

describe("serveur MCP joint par le relais, de bout en bout", async () => {
  let k8s: Awaited<ReturnType<typeof helpers.fakeUpstream>>;
  let server: any;
  let url = "";
  const queued: string[] = [];
  let jwksFile = "";

  before(async () => {
    jwksFile = path.join(mkdtempSync(path.join(tmpdir(), "relay-e2e-")), "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(await approvalJwks()));
    k8s = await helpers.fakeUpstream({
      "GET /api/v1/namespaces/app-a-prd/pods": () => ({
        json: { items: [{ metadata: { name: "api-1", creationTimestamp: "2026-10-11T00:00:00Z" }, spec: { nodeName: "n1", containers: [{ name: "api" }] }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] } }] },
      }),
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
      // Contexte signé : le serveur fait confiance au JWKS de FounderOS.
      verifyToken: mcpAuth.createAccessTokenVerifier({ issuer: "https://founderos.test", audience: "mcp-prd", jwks: mcpApproval.fileJwks(jwksFile) }),
      secrets: { resolve: async () => "sa-token" }, audit: () => {},
      mcpPort: 0, mgmtPort: 0, insecureHttp: true, host: "127.0.0.1",
    });
    url = `http://127.0.0.1:${(server.mcp.address() as AddressInfo).port}/mcp`;
  });
  after(async () => {
    await server.close();
    await k8s.close();
  });

  // Le relais simulé : ce qui est mis en file, puis le VRAI code du relais (liste blanche, appel HTTP).
  const relayFetch = () => relayMod.relayFetchFor(null, { relayId: "relay-1", workspaceId: "ws-1", mcpServerId: "srv-1" }, async (req, secrets) => {
    queued.push(JSON.stringify(req));
    return await relayHttp.httpCall(cc.materializeJobRequest(req, secrets));
  });

  it("un tool s'exécute par le relais, au nom de la personne, sans jeton dans la file", async () => {
    const token = await ctx.signUserContext(null, {
      audience: "mcp-prd", userId: "u-alice", agent: { id: "agent-1", name: "agent-ops-investigator" }, scope: "ocp:read",
    }, ["ai-ops-reader"]);
    const out = await mcpCallTool(url, { Authorization: `Bearer ${token}` }, "pods_list", { namespace: "app-a-prd" }, undefined, { fetch: relayFetch() });
    assert.ok(!out.startsWith("ERROR:"), out);
    assert.match(out, /api-1/);
    assert.ok(queued.length >= 2, "initialize puis tools/call");
    assert.ok(queued.every((q) => !q.includes(token)), "aucune tâche ne contient le jeton");
    assert.equal(k8s.calls.at(-1)!.headers.authorization, "Bearer sa-token");
  });

  it("un hôte hors de la liste blanche du relais est refusé par le relais lui-même", async () => {
    const fetchVia = relayMod.relayFetchFor(null, { relayId: "relay-1", workspaceId: "ws-1" }, async (req, secrets) =>
      await relayHttp.httpCall(cc.materializeJobRequest({ ...req, url: (req.url ?? "").replace("127.0.0.1", "localhost") }, secrets)));
    await assert.rejects(
      mcpCallTool(url, { Authorization: "Bearer x" }, "pods_list", { namespace: "app-a-prd" }, undefined, { fetch: fetchVia }),
      /n'est pas dans RELAY_ALLOWED_HOSTS/,
    );
  });
});

describe("outil interne en contexte signé, par le relais", () => {
  it("le jeton est émis pour l'appel, ne passe dans la file que chiffré, et l'audit nomme la personne", async () => {
    const result = { status: 200, headers: { "content-type": "application/json" }, body: "{\"health\":\"Healthy\"}", truncated: false, duration_ms: 9 };
    const sealedResult = await encryptSecret(JSON.stringify(result));
    let inserted: any = null;
    let auditRow: any = null;
    const events: any[] = [];
    const saved = (globalThis as any).__mcpObserver;
    (globalThis as any).__mcpObserver = { toolCall: (e: any) => events.push(e), approval: () => {} };
    const { admin } = fakeAdmin({
      custom_connectors: () => ({ data: {
        id: "cc-1", workspace_id: "ws-1", project_id: "p-1", service_dashboard_id: null, name: "Argo CD", slug: "argocd",
        base_url: "https://argocd.interne", transport: "relay", relay_id: "relay-1", auth_scheme: "signed_context",
        auth_config: { audience: "argocd" }, status: "active", version: 3, environment: "production", policy: {},
        operations: [{ name: "app_status", description: "État", method: "GET", path: "/api/v1/applications/{app}", risk: "read", params: [{ name: "app", type: "string", required: true }] }],
      } }),
      internal_agents: () => ({ data: { name: "ops-investigator", project_id: "p-1", service_dashboard_id: null } }),
      custom_connector_calls: (op, payload) => { if (op === "insert") auditRow = payload; return { data: null, error: null, count: 0 }; },
      connector_relays: () => ({ data: RELAY }),
      connector_relay_jobs: (op, payload) => {
        if (op === "insert") { inserted = payload; return { data: { id: "job-9" }, error: null }; }
        if (op === "select") return { data: { status: "done", result_enc: sealedResult.ciphertext, result_iv: sealedResult.iv } };
        return { data: null, error: null };
      },
      user_idp_roles: () => ({ data: [] }),
      enterprise_sso_providers: () => ({ data: [] }),
    }, { auth: { admin: { getUserById: async () => ({ data: { user: { email: "alice@corp.test", identities: [] } } }) } } });
    try {
      const out = await cc.executeCall(admin, {
        connectorId: "cc-1", operation: "app_status", params: { app: "payment" }, source: "collaborator",
        agentId: "agent-1", runId: "5f0c2a1e-8b7d-4c3a-9e21-0d6f4b8a7c12", actorUserId: "u-alice",
      });
      assert.equal(out.ok, true, out.text);
      const header = inserted.request.headers.Authorization;
      assert.equal(header, "Bearer {{secret:__identity}}");
      const secrets = JSON.parse(await decryptSecret(inserted.job_secrets_enc, inserted.job_secrets_iv));
      const claims = JSON.parse(Buffer.from(secrets.__identity.split(".")[1], "base64url").toString());
      assert.equal(claims.sub, "u-alice");
      assert.equal(claims.aud, "argocd");
      assert.equal(claims.azp, "ops-investigator");
      assert.equal(auditRow.identity, "u-alice via ops-investigator");
      assert.equal(events.at(-1).mcp_server, "connector:argocd");
      assert.equal(events.at(-1).cluster, "production");
      assert.equal(events.at(-1).user_sub, "u-alice");
      assert.equal(events.at(-1).status, "ok");
    } finally {
      (globalThis as any).__mcpObserver = saved;
    }
  });
});

describe("outil interne approuvé : jeton d'approbation pour l'outil (G3)", () => {
  const CONNECTOR = {
    id: "cc-2", workspace_id: "ws-1", project_id: "p-1", service_dashboard_id: null, name: "Argo CD", slug: "argocd",
    base_url: "https://argocd.interne", transport: "relay", relay_id: "relay-1", auth_scheme: "none",
    auth_config: {}, status: "active", version: 1, environment: "production",
    policy: { approval_audience: "argocd-approvals" },
    operations: [{ name: "app_sync", description: "Synchroniser", method: "POST", path: "/api/v1/applications/{app}/sync", risk: "write",
      params: [{ name: "app", type: "string", required: true }], body: { prune: false } }],
  };
  const approval = (over: Record<string, unknown> = {}) => ({
    id: "ap-9", action_kind: "custom_connector", status: "approved", requested_by: "u-alice", decided_by: "u-ops2", quorum: 2,
    payload: { connector_id: "cc-2", operation: "app_sync" }, ...over,
  });
  const setup = (row: Record<string, unknown>) => {
    const result = { status: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}", truncated: false, duration_ms: 5 };
    const state: { inserted: any } = { inserted: null };
    const sealed = encryptSecret(JSON.stringify(result));
    const { admin } = fakeAdmin({
      custom_connectors: () => ({ data: CONNECTOR }),
      internal_agents: () => ({ data: { name: "ops-change", project_id: "p-1", service_dashboard_id: null } }),
      custom_connector_calls: () => ({ data: null, error: null, count: 0 }),
      connector_relays: () => ({ data: RELAY }),
      internal_agent_approvals: () => ({ data: row }),
      internal_agent_approval_votes: () => ({ data: [{ idp_sub: "u-ops1" }, { idp_sub: "u-ops2" }] }),
      connector_relay_jobs: async (op: string, payload: any) => {
        if (op === "insert") { state.inserted = payload; return { data: { id: "job-10" }, error: null }; }
        if (op === "select") { const s = await sealed; return { data: { status: "done", result_enc: s.ciphertext, result_iv: s.iv } }; }
        return { data: null, error: null };
      },
    });
    return { admin, state };
  };
  const call = (admin: any) => cc.executeCall(admin, {
    connectorId: "cc-2", operation: "app_sync", params: { app: "payment" }, source: "approval",
    agentId: "agent-2", actorUserId: "u-alice", approvalId: "ap-9",
  });

  it("le jeton part chiffré dans la file, lié à la requête et aux deux approbateurs, et se vérifie avec le JWKS public", async () => {
    const { admin, state } = setup(approval());
    const out = await call(admin);
    assert.equal(out.ok, true, out.text);
    assert.equal(state.inserted.request.headers["X-Approval-Token"], "{{secret:__approval}}");
    assert.equal(JSON.stringify(state.inserted.request).includes("eyJ"), false, "aucun jeton en clair dans la file");
    const secrets = JSON.parse(await decryptSecret(state.inserted.job_secrets_enc, state.inserted.job_secrets_iv));
    const { createLocalJWKSet, jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(secrets.__approval, createLocalJWKSet(await approvalJwks() as never), {
      issuer: "https://founderos.test", audience: "argocd-approvals", typ: "JWT",
    });
    assert.equal(payload.sub, "u-alice");
    assert.equal(payload.jti, "ap-9");
    assert.deepEqual(payload.approvers, ["u-ops1", "u-ops2"]);
    assert.equal(payload.approver, "u-ops2");
    assert.equal(payload.method, "POST");
    assert.equal(payload.path, "/api/v1/applications/payment/sync");
    const { createHash } = await import("node:crypto");
    assert.equal(payload.body_sha256, createHash("sha256").update(state.inserted.request.body ?? "").digest("hex"));
    assert.equal((payload.exp as number) - (payload.iat as number), 300);
  });

  it("une demande qui n'est pas approuvée, ou pas pour cet appel : rien n'est envoyé", async () => {
    for (const row of [approval({ status: "pending" }), approval({ payload: { connector_id: "cc-2", operation: "app_delete" } }), null]) {
      const { admin, state } = setup(row as never);
      const out = await call(admin);
      assert.equal(out.ok, false);
      assert.equal(out.decision, "blocked", out.text);
      assert.equal(state.inserted, null);
    }
  });
});
