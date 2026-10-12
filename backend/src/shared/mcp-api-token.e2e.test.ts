// Jeton d'API d'un serveur MCP (0278), de bout en bout, contre le VRAI serveur
// MCP (code de MCP/, serveur du cluster PRD, AUTH_MODE=token) :
//
//   1. le jeton est généré « à l'installation » du serveur, qui n'en garde que
//      l'empreinte ; FounderOS l'enregistre chiffré, n'en montre que l'indice ;
//   2. l'agent appelle avec le jeton, la personne et l'agent ; le serveur
//      accorde les droits du jeton et journalise la personne ;
//   3. un jeton faux, révoqué ou expiré est refusé ;
//   4. en PRD, le serveur demande une approbation ; FounderOS forme la demande,
//      les quatre yeux s'appliquent, puis le rejeu (executeMcpApproval) passe.
//
// Rien n'est simulé côté serveur MCP ; côté FounderOS, seule la base l'est.

import "../test-env.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mcpCallTool } from "../edge/_shared/mcp-client.ts";
import { callIdentity } from "../edge/_shared/mcp-observe.ts";
import {
  API_TOKEN_RE, apiTokenHeaders, apiTokenSubject, assertedAgentName, loadMcpApiTokens, saveMcpApiToken, tokenHint,
} from "../edge/_shared/mcp-api-token.ts";
import {
  approvalJwks, buildMcpApprovalPayload, executeMcpApproval, gateMcpDecision, parseApprovalRequired, PRD_APPROVER_ROLE,
  signApprovalToken,
} from "../edge/_shared/mcp-approval.ts";

const mcp = (p: string) => import(new URL(`../../../MCP/${p}`, import.meta.url).href);
/* eslint-disable @typescript-eslint/no-explicit-any */
const { startServer } = await mcp("src/lib/server.ts") as { startServer: (o: any) => Promise<any> };
const { combineModules } = await mcp("src/servers/index.ts") as { combineModules: (k: string[]) => any };
const { BuiltinPolicyEngine } = await mcp("src/lib/policy.ts") as { BuiltinPolicyEngine: new (c: any) => any };
const { loadCatalog } = await mcp("src/lib/catalog.ts") as { loadCatalog: () => any };
const { createApprovalVerifier } = await mcp("src/lib/approval.ts") as { createApprovalVerifier: (o: any) => any };
const { generateToken, createApiTokenVerifier } = await mcp("src/lib/api-tokens.ts") as {
  generateToken: (o: { label: string; roles: string[]; scopes: string[]; expiresInDays?: number | null; now?: Date }) => { token: string; entry: any };
  createApiTokenVerifier: (o: { entries: any[] }) => any;
};
const helpers = await mcp("test/helpers.ts") as {
  fakeUpstream: (r: Record<string, (req: { body: string }) => { json?: unknown }>) => Promise<{ url: string; calls: Array<{ method: string; url: string; body: string; headers: Record<string, unknown> }>; close(): Promise<void> }>;
};

/** La base de FounderOS, réduite aux tables que touche le jeton d'API. */
function memoryAdmin(tables: Record<string, Array<Record<string, any>>>) {
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    let op: "select" | "upsert" | "update" = "select";
    let payload: Record<string, any> = {};
    const eq: Record<string, unknown> = {};
    let inFilter: [string, unknown[]] | null = null;
    const match = (r: Record<string, any>) =>
      Object.entries(eq).every(([k, v]) => r[k] === v) && (!inFilter || inFilter[1].includes(r[inFilter[0]]));
    const run = (single: boolean) => {
      if (op === "upsert") {
        const i = rows.findIndex((r) => r.server_id === payload.server_id);
        if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload });
        return { data: null, error: null };
      }
      if (op === "update") {
        for (const r of rows.filter(match)) Object.assign(r, payload);
        return { data: null, error: null };
      }
      const found = rows.filter(match);
      return { data: single ? found[0] ?? null : found, error: null };
    };
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => { eq[k] = v; return q; },
      in: (k: string, v: unknown[]) => { inFilter = [k, v]; return q; },
      upsert: (p: Record<string, any>) => { op = "upsert"; payload = p; return q; },
      update: (p: Record<string, any>) => { op = "update"; payload = p; return q; },
      maybeSingle: async () => run(true),
      then: (res: any, rej: any) => Promise.resolve(run(false)).then(res, rej),
    };
    return q;
  };
  return { from } as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const DEPLOYMENT = "/apis/apps/v1/namespaces/app-a-prd/deployments/api";
const SERVER_ID = "5e7f0000-0000-4000-8000-000000000001";
const ALICE = "0a11ce00-0000-4000-8000-000000000001";
const BOB = "0b0b0000-0000-4000-8000-000000000002";

describe("jeton d'API d'un serveur MCP, de bout en bout", async () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APPROVAL_ISSUER = "https://founderos.test";
  process.env.APPROVAL_SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  // « npm run token -- generate » à l'installation : le jeton est montré une fois,
  // le serveur ne garde que l'entrée (empreinte, rôles, scopes).
  const operator = generateToken({ label: "founderos", roles: ["ai-ops-operator"], scopes: ["ocp:restart"] });
  const revoked = generateToken({ label: "ancien", roles: ["ai-ops-operator"], scopes: ["ocp:restart"] });
  revoked.entry.revoked_at = new Date().toISOString();
  const expired = generateToken({ label: "expire", roles: ["ai-ops-operator"], scopes: ["ocp:restart"], expiresInDays: 1, now: new Date(Date.now() - 2 * 86_400_000) });

  const audit: Array<Record<string, unknown>> = [];
  let k8s: Awaited<ReturnType<typeof helpers.fakeUpstream>>;
  let server: { mcp: { address(): AddressInfo }; close(): Promise<void> };
  let url = "";
  const db: Record<string, Array<Record<string, unknown>>> = {};
  const admin = memoryAdmin(db);

  before(async () => {
    k8s = await helpers.fakeUpstream({ [`PATCH ${DEPLOYMENT}`]: () => ({ json: { metadata: { name: "api" } } }) });
    const jwksFile = path.join(mkdtempSync(path.join(tmpdir(), "api-token-e2e-")), "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(await approvalJwks()));
    const catalog = loadCatalog();
    const mod = combineModules(["openshift", "argocd"]);
    server = await startServer({
      module: mod,
      config: mod.configSchema.parse({
        openshift: { api: { url: k8s.url }, namespaces: ["app-a-prd"], readCredential: { type: "env", name: "X" }, writeCredential: { type: "env", name: "X" } },
        argocd: { url: k8s.url, token: { type: "env", name: "X" }, projects: ["team-a"] },
      }),
      cluster: "prd",
      catalog,
      policy: new BuiltinPolicyEngine(catalog),
      verifyToken: createApiTokenVerifier({ entries: [operator.entry, revoked.entry, expired.entry] }),
      verifyApproval: createApprovalVerifier({ issuer: "https://founderos.test", audience: "mcp-prd", jwksFile }),
      secrets: { resolve: async () => "sa-token-ocp" },
      audit: (e: Record<string, unknown>) => audit.push(e),
      mcpPort: 0,
      mgmtPort: 0,
      insecureHttp: true,
      host: "127.0.0.1",
    });
    url = `http://127.0.0.1:${server.mcp.address().port}/mcp`;
    db.mcp_servers = [{
      id: SERVER_ID, name: "cluster-prd", url, enabled: true, auth_mode: "api_token",
      auth_config: { audience: "mcp-prd", cluster: "prd" }, relay_id: null, workspace_id: "ws-1", token_hint: null,
    }];
    db.internal_agents = [{ id: "agent-change", name: "Opérateur PRD 🚀" }];
  });
  after(async () => {
    await server.close();
    await k8s.close();
  });

  const args = { namespace: "app-a-prd", name: "api" };
  const patches = () => k8s.calls.filter((c) => c.method === "PATCH").length;

  it("1. FounderOS garde le jeton chiffré et n'en montre que l'indice", async () => {
    assert.match(operator.token, API_TOKEN_RE);
    const { hint } = await saveMcpApiToken(admin, SERVER_ID, operator.token, ALICE);
    assert.equal(hint, `mcpt_${operator.entry.id}…${operator.token.slice(-4)}`);
    assert.equal(hint, tokenHint(operator.token));
    assert.equal(db.mcp_servers[0].token_hint, hint);
    const row = db.mcp_server_secrets[0];
    assert.ok(!JSON.stringify(row).includes(operator.token), "le jeton ne doit jamais être stocké en clair");
    assert.equal((await loadMcpApiTokens(admin, [SERVER_ID])).get(SERVER_ID), operator.token);
    await assert.rejects(saveMcpApiToken(admin, SERVER_ID, "court", ALICE), /Jeton invalide/);
    await assert.rejects(saveMcpApiToken(admin, SERVER_ID, "mcpt_avec un espace_dedans-xxxxxxxx", ALICE), /Jeton invalide/);
  });

  it("2. les en-têtes : le jeton, la personne, l'agent dans le jeu de caractères du serveur", () => {
    const h = apiTokenHeaders({ token: operator.token, userId: ALICE, agentName: "Opérateur PRD 🚀", runId: null });
    assert.equal(h.Authorization, `Bearer ${operator.token}`);
    assert.equal(h["X-FounderOS-User"], ALICE);
    assert.equal(h["X-FounderOS-Agent"], "Operateur PRD -");
    assert.equal(assertedAgentName("🚀🚀"), null);
    assert.equal("X-FounderOS-User" in apiTokenHeaders({ token: operator.token, userId: null }), false);
    // Exécution planifiée : le demandeur est le jeton lui-même, comme côté serveur.
    assert.equal(apiTokenSubject(operator.token, null), `token:${operator.entry.id}`);
    assert.equal(apiTokenSubject(operator.token, ALICE), ALICE);
    // L'audit de FounderOS porte le même token_id que celui du serveur.
    assert.deepEqual(callIdentity(h), { user_sub: ALICE, agent_client: `token:${operator.entry.id}` });
  });

  it("3. un jeton faux, révoqué ou expiré est refusé, rien n'est exécuté", async () => {
    const forged = operator.token.slice(0, -4) + (operator.token.endsWith("AAAA") ? "BBBB" : "AAAA");
    for (const token of [forged, revoked.token, expired.token, "mcpt_inconnu0_" + "x".repeat(43)]) {
      const out = await mcpCallTool(url, apiTokenHeaders({ token, userId: ALICE }), "deployment_restart", args);
      assert.match(out, /^ERROR: MCP initialize failed/, `jeton accepté à tort : ${token.slice(0, 14)} → ${out}`);
    }
    assert.equal(patches(), 0);
  });

  let payload: ReturnType<typeof buildMcpApprovalPayload>;

  it("4. en PRD, le serveur demande une approbation ; la demande est liée à la personne affirmée", async () => {
    audit.length = 0;
    const out = await mcpCallTool(url, apiTokenHeaders({ token: operator.token, userId: ALICE, agentName: "Opérateur PRD 🚀" }), "deployment_restart", args);
    const required = parseApprovalRequired(out);
    assert.ok(required, out);
    assert.equal(patches(), 0);
    const entry = audit.find((e) => e.tool === "deployment_restart")!;
    assert.equal(entry.user, ALICE);
    assert.equal(entry.agent, "Operateur PRD -");
    assert.equal(entry.token_id, operator.entry.id);
    payload = buildMcpApprovalPayload({
      server: { id: SERVER_ID, name: "cluster-prd", apiTokenAudience: "mcp-prd" }, args, required,
      requesterSub: apiTokenSubject(operator.token, ALICE),
    });
    assert.equal(payload.requester_sub, ALICE);
    assert.equal(payload.identity_mode, "api_token");
    assert.equal(payload.audience, "mcp-prd");
    // Sans audience, pas de jeton d'approbation possible : l'erreur le dit.
    assert.throws(() => buildMcpApprovalPayload({
      server: { id: SERVER_ID, name: "cluster-prd", apiTokenAudience: null }, args, required, requesterSub: ALICE,
    }), /audience/);
  });

  const row = () => ({
    id: "3a7e0000-0000-4000-8000-000000000009", agent_id: "agent-change", run_id: null, workspace_id: "ws-1",
    tool_name: "mcp_cluster_prd_deployment_restart", action_kind: "mcp_tool", status: "pending",
    requested_by: ALICE, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    payload: payload as unknown as Record<string, unknown>,
  });
  const sign = (approverSub: string) => signApprovalToken({
    audience: payload.audience, requesterSub: payload.requester_sub, approverSub,
    approvalId: row().id, tool: payload.tool, targetCluster: payload.target_cluster, paramsHash: payload.params_hash,
  });

  it("5. quatre yeux : Alice ne s'approuve pas elle-même, Bob (approbateur PRD) si", async () => {
    const member = async () => true;
    const self = await gateMcpDecision(row(), { userId: ALICE, decision: "approve", identity: async () => ({ sub: ALICE, roles: [PRD_APPROVER_ROLE] }), isWorkspaceMember: member });
    assert.equal(self.ok, false);
    const bob = await gateMcpDecision(row(), { userId: BOB, decision: "approve", identity: async () => ({ sub: BOB, roles: [PRD_APPROVER_ROLE] }), isWorkspaceMember: member });
    assert.equal(bob.ok, true);
    // Même signée, une auto-approbation est refusée par le serveur.
    const { token } = await sign(ALICE);
    const out = await executeMcpApproval(admin, row(), token);
    assert.equal(out.ok, false);
    assert.equal(patches(), 0);
  });

  it("6. le rejeu par FounderOS, avec le jeton enregistré et l'approbation de Bob, redémarre le déploiement", async () => {
    audit.length = 0;
    const { token } = await sign(BOB);
    const out = await executeMcpApproval(admin, row(), token);
    assert.equal(out.ok, true, out.detail);
    assert.equal(patches(), 1);
    // L'outil ne voit que l'identifiant Vault, jamais le jeton d'API.
    const patch = k8s.calls.find((c) => c.method === "PATCH")!;
    assert.equal(patch.headers.authorization, "Bearer sa-token-ocp");
    const entry = audit.find((e) => e.tool === "deployment_restart" && e.status === "ok")!;
    assert.equal(entry.user, ALICE);
    assert.equal(entry.approver, BOB);
    assert.equal(entry.token_id, operator.entry.id);
  });

  it("7. le rejeu s'arrête si la configuration a changé ou si le jeton a disparu", async () => {
    const { token } = await sign(BOB);
    db.mcp_servers[0].auth_config = { audience: "mcp-autre", cluster: "prd" };
    assert.match((await executeMcpApproval(admin, row(), token)).detail, /configuration du serveur MCP a changé/);
    db.mcp_servers[0].auth_config = { audience: "mcp-prd", cluster: "prd" };
    const saved = db.mcp_server_secrets.splice(0);
    assert.match((await executeMcpApproval(admin, row(), token)).detail, /n'est plus enregistré/);
    db.mcp_server_secrets.push(...saved);
    assert.match((await executeMcpApproval(admin, { ...row(), requested_by: BOB }, token)).detail, /identité du demandeur a changé/);
    assert.equal(patches(), 1);
  });
});
