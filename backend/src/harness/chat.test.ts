// Phase 1 du harnais OpenCode : un tour de chat de bout en bout, projeté dans
// les tables que lit le front (run, timeline, message de l'agent, coûts), et
// l'aiguillage d'internal-agent-run selon le moteur de l'agent.

import "../test-env.ts";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { startBridge, type Bridge } from "./bridge.ts";
import { parseModelRef, seedText, startChatTurn } from "./chat.ts";
import { createHarness, type Harness } from "./host.ts";
import { harnessRouter } from "./route.ts";
import type { HarnessRuntime } from "./runtime.ts";
import type { HarnessAgent } from "./store.ts";
import { fakeProviderConfig, memoryStore, startFakeLlm, type FakeLlm } from "./testing.ts";

const AGENT: HarnessAgent = { id: "agent-1", name: "Ops", workspace_id: "ws", project_id: "pj", harness: "opencode" };
const LEGACY: HarnessAgent = { ...AGENT, id: "agent-legacy", harness: "legacy" };

let llm: FakeLlm;
let dir: string;
let host: Harness;
let gate: (() => void) | null = null;
const bridges: Bridge[] = [];

const tools = Plugin.define({
  id: "founderos-chat-test",
  setup: async (ctx) => {
    await ctx.tool.transform((t) => {
      t.add({
        name: "founderos_lookup_client",
        options: { codemode: false },
        description: "Look up a FounderOS client record.",
        input: Schema.Struct({ name: Schema.String }),
        execute: async ({ name }) => ({ content: `Client ${name} : responsable = Léa Martin` }),
      });
      // Un outil qui attend un feu vert du test : de quoi garder un tour en cours.
      t.add({
        name: "founderos_wait",
        options: { codemode: false },
        description: "Wait for an external signal.",
        input: Schema.Struct({ reason: Schema.String }),
        execute: async () => {
          await new Promise<void>((r) => { gate = r; });
          return { content: "signal reçu" };
        },
      });
    });
  },
});

before(async () => {
  llm = await startFakeLlm();
  dir = await mkdtemp(path.join(os.tmpdir(), "founderos-chat-"));
  host = await createHarness({ dataDir: dir, plugins: [tools], config: fakeProviderConfig(llm.baseUrl) });
});
after(async () => {
  for (const b of bridges) await b.stop();
  await host?.close();
  await llm?.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});
beforeEach(() => { llm.requests.length = 0; llm.script = []; gate = null; });

const fixture = (convId: string, messages: Array<{ role: string; content: string }>) => {
  const mem = memoryStore({
    agents: [AGENT, LEGACY],
    conversations: [{ id: convId, agentId: AGENT.id }, { id: `${convId}-legacy`, agentId: LEGACY.id }],
    messages: messages.map((m) => ({ conversationId: convId, ...m })),
    access: [{ agentId: AGENT.id, userId: "user-ok" }],
  });
  const bridge = startBridge(host.opencode, mem.store, { liveIntervalMs: 10, cancelPollMs: 100 });
  bridges.push(bridge);
  return { mem, bridge, deps: { harness: host, store: mem.store, bridge } };
};

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.ok(cond(), "condition jamais remplie");
};

describe("utilitaires du tour de chat", () => {
  it("un modèle « fournisseur/modèle » devient une référence ; un alias, non", () => {
    assert.deepEqual(parseModelRef("openrouter/anthropic/claude-opus-5.5"), { providerID: "openrouter", id: "anthropic/claude-opus-5.5" });
    assert.equal(parseModelRef("@heavy"), null);
    assert.equal(parseModelRef("gpt-5"), null);
  });

  it("l'historique d'avant amorce une nouvelle session, sans le système", () => {
    const out = seedText([{ role: "user", content: "Bonjour" }, { role: "assistant", content: "Salut" }, { role: "system", content: "secret" }], "Et Acme ?");
    assert.match(out, /Utilisateur : Bonjour\nToi : Salut/);
    assert.doesNotMatch(out, /secret/);
    assert.match(out, /\[Nouveau message\]\nEt Acme \?$/);
    assert.equal(seedText([], "Seul"), "Seul");
  });
});

describe("un tour de chat sur OpenCode, projeté pour le front", () => {
  let bridge: Bridge | null = null;

  it("run, timeline, message de l'agent, coûts et session de la conversation", async () => {
    const f = fixture("conv-1", [
      { role: "user", content: "On parlait d'Acme hier." },
      { role: "assistant", content: "Oui, le devis est prêt." },
      { role: "user", content: "Qui gère Acme ?" },
    ]);
    bridge = f.bridge;
    llm.script = [
      { tools: [{ id: "c1", name: "founderos_lookup_client", args: { name: "Acme" } }] },
      { text: "Léa Martin gère Acme." },
    ];
    const out = await startChatTurn(f.deps, { agent: AGENT, conversationId: "conv-1" });
    assert.equal(out.queued, true);
    const sessionId = f.mem.conversations.find((c) => c.id === "conv-1")!.sessionId!;
    await f.bridge.settled(sessionId);

    const run = f.mem.runs.find((r) => r.id === out.run_id)!;
    assert.equal(run.status, "succeeded");
    assert.equal(run.final_output, "Léa Martin gère Acme.");
    assert.equal(run.live_output, null);
    // La timeline, au format de RunTimeline : l'appel puis son résultat, avec le nom de l'outil.
    const timeline = f.mem.events.filter((e) => e.runId === out.run_id).map((e) => `${e.kind}:${e.payload.tool ?? ""}`);
    assert.deepEqual(timeline, ["tool_call:founderos_lookup_client", "tool_result:founderos_lookup_client"]);
    assert.match(String(f.mem.events[1].payload.preview), /Léa Martin/);
    // Le message de l'agent arrive dans la conversation.
    assert.equal(f.mem.messages.at(-1)?.role, "assistant");
    assert.equal(f.mem.messages.at(-1)?.content, "Léa Martin gère Acme.");
    // La consommation : deux étapes comptées.
    assert.ok(f.mem.usage.filter((u) => u.source === "step").length >= 2);
    assert.equal(run.tokens_in, f.mem.usage.reduce((n, u) => n + u.promptTokens, 0));
    // La nouvelle session a reçu l'historique d'avant.
    const firstUser = (llm.requests[0].messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === "user").at(-1);
    assert.match(JSON.stringify(firstUser?.content), /On parlait d'Acme hier/);
  });

  it("un message envoyé pendant le tour le pilote, sans second run", async () => {
    const f = fixture("conv-2", [{ role: "user", content: "Lance la vérification." }]);
    bridge = f.bridge;
    llm.script = [
      { tools: [{ id: "w1", name: "founderos_wait", args: { reason: "attente" } }] },
      { text: "Vérification faite, en ajoutant Paul." },
    ];
    const first = await startChatTurn(f.deps, { agent: AGENT, conversationId: "conv-2" });
    await until(() => gate !== null);
    f.mem.messages.push({ conversationId: "conv-2", role: "user", content: "Ajoute Paul en copie." });
    const second = await startChatTurn(f.deps, { agent: AGENT, conversationId: "conv-2" });
    assert.equal(second.injected, true);
    assert.equal(second.run_id, first.run_id);
    gate!();
    const sessionId = f.mem.conversations.find((c) => c.id === "conv-2")!.sessionId!;
    await f.bridge.settled(sessionId);
    assert.equal(f.mem.runs.length, 1);
    // Le message ajouté en cours de route est dans la requête suivante.
    assert.match(JSON.stringify(llm.requests.at(-1)?.messages), /Ajoute Paul en copie/);
  });

  it("le fournisseur refuse : le run échoue avec la cause, l'agent le dit dans la conversation", async () => {
    const f = fixture("conv-3", [{ role: "user", content: "Bonjour" }]);
    bridge = f.bridge;
    llm.script = [{ status: 400, error: "model not found" }];
    const out = await startChatTurn(f.deps, { agent: AGENT, conversationId: "conv-3" });
    await f.bridge.settled(f.mem.conversations.find((c) => c.id === "conv-3")!.sessionId!);
    const run = f.mem.runs.find((r) => r.id === out.run_id)!;
    assert.equal(run.status, "failed");
    assert.match(String(run.error_message), /model not found/i);
    assert.match(String(f.mem.messages.at(-1)?.content), /^⚠️ Le run a échoué/);
  });

  it("annulé depuis le front : la session est interrompue, le run passe « cancelled »", async () => {
    const f = fixture("conv-4", [{ role: "user", content: "Attends." }]);
    bridge = f.bridge;
    llm.script = [{ tools: [{ id: "w2", name: "founderos_wait", args: { reason: "attente" } }] }];
    const out = await startChatTurn(f.deps, { agent: AGENT, conversationId: "conv-4" });
    await until(() => gate !== null);
    // Ce que fait le front : le statut du run en base.
    f.mem.runs.find((r) => r.id === out.run_id)!.status = "cancelled";
    await f.bridge.settled(f.mem.conversations.find((c) => c.id === "conv-4")!.sessionId!);
    assert.equal(f.mem.runs.find((r) => r.id === out.run_id)!.status, "cancelled");
  });
});

describe("internal-agent-run sur le harnais", () => {
  it("contrôles d'accès, conversation de l'agent, chat et mission confiés au lancement des runs", async () => {
    const f = fixture("conv-5", [{ role: "user", content: "Bonjour" }]);
    llm.script = [{ text: "Bonjour !" }];
    const started: Array<Record<string, unknown>> = [];
    const runtime: HarnessRuntime = {
      ...f.deps, serviceKey: "service-key",
      verifyUser: async (t) => (t === "user-ok-token" ? "user-ok" : t === "user-other-token" ? "user-other" : null),
      checkCredits: async () => {},
      // Le lancement réel (runs.ts) lit la base ; ici, un tour de chat direct.
      startRun: async (input) => {
        started.push(input as never);
        if (input.kind === "mission") return { ok: true, run_id: String(input.runId), queued: true };
        return startChatTurn(f.deps, { agent: AGENT, conversationId: String(input.conversationId) });
      },
    };
    const app = express();
    app.use("/functions/v1", harnessRouter(() => runtime));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/functions/v1/internal-agent-run`;
    const post = (token: string, body: Record<string, unknown>) => fetch(base, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      // Plus d'ancien moteur : l'ancienne file de ticks est sans effet, un mode inconnu est refusé.
      assert.deepEqual(((await (await post("service-key", { mode: "tick", run_id: "r" })).json()) as { skipped?: boolean }).skipped, true);
      assert.equal((await post("service-key", { agent_id: AGENT.id, mode: "inconnu" })).status, 400);
      const mission = await post("service-key", { agent_id: AGENT.id, mode: "mission", run_id: "r-42" });
      assert.deepEqual(await mission.json(), { ok: true, run_id: "r-42", queued: true });
      assert.equal(started.at(-1)?.kind, "mission");
      assert.equal((await post("bad", { agent_id: AGENT.id, mode: "chat", conversation_id: "conv-5" })).status, 401);
      assert.equal((await post("user-other-token", { agent_id: AGENT.id, mode: "chat", conversation_id: "conv-5" })).status, 403);
      assert.equal((await post("user-ok-token", { agent_id: AGENT.id, mode: "chat", conversation_id: "conv-x" })).status, 403);
      const ok = await post("user-ok-token", { agent_id: AGENT.id, mode: "chat", conversation_id: "conv-5" });
      assert.equal(ok.status, 200);
      const out = (await ok.json()) as { run_id?: string; queued?: boolean };
      assert.equal(out.queued, true);
      assert.equal(started.at(-1)?.actingUserId, "user-ok", "le tour est piloté par la personne qui a écrit");
      await f.bridge.settled(f.mem.conversations.find((c) => c.id === "conv-5")!.sessionId!);
      assert.equal(f.mem.messages.at(-1)?.content, "Bonjour !");
    } finally {
      server.close();
      await f.bridge.stop();
    }
  });
});
