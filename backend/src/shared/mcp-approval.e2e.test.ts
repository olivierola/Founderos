// Approbation PRD de bout en bout (D6), contre le VRAI serveur MCP (code de
// MCP/, serveur du cluster PRD) et le vrai client MCP de FounderOS :
//
//   1. l'agent demande deployment_restart en PRD → le serveur répond
//      approval_required, rien n'est exécuté ;
//   2. FounderOS lit la réponse, forme la demande, applique les quatre yeux ;
//   3. un approbateur valide → FounderOS signe le jeton et rejoue l'appel ;
//   4. le serveur vérifie le jeton (clés publiques lues dans un fichier, comme
//      la ConfigMap d'un cluster), OPA autorise, le déploiement redémarre.
//
// Seul Keycloak est simulé : le jeton d'appel est signé par la clé de test.

import "../test-env.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { traceparentFor } from "../edge/_shared/mcp-auth.ts";
import { mcpCallTool } from "../edge/_shared/mcp-client.ts";
import { traceIdFor } from "../edge/_shared/mcp-observe.ts";
import {
  approvalJwks, buildMcpApprovalPayload, gateMcpDecision, parseApprovalRequired, PRD_APPROVER_ROLE, signApprovalToken,
} from "../edge/_shared/mcp-approval.ts";

// Le code du serveur MCP, hors du rootDir du backend : chargé dynamiquement.
const mcp = (p: string) => import(new URL(`../../../MCP/${p}`, import.meta.url).href);
/* eslint-disable @typescript-eslint/no-explicit-any */
const { startServer } = await mcp("src/lib/server.ts") as { startServer: (o: any) => Promise<any> };
const { combineModules } = await mcp("src/servers/index.ts") as { combineModules: (k: string[]) => any };
const { BuiltinPolicyEngine } = await mcp("src/lib/policy.ts") as { BuiltinPolicyEngine: new (c: any) => any };
const { loadCatalog } = await mcp("src/lib/catalog.ts") as { loadCatalog: () => any };
const { createAccessTokenVerifier } = await mcp("src/lib/auth.ts") as { createAccessTokenVerifier: (o: any) => any };
const { createApprovalVerifier } = await mcp("src/lib/approval.ts") as { createApprovalVerifier: (o: any) => any };
const helpers = await mcp("test/helpers.ts") as {
  ISSUER: string;
  signingKey: () => Promise<{ privateKey: unknown; jwks: unknown }>;
  accessToken: (k: unknown, c: Record<string, unknown>) => Promise<string>;
  fakeUpstream: (r: Record<string, (req: { body: string }) => { json?: unknown }>) => Promise<{ url: string; calls: Array<{ method: string; url: string; body: string; headers: Record<string, unknown> }>; close(): Promise<void> }>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const DEPLOYMENT = "/apis/apps/v1/namespaces/app-a-prd/deployments/api";

describe("approbation PRD de bout en bout", async () => {
  process.env.APPROVAL_ISSUER = "https://founderos.test";
  process.env.APPROVAL_SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const keycloak = await helpers.signingKey();
  const audit: Array<Record<string, unknown>> = [];
  let k8s: Awaited<ReturnType<typeof helpers.fakeUpstream>>;
  let server: { mcp: { address(): AddressInfo }; close(): Promise<void> };
  let url = "";
  let aliceToken = "";

  before(async () => {
    k8s = await helpers.fakeUpstream({ [`PATCH ${DEPLOYMENT}`]: () => ({ json: { metadata: { name: "api" } } }) });

    // Les clés publiques de FounderOS, déposées comme la ConfigMap approval-jwks.
    const jwksFile = path.join(mkdtempSync(path.join(tmpdir(), "approval-e2e-")), "jwks.json");
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
      verifyToken: createAccessTokenVerifier({ issuer: helpers.ISSUER, audience: "mcp-prd", jwks: keycloak.jwks }),
      verifyApproval: createApprovalVerifier({ issuer: "https://founderos.test", audience: "mcp-prd", jwksFile }),
      secrets: { resolve: async () => "sa-token-ocp" },
      audit: (e: Record<string, unknown>) => audit.push(e),
      mcpPort: 0,
      mgmtPort: 0,
      insecureHttp: true,
      host: "127.0.0.1",
    });
    url = `http://127.0.0.1:${server.mcp.address().port}/mcp`;
    // Le jeton d'appel d'ops-change au nom d'Alice (opératrice), comme après l'échange de jeton.
    aliceToken = await helpers.accessToken(keycloak.privateKey, {
      aud: "mcp-prd", sub: "kc-alice", azp: "agent-ops-change", scope: "ocp:restart", roles: ["ai-ops-operator"],
    });
  });
  after(async () => {
    await server.close();
    await k8s.close();
  });

  const args = { namespace: "app-a-prd", name: "api" };
  const headers = () => ({ Authorization: `Bearer ${aliceToken}` });
  const patches = () => k8s.calls.filter((c) => c.method === "PATCH").length;
  let payload: ReturnType<typeof buildMcpApprovalPayload>;

  it("1. sans approbation, le serveur répond approval_required et n'exécute rien", async () => {
    const out = await mcpCallTool(url, headers(), "deployment_restart", args);
    const required = parseApprovalRequired(out);
    assert.ok(required, out);
    assert.equal(required.target_cluster, "prd");
    assert.equal(patches(), 0);
    payload = buildMcpApprovalPayload({
      server: { id: "srv-prd", name: "cluster-prd", auth: { mode: "token_exchange", audience: "mcp-prd", cluster: "prd" } },
      args, required, callToken: aliceToken,
    });
    assert.equal(payload.requester_sub, "kc-alice");
  });

  it("2. la demandeuse ne peut pas approuver ; un approbateur, si", async () => {
    const row = {
      id: "3a7e0000-0000-4000-8000-000000000001", agent_id: "agent-change", run_id: null, workspace_id: "ws-1",
      tool_name: "mcp_cluster_prd_deployment_restart", action_kind: "mcp_tool", status: "pending",
      requested_by: "u-alice", expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      payload: payload as unknown as Record<string, unknown>,
    };
    const member = async () => true;
    const self = await gateMcpDecision(row, { userId: "u-alice", decision: "approve", identity: async () => ({ sub: "kc-alice", roles: [PRD_APPROVER_ROLE] }), isWorkspaceMember: member });
    assert.equal(self.ok, false);
    const bob = await gateMcpDecision(row, { userId: "u-bob", decision: "approve", identity: async () => ({ sub: "kc-bob", roles: [PRD_APPROVER_ROLE] }), isWorkspaceMember: member });
    assert.equal(bob.ok, true);
  });

  const sign = (over: Partial<Parameters<typeof signApprovalToken>[0]> = {}) => signApprovalToken({
    audience: payload.audience, requesterSub: payload.requester_sub, approverSub: "kc-bob",
    approvalId: "3a7e0000-0000-4000-8000-000000000001", tool: payload.tool,
    targetCluster: payload.target_cluster, paramsHash: payload.params_hash, ...over,
  });

  it("3. le jeton détourné vers un autre déploiement est refusé par le serveur", async () => {
    const { token } = await sign();
    const out = await mcpCallTool(url, { ...headers(), "X-Approval-Token": token }, "deployment_restart", { ...args, name: "billing" });
    assert.match(out, /invalid_approval/);
    assert.equal(patches(), 0);
  });

  it("4. une auto-approbation signée (approbateur = demandeur) est refusée par OPA", async () => {
    const { token } = await sign({ approverSub: "kc-alice" });
    const out = await mcpCallTool(url, { ...headers(), "X-Approval-Token": token }, "deployment_restart", args);
    assert.match(out, /approval_required/);
    assert.equal(patches(), 0);
  });

  it("5. le rejeu des mêmes paramètres avec le jeton de Bob redémarre le déploiement", async () => {
    audit.length = 0;
    const { token } = await sign();
    const run = "9b2f6d40-1c3e-4a5b-8d7f-2e6a1b9c0d34";
    const out = await mcpCallTool(url, { ...headers(), traceparent: traceparentFor(run), "X-Approval-Token": token }, payload.tool, payload.args);
    assert.ok(!out.startsWith("ERROR:"), out);
    assert.equal(patches(), 1);
    const patch = k8s.calls.find((c) => c.method === "PATCH")!;
    assert.match(patch.body, /kubectl\.kubernetes\.io\/restartedAt/);
    // L'outil ne voit que l'identifiant Vault, jamais le jeton d'appel ni celui d'approbation.
    assert.equal(patch.headers.authorization, "Bearer sa-token-ocp");
    const entry = audit.find((e) => e.tool === "deployment_restart" && e.status === "ok")!;
    assert.equal(entry.user, "kc-alice");
    assert.equal(entry.agent, "agent-ops-change");
    assert.equal(entry.approver, "kc-bob");
    assert.equal(entry.approval_id, "3a7e0000-0000-4000-8000-000000000001");
    assert.equal(entry.policy_decision, "allow");
    // D7 : le serveur journalise le trace_id que FounderOS met dans son propre audit.
    assert.equal(entry.trace_id, traceIdFor(run));
  });
});
