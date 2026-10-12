// Règles d'approbation (G3) : quelle règle s'applique, qui peut voter, et quand
// le vote est refusé.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalColumns, DEFAULT_MCP_POLICY, describeApprovers, gateApprovalVote, isEligibleApprover, matchApprovalPolicy,
  resolveApprovalPolicy, type ApprovalPolicy, type ApprovalScope, type PolicyApprovalRow,
} from "../edge/_shared/approval-policy.ts";
import { IdpError } from "../edge/_shared/idp-tokens.ts";

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  id: "p-default", name: "règle", enabled: true, priority: 100, connection_kind: null, connection_id: null,
  environment: null, min_risk: "write", operations: [], approver_roles: ["admin"], approver_idp_roles: [],
  quorum: 1, ttl_minutes: 15, created_at: "2026-10-01T00:00:00Z", ...over,
});
const scope = (over: Partial<ApprovalScope> = {}): ApprovalScope => ({
  kind: "mcp", connectionId: "srv-prd", environment: "production", risk: "write", operation: "deployment_restart", ...over,
});

describe("quelle règle s'applique", () => {
  const ops = policy({ id: "ops", name: "prod, écriture, 2 Ops", environment: "production", approver_roles: [], approver_idp_roles: ["Ops"], quorum: 2, ttl_minutes: 30 });

  it("prod, écriture : la règle de production, pas pour une connexion sans environnement", () => {
    assert.equal(matchApprovalPolicy([ops], scope())?.id, "ops");
    assert.equal(matchApprovalPolicy([ops], scope({ environment: null })), null);
    assert.equal(matchApprovalPolicy([ops], scope({ environment: "staging" })), null);
  });

  it("le risque, les opérations, la connexion, le type, l'état", () => {
    assert.equal(matchApprovalPolicy([policy({ min_risk: "destructive" })], scope({ risk: "write" })), null);
    assert.ok(matchApprovalPolicy([policy({ min_risk: "destructive" })], scope({ risk: "destructive" })));
    assert.equal(matchApprovalPolicy([policy({ min_risk: "write" })], scope({ risk: "read" })), null);
    assert.equal(matchApprovalPolicy([policy({ operations: ["app_sync"] })], scope()), null);
    assert.ok(matchApprovalPolicy([policy({ operations: ["deployment_restart"] })], scope()));
    assert.equal(matchApprovalPolicy([policy({ connection_kind: "mcp", connection_id: "autre" })], scope()), null);
    assert.equal(matchApprovalPolicy([policy({ connection_kind: "custom_connector" })], scope()), null);
    assert.equal(matchApprovalPolicy([policy({ enabled: false })], scope()), null);
  });

  it("la plus petite priorité, puis la plus précise, puis la plus ancienne", () => {
    const broad = policy({ id: "large", priority: 100 });
    const precise = policy({ id: "precise", priority: 100, connection_kind: "mcp", connection_id: "srv-prd" });
    const urgent = policy({ id: "urgente", priority: 10 });
    assert.equal(matchApprovalPolicy([broad, precise], scope())?.id, "precise");
    assert.equal(matchApprovalPolicy([broad, precise, urgent], scope())?.id, "urgente");
    const older = policy({ id: "ancienne", created_at: "2026-01-01T00:00:00Z" });
    assert.equal(matchApprovalPolicy([broad, older], scope())?.id, "ancienne");
  });

  it("sans règle : le défaut d'avant pour MCP, rien pour un outil interne ; base injoignable : pareil", async () => {
    const empty = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [] }) }) }) }) } as never;
    assert.deepEqual(await resolveApprovalPolicy(empty, "ws", scope()), DEFAULT_MCP_POLICY);
    assert.equal(await resolveApprovalPolicy(empty, "ws", scope({ kind: "custom_connector" })), null);
    const broken = { from: () => { throw new Error("table absente"); } } as never;
    assert.deepEqual(await resolveApprovalPolicy(broken, "ws", scope()), DEFAULT_MCP_POLICY);
    assert.deepEqual(DEFAULT_MCP_POLICY.rule, { roles: [], idp_roles: ["ai-ops-prd-approver"] });
  });

  it("la copie gardée sur la demande, et le texte pour l'agent", async () => {
    const one = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [ops] }) }) }) }) } as never;
    const resolved = (await resolveApprovalPolicy(one, "ws", scope()))!;
    const cols = approvalColumns(resolved, "production", Date.parse("2026-10-11T10:00:00Z"));
    assert.deepEqual(cols, {
      quorum: 2, approver_rule: { roles: [], idp_roles: ["Ops"] }, policy_id: "ops", policy_name: "prod, écriture, 2 Ops",
      environment: "production", expires_at: "2026-10-11T10:30:00.000Z",
    });
    assert.equal(approvalColumns(resolved, "prod").environment, null);
    assert.equal(describeApprovers(resolved), "2 approbateurs distincts : « Ops »");
    assert.equal(describeApprovers({ rule: { roles: ["owner", "admin"], idp_roles: [] }, quorum: 1 }), "1 approbateur : propriétaire ou admin");
  });

  it("qui est approbateur : un rôle FounderOS ou un rôle/groupe de l'IdP", () => {
    const rule = { roles: ["admin"], idp_roles: ["Ops", "/Ops"] };
    assert.equal(isEligibleApprover(rule, { workspaceRole: "admin", idpRoles: [] }), true);
    assert.equal(isEligibleApprover(rule, { workspaceRole: "member", idpRoles: ["/Ops"] }), true);
    assert.equal(isEligibleApprover(rule, { workspaceRole: "member", idpRoles: ["Finance"] }), false);
  });
});

describe("le vote", () => {
  const row = (over: Partial<PolicyApprovalRow> = {}): PolicyApprovalRow => ({
    id: "ap-1", agent_id: "agent-1", run_id: null, workspace_id: "ws-1", tool_name: "mcp_cluster_prd_deployment_restart",
    action_kind: "mcp_tool", status: "pending", requested_by: "u-alice",
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    payload: { requester_sub: "kc-alice", tool: "deployment_restart", target_cluster: "prd" },
    quorum: 2, approver_rule: { roles: [], idp_roles: ["Ops"] }, ...over,
  });
  const input = (over: Partial<Parameters<typeof gateApprovalVote>[1]> = {}): Parameters<typeof gateApprovalVote>[1] => ({
    userId: "u-ops1", decision: "approve",
    identity: async () => ({ sub: "kc-ops1", roles: ["Ops"] }),
    workspaceRole: async () => "member",
    alreadyVoted: async () => false,
    ...over,
  });

  it("un approbateur du groupe vote", async () => {
    const g = await gateApprovalVote(row(), input());
    assert.equal(g.ok, true);
    assert.equal(g.ok && g.approver?.sub, "kc-ops1");
  });

  it("refusé : demande close ou expirée, « tout approuver »", async () => {
    assert.equal((await gateApprovalVote(row({ status: "executed" }), input())).ok, false);
    const exp = await gateApprovalVote(row({ expires_at: new Date(Date.now() - 1000).toISOString() }), input());
    assert.equal(!exp.ok && exp.expired, true);
    const all = await gateApprovalVote(row(), input({ decision: "approve_all" }));
    assert.match(!all.ok ? all.error : "", /une par une/);
  });

  it("quatre yeux : la demandeuse peut retirer, pas approuver ; ni sous son identité IdP", async () => {
    const self = await gateApprovalVote(row(), input({ userId: "u-alice" }));
    assert.match(!self.ok ? self.error : "", /quatre yeux/);
    assert.equal((await gateApprovalVote(row(), input({ userId: "u-alice", decision: "reject" }))).ok, true);
    const sameIdp = await gateApprovalVote(row(), input({ identity: async () => ({ sub: "kc-alice", roles: ["Ops"] }) }));
    assert.match(!sameIdp.ok ? sameIdp.error : "", /identité est celle du demandeur/);
  });

  it("refusé : hors de l'espace, hors du groupe, sans session SSO, deuxième voix", async () => {
    const out = await gateApprovalVote(row(), input({ workspaceRole: async () => null }));
    assert.match(!out.ok ? out.error : "", /pas membre/);
    const noGroup = await gateApprovalVote(row(), input({ identity: async () => ({ sub: "kc-carol", roles: ["Finance"] }) }));
    assert.match(!noGroup.ok ? noGroup.error : "", /réservée à 2 approbateurs distincts : « Ops »/);
    const noSso = await gateApprovalVote(row(), input({ identity: async () => { throw new IdpError("no_session", "Aucune session SSO conservée"); } }));
    assert.match(!noSso.ok ? noSso.error : "", /session SSO/);
    const twice = await gateApprovalVote(row(), input({ alreadyVoted: async () => true }));
    assert.match(!twice.ok ? twice.error : "", /déjà approuvé/);
  });

  it("une règle « admin » : le rôle FounderOS suffit, sans groupe", async () => {
    const r = row({ approver_rule: { roles: ["admin"], idp_roles: [] }, quorum: 1 });
    assert.equal((await gateApprovalVote(r, input({ workspaceRole: async () => "admin", identity: async () => ({ sub: "u-admin", roles: [] }) }))).ok, true);
    assert.equal((await gateApprovalVote(r, input({ identity: async () => ({ sub: "u-x", roles: [] }) }))).ok, false);
  });

  it("connexion SSO récente exigée (0284) : trop ancienne ou absente, la voix est refusée ; récente, acceptée", async () => {
    const r = row({ approver_rule: { roles: [], idp_roles: ["Ops"], fresh_login_minutes: 60 } });
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const old = await gateApprovalVote(r, input({ lastSsoLoginAt: async () => ago(180) }));
    assert.match(!old.ok ? old.error : "", /moins de 60 min.*il y a 180 min/);
    const none = await gateApprovalVote(r, input({ lastSsoLoginAt: async () => null }));
    assert.match(!none.ok ? none.error : "", /aucune/);
    assert.equal((await gateApprovalVote(r, input({ lastSsoLoginAt: async () => ago(5) }))).ok, true);
    // Un refus (veto) ne demande pas de connexion récente.
    assert.equal((await gateApprovalVote(r, input({ decision: "reject", lastSsoLoginAt: async () => null }))).ok, true);
  });

  it("un approbateur peut rejeter (veto) ; un membre quelconque, non", async () => {
    assert.equal((await gateApprovalVote(row(), input({ decision: "reject" }))).ok, true);
    assert.equal((await gateApprovalVote(row(), input({ decision: "reject", identity: async () => ({ sub: "kc-x", roles: [] }) }))).ok, false);
  });
});
