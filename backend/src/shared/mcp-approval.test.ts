// Approbations PRD (D6) : lecture de la réponse `approval_required`, règles de
// décision, jeton d'approbation signé par FounderOS ET vérifié par le code du
// serveur MCP lui-même (contrat), JWKS public.

import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { IdpError } from "../edge/_shared/idp-tokens.ts";
import {
  approvalJwks, buildMcpApprovalPayload, executeMcpApproval, gateMcpDecision, parseApprovalRequired, PRD_APPROVER_ROLE,
  signApprovalToken, type McpApprovalRow,
} from "../edge/_shared/mcp-approval.ts";
import { createServer } from "../server.ts";

// Le vérificateur du serveur MCP lui-même (MCP/src/lib/approval.ts) : hors du
// rootDir du backend, il est chargé dynamiquement et typé ici.
type McpApprovalVerifier = (
  token: string,
  expected: { requester: string; tool: string; targetCluster: string; paramsHash: string },
) => Promise<{ id: string; tool: string; target_cluster: string; params_hash: string; approver: string; approvers: string[] }>;
const { createApprovalVerifier } = (await import(new URL("../../../MCP/src/lib/approval.ts", import.meta.url).href)) as {
  createApprovalVerifier: (o: { issuer: string; audience: string; jwksFile?: string }) => McpApprovalVerifier;
};

const HASH = "a".repeat(64);
const pem = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const callToken = (claims: Record<string, unknown>) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`;

beforeEach(() => {
  process.env.APPROVAL_ISSUER = "https://founderos.test";
  process.env.APPROVAL_SIGNING_KEY = pem();
  delete process.env.APPROVAL_JWKS_EXTRA;
});

describe("réponse approval_required", () => {
  const body = { error: "approval_required", tool: "deployment_restart", mcp_server: "mcp", target_cluster: "prd", params: { namespace: "app-a-prd", name: "api" }, params_hash: HASH, message: "Action soumise à approbation (prd)" };

  it("est lue dans le texte rendu par le client MCP", () => {
    assert.deepEqual(parseApprovalRequired(`ERROR: ${JSON.stringify(body)}`), {
      tool: "deployment_restart", target_cluster: "prd", params_hash: HASH,
      params: { namespace: "app-a-prd", name: "api" }, message: "Action soumise à approbation (prd)",
    });
  });

  it("une autre erreur, ou une réponse mal formée, n'ouvre pas de demande", () => {
    assert.equal(parseApprovalRequired(`ERROR: ${JSON.stringify({ error: "denied", reason: "scope_missing" })}`), null);
    assert.equal(parseApprovalRequired("ERROR: approval_required, mais pas en JSON"), null);
    assert.equal(parseApprovalRequired(`ERROR: ${JSON.stringify({ ...body, params_hash: "xyz" })}`), null);
    assert.equal(parseApprovalRequired(`ERROR: ${JSON.stringify({ ...body, target_cluster: "PRD; drop" })}`), null);
    assert.equal(parseApprovalRequired(`ERROR: ${JSON.stringify({ ...body, tool: "../../etc" })}`), null);
  });

  it("la demande est liée au `sub` du jeton d'appel, celui que voit le serveur", () => {
    const required = parseApprovalRequired(JSON.stringify(body))!;
    const server = { id: "srv-1", name: "cluster-prd", auth: { mode: "token_exchange" as const, audience: "mcp-prd", cluster: "prd" } };
    const p = buildMcpApprovalPayload({ server, args: { namespace: "app-a-prd", name: "api" }, required, callToken: callToken({ sub: "kc-alice", azp: "agent-ops-change" }) });
    assert.equal(p.requester_sub, "kc-alice");
    assert.equal(p.audience, "mcp-prd");
    assert.deepEqual(p.args, { namespace: "app-a-prd", name: "api" });
    assert.throws(() => buildMcpApprovalPayload({ server, args: {}, required, callToken: callToken({ azp: "x" }) }), /sans `sub`/);
  });
});

describe("règles de décision", () => {
  const row = (over: Partial<McpApprovalRow> = {}): McpApprovalRow => ({
    id: "ap-1", agent_id: "agent-1", run_id: "run-1", workspace_id: "ws-1", tool_name: "mcp_cluster_prd_deployment_restart",
    action_kind: "mcp_tool", status: "pending", requested_by: "u-alice",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    payload: { requester_sub: "kc-alice", tool: "deployment_restart", target_cluster: "prd", params_hash: HASH, audience: "mcp-prd" },
    ...over,
  });
  const approver = async () => ({ sub: "kc-bob", roles: [PRD_APPROVER_ROLE, "ai-ops-reader"] });
  const member = async () => true;
  const gate = (r: McpApprovalRow, userId: string, decision: "approve" | "approve_all" | "reject", extra: Partial<Parameters<typeof gateMcpDecision>[1]> = {}) =>
    gateMcpDecision(r, { userId, decision, identity: approver, isWorkspaceMember: member, ...extra });

  it("un approbateur valide la demande d'une autre personne", async () => {
    const out = await gate(row(), "u-bob", "approve");
    assert.deepEqual(out, { ok: true, approver: { sub: "kc-bob", roles: [PRD_APPROVER_ROLE, "ai-ops-reader"] } });
  });

  it("quatre yeux : le demandeur ne peut pas approuver, ni sous son compte, ni sous son identité Keycloak", async () => {
    assert.deepEqual(await gate(row(), "u-alice", "approve"), { ok: false, status: 403, error: "Règle des quatre yeux : vous ne pouvez pas approuver une action demandée en votre nom." });
    const sameIdentity = await gate(row(), "u-alice-bis", "approve", { identity: async () => ({ sub: "kc-alice", roles: [PRD_APPROVER_ROLE] }) });
    assert.equal(sameIdentity.ok, false);
    assert.match((sameIdentity as { error: string }).error, /identité Keycloak est celle du demandeur/);
  });

  it("le demandeur peut retirer sa demande", async () => {
    assert.deepEqual(await gate(row(), "u-alice", "reject"), { ok: true, approver: null });
  });

  it("le rôle d'approbateur est exigé, lu dans un jeton frais", async () => {
    const out = await gate(row(), "u-carol", "approve", { identity: async () => ({ sub: "kc-carol", roles: ["ai-ops-reader"] }) });
    assert.equal((out as { status: number }).status, 403);
    const reject = await gate(row(), "u-carol", "reject", { identity: async () => ({ sub: "kc-carol", roles: [] }) });
    assert.equal(reject.ok, false);
  });

  it("sans session SSO valide, l'approbation est refusée avec la raison", async () => {
    const out = await gate(row(), "u-bob", "approve", { identity: async () => { throw new IdpError("session_expired", "La session SSO de cette personne a expiré : elle doit se reconnecter."); } });
    assert.equal((out as { status: number }).status, 403);
    assert.match((out as { error: string }).error, /session SSO valide : La session SSO/);
  });

  it("hors de l'espace de la demande, refusé", async () => {
    const out = await gate(row(), "u-bob", "approve", { isWorkspaceMember: async () => false });
    assert.equal((out as { status: number }).status, 403);
  });

  it("une action à la fois : approve_all refusé", async () => {
    assert.equal((await gate(row(), "u-bob", "approve_all") as { status: number }).status, 400);
  });

  it("après l'échéance, la demande est expirée, même pour un approbateur", async () => {
    const out = await gate(row({ expires_at: new Date(Date.now() - 1000).toISOString() }), "u-bob", "approve");
    assert.deepEqual(out, { ok: false, status: 409, error: "Demande expirée : l'agent doit refaire sa demande.", expired: true });
    assert.equal((await gate(row({ status: "executed" }), "u-bob", "approve") as { status: number }).status, 409);
  });
});

describe("jeton d'approbation : signé par FounderOS, vérifié par le serveur MCP", () => {
  const sign = (over: Partial<Parameters<typeof signApprovalToken>[0]> = {}) => signApprovalToken({
    audience: "mcp-prd", requesterSub: "kc-alice", approverSub: "kc-bob", approvalId: "ap-1",
    tool: "deployment_restart", targetCluster: "prd", paramsHash: HASH, ...over,
  });
  // Le JWKS publié, déposé comme la ConfigMap d'un cluster (APPROVAL_JWKS_FILE).
  const publishedJwks = async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "approval-")), "jwks.json");
    writeFileSync(file, JSON.stringify(await approvalJwks()));
    return file;
  };
  const verifier = async (audience = "mcp-prd") =>
    createApprovalVerifier({ issuer: "https://founderos.test", audience, jwksFile: await publishedJwks() });
  const expected = { requester: "kc-alice", tool: "deployment_restart", targetCluster: "prd", paramsHash: HASH };

  it("le serveur MCP accepte le jeton de l'action exacte", async () => {
    const signed = await sign();
    assert.equal(signed.exp - signed.iat, 300);
    const verified = await (await verifier())(signed.token, expected);
    assert.deepEqual(verified, { id: "ap-1", tool: "deployment_restart", target_cluster: "prd", params_hash: HASH, approver: "kc-bob", approvers: ["kc-bob"] });
  });

  it("règle à quorum (G3) : le jeton porte tous les approbateurs, le dernier compris", async () => {
    const signed = await sign({ approverSub: "kc-carol", approvers: ["kc-bob"] });
    const verified = await (await verifier())(signed.token, expected);
    assert.equal(verified.approver, "kc-carol");
    assert.deepEqual(verified.approvers, ["kc-bob", "kc-carol"]);
  });

  it("et le refuse pour d'autres paramètres, un autre demandeur, un autre serveur", async () => {
    const verify = await verifier();
    const { token } = await sign();
    await assert.rejects(verify(token, { ...expected, paramsHash: "b".repeat(64) }), /d'autres paramètres/);
    await assert.rejects(verify(token, { ...expected, requester: "kc-mallory" }), /autre demandeur/);
    await assert.rejects(verify(token, { ...expected, targetCluster: "npr" }), /autre cluster/);
    const other = await verifier("mcp-npr");
    await assert.rejects(other(token, expected), /refusé/);
  });

  it("un jeton signé par une autre clé est refusé", async () => {
    const verify = await verifier();
    process.env.APPROVAL_SIGNING_KEY = pem();
    const { token } = await sign();
    await assert.rejects(verify(token, expected), /refusé/);
  });

  it("sans clé ou sans émetteur, FounderOS refuse de signer", async () => {
    delete process.env.APPROVAL_SIGNING_KEY;
    await assert.rejects(sign(), /APPROVAL_SIGNING_KEY absent/);
    process.env.APPROVAL_SIGNING_KEY = pem();
    delete process.env.APPROVAL_ISSUER;
    await assert.rejects(sign(), /APPROVAL_ISSUER absent/);
  });
});

describe("JWKS public", () => {
  let server: Server;
  let api = "";
  before(async () => {
    server = createServer({}, { gateway: "strict" });
    api = await listen(server);
  });
  after(() => { server.close(); });

  it("ne publie que la partie publique, plus les clés de rotation, jamais une clé privée", async () => {
    const extraPublic = { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "next", alg: "ES256", use: "sig" };
    const leaked = { ...extraPublic, kid: "oops", d: "secret" };
    process.env.APPROVAL_JWKS_EXTRA = JSON.stringify({ keys: [extraPublic, leaked] });
    const { keys } = await approvalJwks();
    assert.equal(keys.length, 2);
    assert.ok(keys.every((k) => !("d" in k)));
    assert.equal(keys[0].alg, "ES256");
    assert.equal(keys[1].kid, "next");
  });

  it("GET /functions/v1/approval-jwks répond sans JWT, même en mode strict", async () => {
    const res = await fetch(`${api}/functions/v1/approval-jwks`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /max-age=300/);
    const body = await res.json() as { keys: Array<Record<string, unknown>> };
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0].kty, "EC");
    assert.equal("d" in body.keys[0], false);
  });

  it("sans clé configurée : 404", async () => {
    delete process.env.APPROVAL_SIGNING_KEY;
    assert.equal((await fetch(`${api}/functions/v1/approval-jwks`)).status, 404);
  });
});

describe("rejeu : rien n'est rejoué si la situation a changé", () => {
  // Faux client Supabase : juste ce que lit executeMcpApproval.
  const fakeAdmin = (tables: Record<string, Record<string, unknown> | null>) => ({
    from: (table: string) => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: tables[table] ?? null }) };
      return q;
    },
  }) as never;
  const approval = {
    agent_id: "agent-1", run_id: "run-1", requested_by: "u-alice",
    payload: { server_id: "srv-1", tool: "deployment_restart", args: { namespace: "app-a-prd", name: "api" }, audience: "mcp-prd", requester_sub: "kc-alice", params_hash: HASH, target_cluster: "prd" },
  };

  it("serveur désactivé", async () => {
    const out = await executeMcpApproval(fakeAdmin({ mcp_servers: { id: "srv-1", enabled: false } }), approval, "token");
    assert.deepEqual(out, { ok: false, detail: "Serveur MCP introuvable ou désactivé depuis la demande." });
  });

  it("audience du serveur modifiée depuis la demande", async () => {
    const out = await executeMcpApproval(fakeAdmin({
      mcp_servers: { id: "srv-1", name: "cluster-prd", url: "https://mcp.apps-int.prd.interne.exemple/mcp", enabled: true, auth_mode: "token_exchange", auth_config: { audience: "mcp-npr" } },
    }), approval, "token");
    assert.match(out.detail, /configuration du serveur MCP a changé/);
  });
});

