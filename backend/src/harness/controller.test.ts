// Le contrôleur de boucle et la mémoire des recherches, sans base : un faux
// client qui accepte tout et ne rend rien.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrailEntry } from "./bridge.ts";
import { createController } from "./controller.ts";
import { beforeTool, querySig, researchFor } from "./research.ts";
import type { BoundRun } from "./store.ts";

function fakeAdmin(): SupabaseClient {
  const chain: Record<string, unknown> = {};
  for (const m of ["insert", "select", "eq", "in", "order", "limit", "update", "not", "is", "gt", "lt"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: null, error: null });
  chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, ko);
  return { from: () => chain, rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient;
}

const RUN = (kind: BoundRun["kind"] = "chat"): BoundRun => ({
  runId: `run-${Math.random()}`, sessionId: "ses-1", agentId: "agent-1", workspaceId: "ws", projectId: "pj",
  conversationId: kind === "chat" ? "conv" : null, kind, meta: { task: "Trouver les tarifs" },
});

const call = (name: string, args: Record<string, unknown>, ok = true, result = "ok"): TrailEntry => ({ name, args, ok, result });

describe("contrôleur de boucle", () => {
  it("le même appel en échec répété : consigne de replanification, modèle lourd pour la suite", async () => {
    const steered: string[] = [];
    let escalated = 0;
    const c = createController({
      admin: fakeAdmin, steer: async (_s, t) => { steered.push(t); }, interrupt: async () => {},
      escalate: async () => { escalated++; return "heavy-model"; },
    });
    const run = RUN();
    const trail = Array.from({ length: 4 }, () => call("machine", { action: "shell", command: "make" }, false, "ERROR: exit 2"));
    await c.afterStep(run, { trail, steps: 4, costUsd: 0.01 });
    assert.equal(steered.length, 1);
    assert.match(steered[0], /LOOPING|ÉCHEC RÉPÉTÉ/);
    assert.match(steered[0], /todowrite/, "les consignes parlent des outils du harnais");
    assert.doesNotMatch(steered[0], /update_todos/);
    assert.equal(escalated, 1);
    assert.equal(c.abortReason(run.runId), null);
  });

  it("au budget d'étapes : une seule consigne de finir avec l'acquis", async () => {
    const steered: string[] = [];
    const c = createController({ admin: fakeAdmin, steer: async (_s, t) => { steered.push(t); }, interrupt: async () => {}, escalate: async () => null });
    const run = RUN("mission");
    const trail = [call("web", { action: "search", query: "a" })];
    await c.afterStep(run, { trail, steps: 300, costUsd: 0 });
    await c.afterStep(run, { trail, steps: 301, costUsd: 0 });
    assert.equal(steered.length, 1);
    assert.match(steered[0], /STOP : Budget d'étapes atteint/);
  });

  it("un run qui s'emballe bien au-delà du budget est arrêté, avec sa raison", async () => {
    let interrupted = 0;
    const c = createController({ admin: fakeAdmin, steer: async () => {}, interrupt: async () => { interrupted++; }, escalate: async () => null });
    const run = RUN("mission");
    await c.afterStep(run, { trail: [], steps: 1000, costUsd: 0 });
    assert.equal(interrupted, 1);
    assert.match(String(c.abortReason(run.runId)), /Budget très largement dépassé/);
    c.forget(run.runId);
    assert.equal(c.abortReason(run.runId), null);
  });

  it("sans personne pour répondre, la question devient un compte rendu", async () => {
    const steered: string[] = [];
    const c = createController({ admin: fakeAdmin, steer: async (_s, t) => { steered.push(t); }, interrupt: async () => {}, escalate: async () => null });
    const run = RUN("mission");
    // Des refus de garde-fou en série : la consigne pointe vers l'humain.
    const trail = Array.from({ length: 3 }, (_, i) => call("apps", { action: "call", app: `x${i}` }, false, "ERROR: Action bloquée par le guardrail « PII »"));
    await c.afterStep(run, { trail, steps: 3, costUsd: 0 });
    assert.ok(steered.some((t) => /REFUS EN SÉRIE/.test(t)));
    assert.ok(!steered.some((t) => /ask_user|question/.test(t)), steered.join("\n"));
  });
});

describe("mémoire des recherches", () => {
  it("une requête reformulée dans un autre ordre est la même recherche", () => {
    assert.equal(querySig("web_search", { query: "Tarifs Acme 2026" }), querySig("web_search", { query: "2026 acme tarifs" }));
    assert.equal(querySig("read_url", { url: "https://x" }), null);
  });

  it("la même recherche deux fois dans un run : la seconde est refusée sans appel", async () => {
    const s = researchFor({ runId: "r-research", agentId: "a", projectId: null, workspaceId: "ws" }, fakeAdmin());
    assert.equal(await beforeTool(s, "search_knowledge", { query: "délais de livraison" }), null);
    assert.match(String(await beforeTool(s, "search_knowledge", { query: "livraison délais" })), /déjà effectuée/);
  });
});
