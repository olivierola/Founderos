// Le mode isolé : le magasin tenu dans un journal (et rejoué au redémarrage),
// et l'entrée locale protégée par son jeton.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { localStore, parseJournal } from "./local-store.ts";
import { startLocalServer } from "./local-server.ts";

const agent = { id: "agent-1", name: "Agent ERP", workspace_id: "ws", project_id: "pj", harness: "opencode" as const };

describe("mode isolé : le magasin local", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "fos-isolated-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("tient conversations, runs, messages et questions, et les retrouve au redémarrage", async () => {
    const file = path.join(dir, "j.jsonl");
    const local = await localStore({ agent, file, instanceName: "lyon-1" });
    const conv = await local.createConversation("Retards");
    await local.addUserMessage(conv, "Quelles commandes sont en retard ?");
    assert.deepEqual(await local.store.conversation(conv, agent.id), { sessionId: null });
    await local.store.setConversationSession(conv, "ses_1");
    const runId = await local.store.createRun({ agent, conversationId: conv, sessionId: "ses_1", via: "chat" });
    assert.deepEqual(await local.store.activeRun(conv), { runId, sessionId: "ses_1" });
    await local.store.updateRun(runId, { live_output: "je cherche…", tokens_in: 12 });
    await local.store.insertEvent(runId, agent.id, "tool_call", { tool: "grep" });
    await local.question({ runId, sessionId: "ses_1", agentId: agent.id, workspaceId: "ws", projectId: "pj", conversationId: conv }, {
      formId: "f1", sessionId: "ses_1", title: "Quel entrepôt ?", fields: [{ key: "q", options: ["Lyon", "Lille"] }],
    });
    const pending = await local.store.pendingQuestion!(conv);
    assert.equal(pending?.formId, "f1");
    await local.store.updateRun(runId, { status: "succeeded", final_output: "Trois commandes." });
    await local.store.insertAssistantMessage({ conversationId: conv, agentId: agent.id, runId, content: "Trois commandes.", tokensIn: 1, tokensOut: 1, costUsd: 0 });

    const records = parseJournal(await local.journal());
    assert.equal(records[0].t, "instance");
    assert.ok(!records.some((r) => r.t === "run_patch" && "live_output" in r.patch), "le texte en direct ne va pas au journal");

    const again = await localStore({ agent, file, instanceName: "lyon-1" });
    assert.deepEqual(await again.store.conversation(conv, agent.id), { sessionId: "ses_1" });
    assert.equal(again.state.runs.get(runId)?.status, "succeeded");
    assert.deepEqual((await again.store.recentMessages(conv, 10)).map((m) => m.role), ["user", "assistant", "assistant"]);
    assert.equal(parseJournal(await again.journal()).filter((r) => r.t === "instance").length, 1);
  });
});

describe("mode isolé : l'entrée locale", () => {
  let dir: string;
  let base: string;
  let close: () => void;
  const turns: string[] = [];
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "fos-isolated-srv-"));
    const local = await localStore({ agent, file: path.join(dir, "j.jsonl"), instanceName: "t" });
    const server = startLocalServer({ agentName: "Agent ERP", token: "secret-token", local, turn: async (c) => { turns.push(c); return { run_id: "r1" }; } }, 0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(async () => { close(); await rm(dir, { recursive: true, force: true }); });

  const call = (p: string, init: RequestInit = {}, token = "secret-token") =>
    fetch(`${base}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

  it("la page s'ouvre sans jeton et n'en contient pas ; l'API le demande", async () => {
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /Agent ERP/);
    assert.doesNotMatch(page, /secret-token/);
    assert.equal((await call("/api/conversations", {}, "faux")).status, 401);
    assert.equal((await fetch(`${base}/api/conversations`)).status, 401);
  });

  it("une conversation, un message, un tour de l'agent, le journal", async () => {
    const { id } = await (await call("/api/conversations", { method: "POST", body: JSON.stringify({ title: "Stocks" }) })).json() as { id: string };
    const sent = await call(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: "Bonjour" }) });
    assert.equal(sent.status, 200);
    assert.deepEqual(turns, [id]);
    const msgs = await (await call(`/api/conversations/${id}/messages`)).json() as { messages: Array<{ content: string }> };
    assert.deepEqual(msgs.messages.map((m) => m.content), ["Bonjour"]);
    assert.equal((await call(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: " " }) })).status, 400);
    const journal = await (await call("/api/journal")).text();
    assert.ok(parseJournal(journal).some((r) => r.t === "message"));
  });
});
