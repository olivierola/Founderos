import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SignJWT } from "jose";
import { createApprovalVerifier } from "../src/lib/approval.ts";
import { createAccessTokenVerifier } from "../src/lib/auth.ts";
import { canonicalJson, paramsHash } from "../src/lib/canonical.ts";
import { loadCatalog } from "../src/lib/catalog.ts";
import { Metrics } from "../src/lib/metrics.ts";
import { BuiltinPolicyEngine, type PolicyInput } from "../src/lib/policy.ts";
import { redact, redactValue } from "../src/lib/redact.ts";
import { accessToken, approvalToken, APPROVAL_ISSUER, ISSUER, signingKey } from "./helpers.ts";

describe("redact", () => {
  const cases: Array<[string, string]> = [
    ["Authorization: Bearer abcdefghijklmnop123", "Bearer abcdefghijklmnop123"],
    ["token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl", "eyJhbGciOiJSUzI1NiJ9"],
    ["postgres://app:S3cr3tP4ss@db.svc:5432/orders", "S3cr3tP4ss"],
    ['{"password": "hunter2hunter2"}', "hunter2hunter2"],
    ["db_password=Tr0ub4dor&3 user=bob", "Tr0ub4dor"],
    ["Server=x;Password=Pa55w0rd!;User Id=sa", "Pa55w0rd!"],
    ["key AKIAIOSFODNN7EXAMPLE leaked", "AKIAIOSFODNN7EXAMPLE"],
    ["ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"],
    ["vault hvs.CAESIJ7YkzQ2qN3ZQ0aVxk4lHk9nT1", "hvs.CAESIJ7YkzQ2qN3ZQ0aVxk4lHk9nT1"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ];
  for (const [input, secret] of cases) {
    it(`masque : ${input.slice(0, 40)}`, () => {
      const out = redact(input);
      assert.ok(!out.includes(secret), out);
      assert.ok(out.includes("[MASQUÉ]"), out);
    });
  }

  it("laisse intact un log ordinaire", () => {
    const line = "2026-10-10T08:00:00Z ERROR payment-api connection refused to db:5432 (author: bob)";
    assert.equal(redact(line), line);
  });

  it("parcourt les objets", () => {
    assert.deepEqual(redactValue({ a: ["x Bearer abcdefghijkl", 3] }), { a: ["x Bearer [MASQUÉ]", 3] });
  });
});

describe("canonical", () => {
  it("trie les clés récursivement, garde l'ordre des tableaux", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  });
  it("la même action donne la même empreinte, quel que soit l'ordre", () => {
    assert.equal(paramsHash({ namespace: "a", name: "b" }), paramsHash({ name: "b", namespace: "a" }));
    assert.notEqual(paramsHash({ namespace: "a", name: "b" }), paramsHash({ namespace: "a", name: "c" }));
  });
});

describe("jeton d'appel", async () => {
  const { privateKey, jwks } = await signingKey();
  const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: "mcp-openshift-prd", jwks });

  it("accepte un jeton valide et lit utilisateur, agent, scopes et rôles", async () => {
    const id = await verify(await accessToken(privateKey, { aud: "mcp-openshift-prd", scope: "openid ocp:read", roles: ["ai-ops-reader"], preferred_username: "alice" }));
    assert.equal(id.sub, "u-alice");
    assert.equal(id.azp, "agent-ops-investigator");
    assert.equal(id.username, "alice");
    assert.deepEqual(id.scopes, ["openid", "ocp:read"]);
    assert.deepEqual(id.roles, ["ai-ops-reader"]);
  });
  it("refuse un jeton destiné à un autre serveur", async () => {
    await assert.rejects(verify(await accessToken(privateKey, { aud: "mcp-openshift-npr" })), /refusé/);
  });
  it("refuse un autre émetteur", async () => {
    await assert.rejects(verify(await accessToken(privateKey, { aud: "mcp-openshift-prd", iss: "https://evil/realms/x" })), /refusé/);
  });
  it("refuse un jeton expiré", async () => {
    await assert.rejects(verify(await accessToken(privateKey, { aud: "mcp-openshift-prd", lifetime: -120 })), /refusé/);
  });
  it("refuse un jeton à durée de vie longue (pas un jeton d'appel)", async () => {
    await assert.rejects(verify(await accessToken(privateKey, { aud: "mcp-openshift-prd", lifetime: 3600 })), /durée de vie/);
  });
  it("refuse un agent hors liste", async () => {
    const strict = createAccessTokenVerifier({ issuer: ISSUER, audience: "mcp-openshift-prd", jwks, allowedAgents: ["agent-ops-change"] });
    await assert.rejects(strict(await accessToken(privateKey, { aud: "mcp-openshift-prd" })), /non autorisé/);
  });
  it("refuse une signature d'une autre clé", async () => {
    const other = await signingKey();
    await assert.rejects(verify(await accessToken(other.privateKey, { aud: "mcp-openshift-prd" })), /refusé/);
  });
});

describe("jeton d'appel émis par Entra ID (On-Behalf-Of)", async () => {
  const { privateKey, jwks } = await signingKey();
  const entraToken = (lifetime: number, extra: Record<string, unknown> = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ oid: "oid-alice", azp: "agent-inv-app", scp: "ocp.read", roles: ["ai-ops-reader"], ...extra })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER).setAudience("api://mcp-prd").setSubject("pw-mcp-prd-oid-alice")
      .setIssuedAt(iat).setExpirationTime(iat + lifetime)
      .sign(privateKey);
  };

  it("la durée de vie d'Entra (60 à 90 min) n'est acceptée que si on l'autorise", async () => {
    const strict = createAccessTokenVerifier({ issuer: ISSUER, audience: "api://mcp-prd", jwks });
    await assert.rejects(strict(await entraToken(3900)), /durée de vie trop longue/);
    const entra = createAccessTokenVerifier({ issuer: ISSUER, audience: "api://mcp-prd", jwks, maxLifetimeSeconds: 5460 });
    const id = await entra(await entraToken(3900));
    // La personne : oid (stable), pas le sub propre à cette application.
    assert.equal(id.sub, "oid-alice");
    assert.equal(id.azp, "agent-inv-app");
    assert.deepEqual(id.scopes, ["ocp.read"]);
    assert.deepEqual(id.roles, ["ai-ops-reader"]);
  });

  it("jeton Entra v1 : l'agent est lu dans appid", async () => {
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: "api://mcp-prd", jwks, maxLifetimeSeconds: 5460 });
    const id = await verify(await entraToken(3600, { azp: undefined, appid: "agent-v1-app" }));
    assert.equal(id.azp, "agent-v1-app");
  });
});

describe("jeton d'approbation", async () => {
  const { privateKey, jwks } = await signingKey();
  const verify = createApprovalVerifier({ issuer: APPROVAL_ISSUER, audience: "mcp-openshift-prd", jwks });
  const expected = { requester: "u-bob", tool: "deployment_restart", targetCluster: "prd", paramsHash: "h1" };
  const claims = { aud: "mcp-openshift-prd", sub: "u-bob", approver: "u-carol", tool: "deployment_restart", target_cluster: "prd", params_hash: "h1" };

  it("accepte un jeton lié à l'action", async () => {
    const a = await verify(await approvalToken(privateKey, claims), expected);
    assert.equal(a.approver, "u-carol");
    assert.equal(a.id, "approval-1");
    assert.deepEqual(a.approvers, ["u-carol"], "un jeton d'avant G3 : l'approbateur seul");
  });
  it("lit la liste des approbateurs d'une règle à quorum (G3)", async () => {
    const a = await verify(await approvalToken(privateKey, { ...claims, approvers: ["u-dave", "u-carol", "u-dave"] }), expected);
    assert.deepEqual(a.approvers, ["u-dave", "u-carol"]);
  });
  for (const [label, approvers, re] of [
    ["sans l'approbateur", ["u-dave"], /pas dans la liste/],
    ["vide", [], /mal formée/],
    ["qui n'est pas une liste", "u-carol", /mal formée/],
    ["trop longue", Array.from({ length: 11 }, (_, i) => `u-${i}`).concat("u-carol"), /mal formée/],
  ] as const) {
    it(`refuse une liste d'approbateurs ${label}`, async () => {
      await assert.rejects(verify(await approvalToken(privateKey, { ...claims, approvers }), expected), re);
    });
  }
  for (const [label, patch, re] of [
    ["d'autres paramètres", { params_hash: "h2" }, /autres paramètres/],
    ["un autre tool", { tool: "app_sync" }, /autre tool/],
    ["un autre cluster", { target_cluster: "npr" }, /autre cluster/],
    ["un autre demandeur", { sub: "u-mallory" }, /autre demandeur/],
    ["plus de 5 minutes", { lifetime: 900 }, /5 minutes/],
  ] as const) {
    it(`refuse un jeton émis pour ${label}`, async () => {
      await assert.rejects(verify(await approvalToken(privateKey, { ...claims, ...patch }), expected), re);
    });
  }
});

describe("politique intégrée (mêmes cas que policies/ai_tools_test.rego)", () => {
  const engine = new BuiltinPolicyEngine(loadCatalog());
  const readerTok = { sub: "u-alice", azp: "agent-ops-investigator", scopes: ["ocp:read", "obs:read"], roles: ["ai-ops-reader"] };
  const opTok = { sub: "u-bob", azp: "agent-ops-change", scopes: ["ocp:read", "ocp:restart", "alert:silence", "argocd:sync"], roles: ["ai-ops-operator"] };
  const base = (o: Partial<PolicyInput>): PolicyInput => ({ tool: "pods_list", cluster: "prd", target_cluster: "prd", params_hash: "h", token: readerTok, ...o });
  const approval = (approver: string, hash = "h") => ({ id: "a1", tool: "deployment_restart", target_cluster: "prd", params_hash: hash, approver });

  const cases: Array<[string, PolicyInput, string, string?]> = [
    ["lecteur lit PRD", base({}), "allow"],
    ["lecteur ne redémarre pas", base({ tool: "deployment_restart", cluster: "npr", target_cluster: "npr" }), "deny"],
    ["scope sans rôle", base({ tool: "deployment_restart", cluster: "npr", target_cluster: "npr", token: { ...readerTok, scopes: ["ocp:read", "ocp:restart"] } }), "deny", "role_missing"],
    ["opérateur redémarre en NPR", base({ tool: "deployment_restart", cluster: "npr", target_cluster: "npr", token: opTok }), "allow"],
    ["opérateur en PRD : approbation", base({ tool: "deployment_restart", token: opTok }), "approval_required"],
    ["PRD approuvé par un autre", base({ tool: "deployment_restart", token: opTok, approval: approval("u-carol") }), "allow"],
    ["auto-approbation invalide", base({ tool: "deployment_restart", token: opTok, approval: approval("u-bob") }), "approval_required"],
    ["approbation liée aux paramètres", base({ tool: "deployment_restart", token: opTok, approval: approval("u-carol", "other") }), "approval_required"],
    ["app_sync absent de PRD", base({ tool: "app_sync", token: opTok }), "deny", "not_in_catalog"],
    ["silence du Hub vers PRD", base({ tool: "alert_silence_create", cluster: "hub", token: opTok }), "approval_required"],
    ["silence du Hub vers NPR", base({ tool: "alert_silence_create", cluster: "hub", target_cluster: "npr", token: opTok }), "allow"],
    ["tool inconnu", base({ tool: "secrets_read", token: opTok }), "deny"],
  ];
  for (const [label, input, decision, reason] of cases) {
    it(label, async () => {
      const r = await engine.decide(input);
      assert.equal(r.decision, decision);
      if (reason) assert.equal(r.reason, reason);
    });
  }

  // Règles à quorum (G3) : mêmes cas que les tests OPA correspondants.
  const withApprovers = (approver: string, approvers: string[]) => ({ ...approval(approver), approvers });
  const quorum2 = new BuiltinPolicyEngine({ ...loadCatalog(), approval_quorum: { prd: 2 } });
  const quorumCases: Array<[string, BuiltinPolicyEngine, PolicyInput, string]> = [
    ["liste sans le demandeur", engine, base({ tool: "deployment_restart", token: opTok, approval: withApprovers("u-carol", ["u-dave", "u-carol"]) }), "allow"],
    ["demandeur parmi les approbateurs", engine, base({ tool: "deployment_restart", token: opTok, approval: withApprovers("u-carol", ["u-bob", "u-carol"]) }), "approval_required"],
    ["quorum 2 du cluster, un approbateur", quorum2, base({ tool: "deployment_restart", token: opTok, approval: approval("u-carol") }), "approval_required"],
    ["quorum 2, le même deux fois", quorum2, base({ tool: "deployment_restart", token: opTok, approval: withApprovers("u-carol", ["u-carol", "u-carol"]) }), "approval_required"],
    ["quorum 2, deux approbateurs distincts", quorum2, base({ tool: "deployment_restart", token: opTok, approval: withApprovers("u-carol", ["u-dave", "u-carol"]) }), "allow"],
    ["quorum de PRD, appel en NPR", quorum2, base({ tool: "deployment_restart", cluster: "npr", target_cluster: "npr", token: opTok }), "allow"],
  ];
  for (const [label, eng, input, decision] of quorumCases) {
    it(`quorum : ${label}`, async () => assert.equal((await eng.decide(input)).decision, decision));
  }
});

describe("métriques", () => {
  it("rend le format texte Prometheus", () => {
    const m = new Metrics();
    m.calls.inc({ tool: "pods_list", cluster: "prd", status: "ok" });
    m.duration.observe({ tool: "pods_list" }, 0.2);
    const out = m.render();
    assert.match(out, /ai_tool_calls_total\{cluster="prd",status="ok",tool="pods_list"\} 1/);
    assert.match(out, /ai_tool_duration_seconds_bucket\{le="0.25",tool="pods_list"\} 1/);
    assert.match(out, /ai_tool_duration_seconds_count\{tool="pods_list"\} 1/);
  });
});
