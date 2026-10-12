// G3, acceptation : les étapes de D6 rejouées sur une règle « prod, écriture,
// 2 approbateurs du groupe Ops », contre le VRAI serveur MCP (code de MCP/,
// cluster PRD, catalogue exigeant lui aussi 2 approbateurs distincts).
//
//   1. l'agent demande deployment_restart en PRD → approval_required ;
//   2. FounderOS trouve la règle de production : 2 approbateurs du groupe Ops ;
//   3. la demandeuse et un membre hors du groupe ne votent pas ;
//   4. une seule voix ne suffit ni à FounderOS ni au serveur ;
//   5. la deuxième voix d'Ops : le jeton porte les deux, le serveur exécute ;
//   6. un jeton dont un approbateur est la demandeuse est refusé par OPA.
//
// Seul Keycloak est simulé : les jetons d'appel sont signés par la clé de test.

import "../test-env.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mcpCallTool } from "../edge/_shared/mcp-client.ts";
import { approvalJwks, buildMcpApprovalPayload, parseApprovalRequired, signApprovalToken } from "../edge/_shared/mcp-approval.ts";
import {
  approvalColumns, describeApprovers, gateApprovalVote, matchApprovalPolicy, toResolved, type ApprovalPolicy, type PolicyApprovalRow,
} from "../edge/_shared/approval-policy.ts";

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
const APPROVAL_ID = "3a7e0000-0000-4000-8000-000000000003";

/** Les personnes : compte FounderOS, rôle dans l'espace, identité Keycloak (rôles et groupes). */
const PEOPLE = {
  alice: { user: "u-alice", role: "member", sub: "kc-alice", groups: ["Ops"] },   // demandeuse, elle-même d'Ops
  carol: { user: "u-carol", role: "member", sub: "kc-carol", groups: ["Finance"] },
  ops1: { user: "u-ops1", role: "member", sub: "kc-ops1", groups: ["Ops"] },
  ops2: { user: "u-ops2", role: "member", sub: "kc-ops2", groups: ["Ops"] },
} as const;

describe("G3 : D6 rejoué sur « prod, écriture, 2 approbateurs du groupe Ops »", async () => {
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
    const jwksFile = path.join(mkdtempSync(path.join(tmpdir(), "g3-e2e-")), "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(await approvalJwks()));
    // Le catalogue du cluster exige lui aussi 2 approbateurs distincts en PRD.
    const catalog = { ...loadCatalog(), approval_quorum: { prd: 2 } };
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
      mcpPort: 0, mgmtPort: 0, insecureHttp: true, host: "127.0.0.1",
    });
    url = `http://127.0.0.1:${server.mcp.address().port}/mcp`;
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

  // Les règles de l'espace : la règle d'acceptation, et une règle large qui ne doit pas gagner.
  const policies: ApprovalPolicy[] = [
    { id: "pol-large", name: "écritures : un admin", enabled: true, priority: 100, connection_kind: null, connection_id: null,
      environment: null, min_risk: "write", operations: [], approver_roles: ["admin"], approver_idp_roles: [], quorum: 1, ttl_minutes: 15 },
    { id: "pol-ops", name: "prod, écriture, 2 Ops", enabled: true, priority: 100, connection_kind: "mcp", connection_id: null,
      environment: "production", min_risk: "write", operations: [], approver_roles: [], approver_idp_roles: ["Ops"], quorum: 2, ttl_minutes: 30 },
  ];
  let row: PolicyApprovalRow;
  const votes: Array<{ user: string; sub: string }> = [];
  const vote = async (who: keyof typeof PEOPLE, decision: "approve" | "reject" = "approve") => {
    const p = PEOPLE[who];
    const g = await gateApprovalVote(row, {
      userId: p.user, decision,
      identity: async () => ({ sub: p.sub, roles: [...p.groups] }),
      workspaceRole: async () => p.role,
      alreadyVoted: async () => votes.some((v) => v.user === p.user),
    });
    if (g.ok && decision === "approve") votes.push({ user: p.user, sub: g.approver!.sub });
    return g;
  };
  const sign = (approvers: string[]) => signApprovalToken({
    audience: row.payload.audience as string, requesterSub: row.payload.requester_sub as string,
    approverSub: approvers[approvers.length - 1], approvers, approvalId: APPROVAL_ID,
    tool: row.payload.tool as string, targetCluster: row.payload.target_cluster as string, paramsHash: row.payload.params_hash as string,
  });

  it("1-2. approval_required, puis la règle de production : 2 approbateurs du groupe Ops, 30 minutes", async () => {
    const out = await mcpCallTool(url, headers(), "deployment_restart", args);
    const required = parseApprovalRequired(out);
    assert.ok(required, out);
    assert.equal(patches(), 0);
    const hit = matchApprovalPolicy(policies, {
      kind: "mcp", connectionId: "srv-prd", environment: "production", risk: "write", operation: required.tool,
    });
    assert.equal(hit?.id, "pol-ops", "la règle la plus précise l'emporte à priorité égale");
    const resolved = toResolved(hit!);
    const cols = approvalColumns(resolved, "production");
    assert.equal(describeApprovers(resolved), "2 approbateurs distincts : « Ops »");
    const payload = buildMcpApprovalPayload({
      server: { id: "srv-prd", name: "cluster-prd", auth: { mode: "token_exchange", audience: "mcp-prd", cluster: "prd" } },
      args, required, callToken: aliceToken,
    });
    row = {
      id: APPROVAL_ID, agent_id: "agent-change", run_id: null, workspace_id: "ws-1",
      tool_name: "mcp_cluster_prd_deployment_restart", action_kind: "mcp_tool", status: "pending",
      requested_by: "u-alice", expires_at: cols.expires_at, payload: payload as unknown as Record<string, unknown>,
      quorum: cols.quorum, approver_rule: cols.approver_rule,
    };
    assert.ok(Date.parse(row.expires_at!) - Date.now() > 29 * 60_000);
  });

  it("3. la demandeuse, bien qu'elle soit d'Ops, et un membre hors du groupe ne votent pas", async () => {
    const self = await vote("alice");
    assert.match(!self.ok ? self.error : "", /quatre yeux/);
    const carol = await vote("carol");
    assert.match(!carol.ok ? carol.error : "", /réservée à 2 approbateurs distincts : « Ops »/);
    assert.equal(votes.length, 0);
  });

  it("4. une seule voix : FounderOS ne signe pas, et le serveur refuserait de toute façon", async () => {
    assert.equal((await vote("ops1")).ok, true);
    assert.equal(votes.length < row.quorum, true, "quorum non atteint : rien n'est signé");
    const twice = await vote("ops1");
    assert.match(!twice.ok ? twice.error : "", /déjà approuvé/);
    // Même si FounderOS signait trop tôt, le catalogue du cluster exige deux approbateurs.
    const { token } = await sign([votes[0].sub]);
    const out = await mcpCallTool(url, { ...headers(), "X-Approval-Token": token }, "deployment_restart", args);
    assert.match(out, /approval_required/);
    assert.equal(patches(), 0);
  });

  it("5. la deuxième voix d'Ops : le jeton porte les deux approbateurs, le déploiement redémarre", async () => {
    assert.equal((await vote("ops2")).ok, true);
    assert.equal(votes.length, row.quorum);
    audit.length = 0;
    const { token } = await sign(votes.map((v) => v.sub));
    const out = await mcpCallTool(url, { ...headers(), "X-Approval-Token": token }, row.payload.tool as string, row.payload.args as Record<string, unknown>);
    assert.ok(!out.startsWith("ERROR:"), out);
    assert.equal(patches(), 1);
    const entry = audit.find((e) => e.tool === "deployment_restart" && e.status === "ok")!;
    assert.equal(entry.user, "kc-alice");
    assert.equal(entry.approver, "kc-ops2");
    assert.deepEqual(entry.approvers, ["kc-ops1", "kc-ops2"]);
    assert.equal(entry.approval_id, APPROVAL_ID);
  });

  it("6. un jeton dont la demandeuse fait partie des approbateurs est refusé par la politique du serveur", async () => {
    const { token } = await sign(["kc-alice", "kc-ops2"]);
    const out = await mcpCallTool(url, { ...headers(), "X-Approval-Token": token }, "deployment_restart", args);
    assert.match(out, /approval_required/);
    assert.equal(patches(), 1);
  });
});
