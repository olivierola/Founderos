// Le cycle de vie des runs sur le harnais, sans base : la fin d'exécution
// confiée au cycle de vie (relance dans le même run), la liste de tâches de
// l'agent recopiée sur le run, les réponses aux questions, les anciens noms
// d'outils.

import "../test-env.ts";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { startBridge, todosFromTodowrite, type RunOutcome } from "./bridge.ts";
import { formAnswer, startTaskRun } from "./chat.ts";
import { createHarness, type Harness } from "./host.ts";
import type { BoundRun, HarnessAgent } from "./store.ts";
import { fakeProviderConfig, memoryStore, startFakeLlm, type FakeLlm } from "./testing.ts";
import { legacyAliases, legacyNameFor, type KitTool } from "./toolkit/catalogue.ts";

const AGENT: HarnessAgent = { id: "agent-1", name: "Ops", workspace_id: "ws", project_id: "pj", harness: "opencode" };

describe("traductions du harnais", () => {
  it("la liste de tâches d'OpenCode devient celle du run", () => {
    assert.deepEqual(todosFromTodowrite({
      todos: [
        { id: "a", content: "Lire le brief", status: "completed" },
        { content: "Écrire", status: "in_progress" },
        { content: "Relire", status: "pending" },
        { content: "Abandonné", status: "cancelled" },
      ],
    }), [
      { id: "a", title: "Lire le brief", status: "done" },
      { id: "step-2", title: "Écrire", status: "active" },
      { id: "step-3", title: "Relire", status: "pending" },
      { id: "step-4", title: "Abandonné", status: "blocked" },
    ]);
    assert.equal(todosFromTodowrite({ nope: 1 }), null);
  });

  it("la réponse d'une personne remplit le premier champ du formulaire, option reconnue si elle existe", () => {
    assert.deepEqual(formAnswer([{ key: "q", options: ["Oui", "Non"] }], " oui "), { q: "Oui" });
    assert.deepEqual(formAnswer([{ key: "q", options: ["Rouge", "Vert"], multiple: true }], "Bleu"), { q: ["Bleu"] });
    assert.deepEqual(formAnswer([{ key: "libre" }], "Mardi"), { libre: "Mardi" });
    assert.deepEqual(formAnswer([], "x"), {});
  });

  it("un appel d'outil regroupé retrouve le nom de l'ancien outil (preuves, contrat)", () => {
    assert.equal(legacyNameFor("document", { action: "deliver" }), "create_deliverable");
    assert.equal(legacyNameFor("team", { action: "delegate" }), "delegate_mission");
    assert.equal(legacyNameFor("remember", { kind: "preference" }), "remember_preference");
    assert.equal(legacyNameFor("apps", { action: "call", app: "composio_SLACK_SEND" }), "composio_SLACK_SEND");
    assert.equal(legacyNameFor("todowrite", {}), "update_todos");
    assert.equal(legacyNameFor("tracker", {}), "tracker");
  });

  it("les doctrines écrites avec les anciens noms ont leur traduction", () => {
    const tools = [{ name: "document" }, { name: "apps" }] as KitTool[];
    const lines = legacyAliases(tools);
    assert.ok(lines.includes('create_deliverable → document(action="deliver")'));
    assert.ok(lines.some((l) => l.startsWith("crm, send_email")));
    assert.ok(lines.includes("ask_user → question"));
    assert.ok(!lines.some((l) => l.startsWith("manage_agents")), "seulement les outils de cet agent");
  });
});

describe("fin d'exécution : le cycle de vie décide", () => {
  let llm: FakeLlm;
  let dir: string;
  let host: Harness;
  const tools = Plugin.define({
    id: "founderos-lifecycle-test",
    setup: async (ctx) => {
      await ctx.tool.transform((t) => {
        t.add({
          name: "founderos_lookup",
          options: { codemode: false },
          description: "Look up a record.",
          input: Schema.Struct({ name: Schema.String }),
          execute: async ({ name }) => ({ content: `fiche ${name}` }),
        });
      });
    },
  });

  before(async () => {
    llm = await startFakeLlm();
    dir = await mkdtemp(path.join(os.tmpdir(), "founderos-lifecycle-"));
    host = await createHarness({ dataDir: dir, plugins: [tools], config: fakeProviderConfig(llm.baseUrl) });
  });
  after(async () => {
    await host?.close();
    await llm?.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("une relance garde le même run ; le second résultat clôt le run, preuves cumulées", async () => {
    const mem = memoryStore({ agents: [AGENT], conversations: [] });
    const settles: Array<{ run: BoundRun; outcome: RunOutcome }> = [];
    const bridge = startBridge(host.opencode, mem.store, {
      liveIntervalMs: 10, cancelPollMs: 100,
      settle: async (run, outcome) => {
        settles.push({ run, outcome: { ...outcome, trail: [...outcome.trail] } });
        if (settles.length === 1) {
          await host.opencode.sessions.prompt({ sessionID: run.sessionId, text: "VÉRIFICATION ÉCHOUÉE : refais le contrôle." });
          return "continue";
        }
        await mem.store.updateRun(run.runId, { status: "succeeded", final_output: outcome.text });
        return "done";
      },
    });
    try {
      llm.script = [
        { tools: [{ id: "c1", name: "founderos_lookup", args: { name: "Acme" } }] },
        { text: "Fait (premier jet)." },
        { tools: [{ id: "c2", name: "founderos_lookup", args: { name: "Globex" } }] },
        { text: "Fait, vérifié." },
      ];
      const out = await startTaskRun({ harness: host, store: mem.store, bridge }, {
        agent: AGENT, kind: "mission", runId: "run-m1", text: "Vérifie Acme.", unattended: true,
        meta: { mission_id: "m1" },
      });
      assert.equal(out.run_id, "run-m1", "le run créé par l'appelant est repris");
      const run = mem.runs.find((r) => r.id === "run-m1")!;
      await bridge.settled(run.opencode_session_id);
      assert.equal(settles.length, 2);
      assert.equal(settles[0].outcome.text, "Fait (premier jet).");
      assert.equal(settles[1].outcome.text, "Fait, vérifié.");
      assert.deepEqual(settles[1].outcome.trail.map((t) => t.args.name), ["Acme", "Globex"]);
      assert.equal(settles[1].run.kind, "mission");
      assert.equal((settles[1].run.meta as { mission_id?: string }).mission_id, "m1");
      assert.equal(run.status, "succeeded");
      assert.equal(run.final_output, "Fait, vérifié.");
      assert.equal(mem.events.filter((e) => e.kind === "tool_call").length, 2);
    } finally {
      await bridge.stop();
    }
  });
});
