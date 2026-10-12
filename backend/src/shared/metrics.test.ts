// Audit et métriques des appels MCP côté FounderOS (D7).

import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { traceparentFor } from "../edge/_shared/mcp-auth.ts";
import { callIdentity, classifyMcpResult, reportToolCall, traceIdFor } from "../edge/_shared/mcp-observe.ts";
import { createMcpObserver, createMgmtServer, Metrics } from "./metrics.ts";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const RUN = "5f0c2a1e-8b7d-4c3a-9e21-0d6f4b8a7c12";

const event = (over: Record<string, unknown> = {}) => ({
  trace_id: traceIdFor(RUN), session_id: RUN, user: "u-alice", user_sub: "kc-alice", agent: "ops-investigator",
  agent_client: "agent-ops-investigator", workspace_id: "ws-1", mcp_server: "cluster-prd", cluster: "prd",
  tool: "pods_list", status: "ok", reason: null, policy_decision: "allow", approval_id: null, duration_ms: 120,
  ...over,
});

describe("observateur des appels MCP", () => {
  it("une ligne JSON d'audit par appel, et les métriques", () => {
    const lines: string[] = [];
    const m = new Metrics();
    const obs = createMcpObserver(m, (l) => lines.push(l));
    obs.toolCall(event());
    obs.toolCall(event({ status: "denied", reason: "scope_missing", duration_ms: 5 }));
    obs.toolCall(event({ tool: "deployment_restart", status: "approval_required" }));
    obs.approval({ approval_id: "ap-1", status: "requested", tool: "deployment_restart", target_cluster: "prd", requester: "kc-alice", approver: null });
    obs.approval({ approval_id: "ap-1", status: "executed", tool: "deployment_restart", target_cluster: "prd", requester: "kc-alice", approver: "kc-bob" });

    assert.equal(lines.length, 5);
    const first = JSON.parse(lines[0]);
    assert.equal(first.event, "tool_call");
    assert.equal(first.source, "founderos");
    assert.equal(first.trace_id, RUN.replace(/-/g, ""));
    assert.equal(first.session_id, RUN);
    assert.equal(first.user_sub, "kc-alice");
    assert.equal(JSON.parse(lines[4]).approver, "kc-bob");

    const text = m.render();
    assert.match(text, /ai_tool_calls_total\{cluster="prd",status="ok",tool="pods_list"\} 1/);
    assert.match(text, /ai_tool_calls_total\{cluster="prd",status="denied",tool="pods_list"\} 1/);
    assert.match(text, /ai_tool_denied_total\{reason="scope_missing",tool="pods_list"\} 1/);
    assert.match(text, /ai_approval_requests_total\{status="requested"\} 1/);
    assert.match(text, /ai_approval_requests_total\{status="executed"\} 1/);
    assert.match(text, /ai_tool_duration_seconds_count\{tool="pods_list"\} 2/);
    assert.match(text, /ai_tool_duration_seconds_bucket\{le="0.05",tool="pods_list"\} 1/);
  });

  it("le backend l'installe : les fonctions le trouvent sans rien configurer", () => {
    assert.equal(typeof (globalThis as { __mcpObserver?: unknown }).__mcpObserver, "object");
    // Un observateur qui lève ne doit jamais faire échouer l'appel.
    const saved = (globalThis as { __mcpObserver?: unknown }).__mcpObserver;
    (globalThis as { __mcpObserver?: unknown }).__mcpObserver = { toolCall: () => { throw new Error("panne"); } };
    assert.doesNotThrow(() => reportToolCall(event() as never));
    (globalThis as { __mcpObserver?: unknown }).__mcpObserver = saved;
  });
});

describe("issue d'un appel, identité, trace", () => {
  it("l'issue se lit dans le texte rendu par le client MCP", () => {
    assert.deepEqual(classifyMcpResult("[données non fiables] …"), { status: "ok", reason: null });
    assert.deepEqual(classifyMcpResult(`ERROR: ${JSON.stringify({ error: "denied", reason: "scope_missing" })}`), { status: "denied", reason: "scope_missing" });
    assert.deepEqual(classifyMcpResult(`ERROR: ${JSON.stringify({ error: "approval_required", params_hash: "a" })}`), { status: "approval_required", reason: null });
    assert.deepEqual(classifyMcpResult(`ERROR: ${JSON.stringify({ error: "invalid_params", message: "x" })}`), { status: "invalid", reason: "invalid_params" });
    assert.equal(classifyMcpResult("ERROR: MCP initialize failed — ECONNREFUSED").status, "error");
  });

  it("le demandeur et l'agent viennent du jeton d'appel", () => {
    const token = `${b64url({ alg: "RS256" })}.${b64url({ sub: "kc-alice", azp: "agent-ops-change" })}.sig`;
    assert.deepEqual(callIdentity({ Authorization: `Bearer ${token}` }), { user_sub: "kc-alice", agent_client: "agent-ops-change" });
    assert.deepEqual(callIdentity({ "X-Api-Key": "k" }), { user_sub: null, agent_client: null });
  });

  it("le trace_id de l'audit est celui du traceparent envoyé au serveur MCP", () => {
    const sent = traceparentFor(RUN);
    assert.equal(sent.split("-")[1], traceIdFor(RUN));
    // Deux appels du même run : même trace, spans différents.
    const again = traceparentFor(RUN);
    assert.equal(again.split("-")[1], traceIdFor(RUN));
    assert.notEqual(again.split("-")[2], sent.split("-")[2]);
  });
});

describe("port de gestion", () => {
  it("sert /metrics et /healthz, rien d'autre", async () => {
    const m = new Metrics();
    createMcpObserver(m, () => {}).toolCall(event() as never);
    const server = createMgmtServer(m);
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      assert.match(await res.text(), /ai_tool_calls_total/);
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.equal((await fetch(`${base}/functions/v1/rag-chat`)).status, 404);
    } finally {
      server.close();
    }
  });
});
