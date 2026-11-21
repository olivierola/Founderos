// Phase 2 du harnais OpenCode : chaque agent FounderOS a son instance, son
// prompt système, ses paliers de modèles et ses permissions.

import "../test-env.ts";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { modelForRoute, profileModels, type AgentProfile } from "./agent-profile.ts";
import { agentPlugin, newAgentState } from "./agent-plugin.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { startChatTurn, type AgentSupport } from "./chat.ts";
import { createHarness, type Harness } from "./host.ts";
import type { HarnessAgent } from "./store.ts";
import { memoryStore, startFakeLlm, type FakeLlm } from "./testing.ts";

const AGENT: HarnessAgent = { id: "agent-ops", name: "Ops Sentinel", workspace_id: "ws", project_id: "pj", harness: "opencode" };
const SYSTEM = "Tu es Ops Sentinel, agent FounderOS. Réponds en français.";

const profileFor = (baseURL: string): AgentProfile => ({
  agent: { id: AGENT.id, name: AGENT.name, workspace_id: "ws", project_id: "pj" } as AgentProfile["agent"],
  system: SYSTEM,
  steps: 90,
  connection: { baseURL, apiKey: "k", headers: {}, openrouter: true, source: "platform" },
  routes: {
    light: "m-light",
    standard: "m-std,m-std-backup",
    heavy: "anthropic/claude-opus-5.5,m-heavy-backup",
  },
});

describe("profil d'agent : routes et modèles", () => {
  const p = profileFor("http://x/v1");
  it("un modèle par route, avec ses replis (OpenRouter)", () => {
    assert.deepEqual(profileModels(p), [
      { id: "m-light", fallbacks: ["m-light"] },
      { id: "m-std", fallbacks: ["m-std", "m-std-backup"] },
      { id: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-opus-5.5", "m-heavy-backup"] },
    ]);
  });
  it("le palier et le critère choisissent la route ; sans route, le moyen", () => {
    assert.equal(modelForRoute(p, "heavy"), "anthropic/claude-opus-5.5");
    assert.equal(modelForRoute(p, "light"), "m-light");
    assert.equal(modelForRoute(p, "standard", "code"), "m-std");
  });
});

describe("agents FounderOS dans OpenCode", () => {
  let llm: FakeLlm;
  let dir: string;
  let host: Harness;
  let bridge: Bridge;
  let mem: ReturnType<typeof memoryStore>;
  let agents: AgentSupport;

  before(async () => {
    llm = await startFakeLlm();
    dir = await mkdtemp(path.join(os.tmpdir(), "founderos-agents-"));
    const state = newAgentState();
    const load = async () => profileFor(llm.baseUrl);
    agents = {
      state, load,
      // Le choix du palier est testé à part (classifyRequest, AgentPilot) :
      // ici, « analyse » vaut le palier lourd, le composer l'emporte.
      choose: async (p, text, opts) => (opts.composer
        ? { model: opts.composer, tier: "standard", need: null }
        : /analyse/i.test(text)
        ? { model: modelForRoute(p, "heavy"), tier: "heavy", need: null }
        : { model: modelForRoute(p, "standard"), tier: "standard", need: null }),
    };
    host = await createHarness({
      dataDir: dir,
      instances: {
        key: (session: { metadata?: unknown }) => String((session.metadata as { agent_id?: string } | undefined)?.agent_id ?? "default"),
        configure: (key: string) => ({ plugins: key === "default" ? [] : [agentPlugin(key, load, state)] }),
      },
    });
    mem = memoryStore({
      agents: [AGENT],
      conversations: [{ id: "conv", agentId: AGENT.id }],
      messages: [{ conversationId: "conv", role: "user", content: "Bonjour, où en est l'incident ?" }],
    });
    bridge = startBridge(host.opencode, mem.store, { liveIntervalMs: 10, cancelPollMs: 100 });
  });
  after(async () => {
    await bridge?.stop();
    await host?.close();
    await llm?.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  beforeEach(() => { llm.requests.length = 0; llm.annex.length = 0; });

  const turn = async (text: string | null, composer?: string) => {
    if (text) mem.messages.push({ conversationId: "conv", role: "user", content: text });
    const out = await startChatTurn({ harness: host, store: mem.store, bridge, agents }, { agent: AGENT, conversationId: "conv", model: composer ?? null });
    await bridge.settled(mem.conversations[0].sessionId!);
    return out;
  };

  it("le prompt FounderOS remplace celui d'OpenCode ; le travail part sur le palier moyen, le titre sur le léger", async () => {
    llm.script = [{ text: "Aucun incident ouvert." }];
    const out = await turn(null);
    const req = llm.requests[0];
    assert.equal(req.model, "m-std");
    // Les replis OpenRouter de la route.
    assert.deepEqual(req.models, ["m-std", "m-std-backup"]);
    const system = (req.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === "system").map((m) => JSON.stringify(m.content)).join("\n");
    assert.match(system, /Tu es Ops Sentinel, agent FounderOS/);
    assert.doesNotMatch(system, /running in OpenCode, a coding agent harness/);
    // Le titre de la session : le palier léger.
    assert.ok(llm.annex.some((a) => a.model === "m-light"), `annexes : ${llm.annex.map((a) => a.model).join(", ")}`);
    // La timeline dit quel modèle a servi.
    const status = mem.events.find((e) => e.runId === out.run_id && e.kind === "status");
    assert.match(String(status?.payload.message), /modèle m-std · palier standard/);
  });

  it("une demande d'analyse part sur le palier lourd (Claude Opus), replis compris", async () => {
    llm.script = [{ text: "Analyse faite." }];
    await turn("Fais l'analyse des causes de la panne.");
    assert.equal(llm.requests[0].model, "anthropic/claude-opus-5.5");
    assert.deepEqual(llm.requests[0].models, ["anthropic/claude-opus-5.5", "m-heavy-backup"]);
  });

  it("un modèle choisi dans le composer, hors des routes, est déclaré puis utilisé", async () => {
    llm.script = [{ text: "OK." }];
    await turn("Réponds simplement.", "mistralai/mistral-large");
    assert.equal(llm.requests[0].model, "mistralai/mistral-large");
  });

  it("le shell est refusé à l'agent : il ne touche pas la machine qui héberge le backend", async () => {
    llm.script = [
      { tools: [{ id: "s1", name: "shell", args: { command: "whoami", description: "x" } }] },
      { text: "Je n'ai pas accès au shell." },
    ];
    const out = await turn("Lance whoami.");
    const offered = (llm.requests[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    const result = mem.events.find((e) => e.runId === out.run_id && e.kind === "tool_result");
    // Refusé : soit l'outil n'est pas proposé, soit l'appel échoue sans s'exécuter.
    assert.ok(!offered.includes("shell") || (result && result.payload.ok === false), `outils : ${offered.join(", ")}`);
  });
});
