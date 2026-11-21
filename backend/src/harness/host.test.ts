// Phase 0 du harnais OpenCode (docs/harness-opencode) : l'hôte embarqué fait
// un vrai tour d'agent contre une fausse passerelle compatible OpenAI — le
// modèle appelle un outil FounderOS déclaré par plugin, puis répond.

import "../test-env.ts";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { createHarness, safeSegment, type Harness } from "./host.ts";

// ── Fausse passerelle : chaque requête de chat consomme la réponse suivante ──
type Turn = { text?: string; tools?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
let script: Turn[] = [];
const requests: Array<Record<string, any>> = [];

const sse = (res: import("node:http").ServerResponse, chunks: unknown[]) => {
  res.setHeader("Content-Type", "text/event-stream");
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

const gateway: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    // Les requêtes annexes (titre de la session) ne portent pas d’outils :
    // elles reçoivent un titre, sans consommer le script du tour d’agent.
    const annex = !Array.isArray(body.tools) || body.tools.length === 0;
    if (!annex) requests.push(body);
    const turn = annex ? { text: "Titre" } : script.shift() ?? { text: "fin" };
    const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: body.model };
    const chunks: unknown[] = [];
    if (turn.text) chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }] });
    (turn.tools ?? []).forEach((t, index) => {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] }, finish_reason: null }],
      });
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.tools?.length ? "tool_calls" : "stop" }] });
    chunks.push({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    if (body.stream) return sse(res, chunks);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ...base, object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: turn.text ?? null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }));
  });
});

let baseUrl = "";
let dataDir = "";
let host: Harness;
const lookups: string[] = [];
const sent: string[] = [];

const founderos = Plugin.define({
  id: "founderos-test",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      // Un outil à effet : il demande la permission avant d'agir. Selon les
      // règles de la session, OpenCode laisse passer, refuse, ou pose la
      // question (« ask ») et attend la réponse (permission.reply).
      tools.add({
        name: "founderos_send_email",
        options: { codemode: false },
        description: "Send an email to a client.",
        input: Schema.Struct({ to: Schema.String, body: Schema.String }),
        execute: async ({ to }, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "founderos.send_email",
            resources: [to],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          });
          sent.push(to);
          return { content: `E-mail envoyé à ${to}` };
        },
      });
      tools.add({
        name: "founderos_lookup_client",
        // Appel direct par le modèle (par défaut : seulement via Code Mode).
        options: { codemode: false },
        description: "Look up a FounderOS client record by name and return its account manager.",
        input: Schema.Struct({ name: Schema.String }),
        execute: async ({ name }) => {
          lookups.push(name);
          return { content: `Client ${name} : responsable de compte = Léa Martin` };
        },
      });
    });
  },
});

/** Attend la fin de l'exécution d'une session (idle, réussite ou échec). */
async function settle(h: Harness, sessionID: string, timeoutMs = 20_000): Promise<string[]> {
  const seen: string[] = [];
  const done = (async () => {
    for await (const ev of h.opencode.events.subscribe()) {
      const sid = (ev as { properties?: { sessionID?: string } }).properties?.sessionID
        ?? (ev as { data?: { sessionID?: string } }).data?.sessionID;
      if (sid && sid !== sessionID) continue;
      seen.push(ev.type);
      if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed") return;
    }
  })();
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
  return seen;
}

before(async () => {
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "founderos-harness-"));
  host = await createHarness({
    dataDir,
    plugins: [founderos],
    config: {
      model: "fake/test-model",
      providers: {
        fake: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: baseUrl, apiKey: "test" },
          models: { "test-model": {} },
        },
      },
    },
  });
});

after(async () => {
  await host?.close();
  gateway.closeAllConnections?.();
  gateway.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("harnais OpenCode embarqué (phase 0)", () => {
  it("un dossier d'agent ne sort jamais de agents/", async () => {
    assert.equal(safeSegment("../../etc"), "etc");
    const dir = await host.agentDir("agent-123");
    assert.ok(dir.startsWith(path.join(host.dataDir, "agents")));
  });

  it("le modèle appelle un outil FounderOS, reçoit son résultat, puis répond", async () => {
    script = [
      { tools: [{ id: "call_1", name: "founderos_lookup_client", args: { name: "Acme" } }] },
      { text: "Le responsable de compte d'Acme est Léa Martin." },
    ];
    const directory = await host.agentDir("agent-test");
    const session = await host.opencode.sessions.create({
      location: { directory },
      model: { id: "test-model", providerID: "fake" },
      metadata: { agent_id: "agent-test", workspace_id: "ws-test" },
    });
    const waiting = settle(host, session.id);
    await host.opencode.sessions.prompt({ sessionID: session.id, text: "Qui gère le client Acme ?" });
    const events = await waiting;

    assert.deepEqual(lookups, ["Acme"]);
    assert.ok(events.includes("session.execution.succeeded"), `événements : ${events.join(", ")}`);
    // Le deuxième appel au modèle porte le résultat de l'outil.
    assert.equal(requests.length >= 2, true);
    const toolMessage = (requests[1].messages as Array<{ role: string; content: unknown }>).find((m) => m.role === "tool");
    assert.match(JSON.stringify(toolMessage?.content), /Léa Martin/);
    // L'outil FounderOS figure dans les schémas envoyés au modèle.
    assert.ok((requests[0].tools as Array<{ function: { name: string } }>).some((t) => t.function.name === "founderos_lookup_client"));
  });

  it("une action sous approbation est refusée avec une consigne : l'outil ne part pas, le modèle reçoit la consigne", async () => {
    requests.length = 0;
    script = [
      { tools: [{ id: "call_2", name: "founderos_send_email", args: { to: "client@acme.fr", body: "Devis" } }] },
      { text: "Compris, je mets Paul en copie." },
    ];
    const directory = await host.agentDir("agent-test");
    const session = await host.opencode.sessions.create({
      location: { directory },
      model: { id: "test-model", providerID: "fake" },
      // La règle de l'agent : un envoi d'e-mail demande l'approbation.
      permissions: [{ action: "founderos.send_email", resource: "*", effect: "ask" }],
    });
    const asked: string[] = [];
    const approver = (async () => {
      for await (const ev of host.opencode.events.subscribe()) {
        if (ev.type !== "permission.asked") continue;
        const req = (ev as { data: { id: string; sessionID: string; action: string } }).data;
        if (req.sessionID !== session.id) continue;
        asked.push(req.action);
        await host.opencode.permission.reply({
          sessionID: session.id, requestID: req.id, decision: "reject",
          message: "Mets Paul en copie avant d'envoyer.",
        });
        return;
      }
    })();
    const waiting = settle(host, session.id);
    await host.opencode.sessions.prompt({ sessionID: session.id, text: "Envoie le devis à Acme." });
    await waiting;
    await Promise.race([approver, new Promise((r) => setTimeout(r, 1000))]);

    assert.deepEqual(asked, ["founderos.send_email"]);
    assert.deepEqual(sent, []);
    const toolMessage = (requests[1]?.messages as Array<{ role: string; content: unknown }> | undefined)?.find((m) => m.role === "tool");
    assert.match(JSON.stringify(toolMessage?.content), /Mets Paul en copie/);
  });

  it("un arrêt du backend pendant un outil : au redémarrage, la session reprend seule", async () => {
    requests.length = 0;
    const dir = await mkdtemp(path.join(os.tmpdir(), "founderos-harness-restart-"));
    const config = {
      model: "fake/test-model",
      providers: { fake: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: baseUrl, apiKey: "test" }, models: { "test-model": {} } } },
    };
    // Premier processus : l'outil ne rend jamais la main (le backend s'arrête pendant).
    let started!: () => void;
    const toolStarted = new Promise<void>((r) => { started = r; });
    const slow = Plugin.define({
      id: "founderos-slow",
      setup: async (ctx) => {
        await ctx.tool.transform((tools) => {
          tools.add({
            name: "founderos_long_job",
            options: { codemode: false },
            description: "Run a long FounderOS job.",
            input: Schema.Struct({ job: Schema.String }),
            execute: async () => { started(); return await new Promise<{ content: string }>(() => {}); },
          });
        });
      },
    });
    script = [
      { tools: [{ id: "call_3", name: "founderos_long_job", args: { job: "import" } }] },
      { text: "Le travail a été interrompu ; je vérifie son état avant de le relancer." },
    ];
    const first = await createHarness({ dataDir: dir, plugins: [slow], config });
    const directory = await first.agentDir("agent-restart");
    const session = await first.opencode.sessions.create({ location: { directory }, model: { id: "test-model", providerID: "fake" } });
    await first.opencode.sessions.prompt({ sessionID: session.id, text: "Lance l'import." });
    await toolStarted;
    await first.close();

    // Second processus, même dossier de données : la session revendiquée reprend.
    const second = await createHarness({ dataDir: dir, plugins: [], config });
    try {
      const deadline = Date.now() + 20_000;
      while (requests.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.equal(requests.length >= 2, true, "la session n'a pas repris");
      // Le modèle apprend que l'appel a été interrompu : il ne le rejoue pas à l'aveugle.
      const toolMessage = (requests[1].messages as Array<{ role: string; content: unknown }>).find((m) => m.role === "tool");
      assert.match(JSON.stringify(toolMessage?.content), /interrupt/i);
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
