// Le harnais aligné sur OpenCode : réponse en flux, outils lancés dès leur
// arrivée, couloirs d'exécution, arrêt coopératif, réparation des arguments,
// mesure du contexte. Contre une fausse passerelle Azure qui répond en SSE.

import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { runToolRounds, toolDescVariant, type ChatMessage } from "../edge/_shared/ai.ts";
import { resetUpstreamCaches } from "../edge/_shared/llm-upstream.ts";
import { hasExternalEffect, isParallelSafeTool } from "../edge/_shared/internal-agent-tools.ts";
import { repairToolArgs, resolveToolName } from "../edge/_shared/tool-arg-repair.ts";

// ── Fausse passerelle : une réponse scriptée = une suite de morceaux SSE ─────
type Chunk = { delay?: number; data?: Record<string, unknown>; done?: boolean; destroy?: boolean };
type Scripted = { sse?: Chunk[]; json?: Record<string, unknown>; status?: number; body?: unknown };
let script: Scripted[] = [];
const requests: Array<Record<string, any>> = [];
let streamEndedAt = 0;

const gateway: Server = createHttpServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body);
    const next: Scripted = script.shift() ?? { json: final("fin") };
    if (next.status) {
      res.statusCode = next.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(next.body ?? { error: { message: "panne" } }));
      return;
    }
    if (next.sse && body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      for (const c of next.sse) {
        if (c.delay) await sleep(c.delay);
        if (c.destroy) { req.socket.destroy(); return; }
        if (c.done) res.write("data: [DONE]\n\n");
        else res.write(`data: ${JSON.stringify(c.data)}\n\n`);
      }
      streamEndedAt = Date.now();
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(next.json ?? final("fin")));
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const final = (content: string) => ({
  model: "gpt-5.6-terra",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
});
const delta = (d: Record<string, unknown>, finish?: string) => ({ data: { model: "gpt-5.6-terra", choices: [{ index: 0, delta: d, finish_reason: finish ?? null }] } });
const toolStart = (index: number, id: string, name: string) => delta({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] });
const toolArgs = (index: number, args: string) => delta({ tool_calls: [{ index, function: { arguments: args } }] });
const usage = (prompt = 1200): Chunk => ({ data: { model: "gpt-5.6-terra", choices: [], usage: { prompt_tokens: prompt, completion_tokens: 30, total_tokens: prompt + 30 } } });
const start = (): ChatMessage[] => [{ role: "system", content: "s" }, { role: "user", content: "go" }];
const tool = (name: string, parameters: Record<string, unknown> = { type: "object", properties: {} }) =>
  ({ type: "function" as const, function: { name, description: "d", parameters } });
// Les couloirs du tick, en petit : un état partagé par nom de famille.
const lane = (name: string) => (name.startsWith("browser_") ? "browser" : name === "update_todos" ? "run_state" : null);

before(async () => {
  const base = await listen(gateway);
  Object.assign(process.env, {
    LLM_UPSTREAM: "azure",
    AZURE_OPENAI_BASE_URL: `${base}/openai/v1`,
    AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-terra",
    AZURE_OPENAI_API_KEY: "k",
    LLM_RETRY_BASE_MS: "1",
  });
  resetUpstreamCaches();
});
after(() => {
  gateway.closeAllConnections?.();
  gateway.close();
  for (const k of ["LLM_UPSTREAM", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_KEY", "LLM_RETRY_BASE_MS"]) delete process.env[k];
});
beforeEach(() => { script = []; requests.length = 0; streamEndedAt = 0; });

describe("réparation des arguments (tool-input-repair)", () => {
  const schema = {
    type: "object",
    properties: {
      limit: { type: "integer" },
      enabled: { type: "boolean" },
      mode: { type: "string", enum: ["fast", "deep"] },
      filter: { type: "object", properties: { since: { type: "string" }, count: { type: "number" } } },
      tags: { type: "array", items: { type: "string" } },
      file_path: { type: "string" },
      note: { type: "string" },
    },
    required: ["file_path"],
  };

  it("répare ce que le schéma rend sans ambiguïté", () => {
    const out = repairToolArgs({
      limit: "20", enabled: "false", mode: "DEEP", filter: '{"since":"2026-01-01","count":"3"}',
      tags: "urgent", filePath: "/tmp/a.txt", note: null,
    }, schema);
    assert.deepEqual(out.args, {
      limit: 20, enabled: false, mode: "deep", filter: { since: "2026-01-01", count: 3 },
      tags: ["urgent"], file_path: "/tmp/a.txt",
    });
    assert.ok(out.repairs.length >= 7);
  });

  it("n'invente rien : une chaîne qui n'est pas un nombre reste une chaîne, un obligatoire absent reste absent", () => {
    const out = repairToolArgs({ limit: "beaucoup" }, schema);
    assert.deepEqual(out.args, { limit: "beaucoup" });
    assert.equal(out.repairs.length, 0);
  });

  it("ne renomme pas une clé quand la clé canonique est aussi fournie", () => {
    const out = repairToolArgs({ file_path: "/a", filePath: "/b" }, schema);
    assert.deepEqual(out.args, { file_path: "/a", filePath: "/b" });
  });

  it("redirige un nom d'un autre harnais vers l'outil de la boîte, jamais un nom connu", () => {
    const known = (n: string) => ["shell_exec", "web_search", "file_read"].includes(n);
    assert.equal(resolveToolName("bash", known), "shell_exec");
    assert.equal(resolveToolName("functions.web_search", known), "web_search");
    assert.equal(resolveToolName("webSearch", known), "web_search");
    assert.equal(resolveToolName("web_search", known), null);
    assert.equal(resolveToolName("deploy_rocket", known), null);
  });

  it("dans la boucle : l'appel est réparé avant exécution, et corrigé dans le transcrit", async () => {
    script = [
      { json: { model: "m", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "bash", arguments: '{"command":"ls","timeout":"30"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } } },
      { json: final("fin") },
    ];
    const seen: Array<[string, Record<string, unknown>]> = [];
    const shell = tool("shell_exec", { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] });
    const out = await runToolRounds({
      messages: start(), tools: [shell], maxRounds: 3, stream: false,
      executor: async (name, args) => { seen.push([name, args]); return "ok"; },
    });
    assert.deepEqual(seen, [["shell_exec", { command: "ls", timeout: 30 }]]);
    const asked = out.messages.find((m) => m.tool_calls)?.tool_calls?.[0];
    assert.equal(asked?.function.name, "shell_exec");
    assert.equal(asked?.function.arguments, '{"command":"ls","timeout":30}');
    assert.match(String(out.messages.find((m) => m.role === "tool")?.content), /^ok\n\n\[« bash » n'existe pas/);
    assert.equal(out.harness.args_repaired, 1);
    assert.equal(out.harness.tools_aliased, 1);
  });
});

describe("réponse en flux", () => {
  it("le texte arrive au fil de l'eau, cumulé ; la mesure du tour est rendue", async () => {
    script = [{ sse: [delta({ content: "Bon" }), delta({ content: "jour" }, "stop"), usage(1500), { done: true }] }];
    const seen: string[] = [];
    const out = await runToolRounds({ messages: start(), tools: [tool("web_search")], maxRounds: 2, executor: async () => "ok", onDelta: (t) => seen.push(t) });
    assert.equal(out.content, "Bonjour");
    assert.deepEqual(seen, ["Bon", "Bonjour"]);
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(out.harness.streamed_rounds, 1);
    assert.equal(out.measure?.tokens, 1500);
    assert.ok((out.measure?.bodyChars ?? 0) > 0);
  });

  it("un outil complet part PENDANT le flux, avant la fin de la réponse", async () => {
    script = [
      {
        sse: [
          toolStart(0, "a", "web_search"), toolArgs(0, '{"query":'), toolArgs(0, '"lyon"}'),
          toolStart(1, "b", "read_url"), { delay: 250, ...toolArgs(1, '{"url":"u"}') },
          delta({}, "tool_calls"), usage(), { done: true },
        ],
      },
      { json: final("fin") },
    ];
    const started: Record<string, number> = {};
    const out = await runToolRounds({
      messages: start(), tools: [tool("web_search"), tool("read_url")], maxRounds: 3,
      parallelSafe: isParallelSafeTool, lane,
      executor: async (name) => { started[name] = Date.now(); await sleep(20); return `${name} ok`; },
    });
    assert.equal(out.content, "fin");
    // web_search est parti quand read_url a commencé, 250 ms avant la fin du flux.
    assert.ok(started.web_search < streamEndedAt - 150, `parti à ${started.web_search - streamEndedAt} ms de la fin`);
    assert.equal(out.harness.early_tools, 2);
    const results = out.messages.filter((m) => m.role === "tool");
    assert.deepEqual(results.map((m) => m.tool_call_id), ["a", "b"]);
  });

  it("un appel à effet lancé pendant le flux attend la sauvegarde de sa demande", async () => {
    script = [
      { sse: [toolStart(0, "w", "send_email"), toolArgs(0, '{"to":"a@b.c"}'), toolStart(1, "r", "web_search"), { delay: 150, ...toolArgs(1, '{"query":"x"}') }, delta({}, "tool_calls"), { done: true }] },
      { json: final("fin") },
    ];
    const messages = start();
    const events: string[] = [];
    await runToolRounds({
      messages, tools: [tool("send_email"), tool("web_search")], maxRounds: 3,
      parallelSafe: isParallelSafeTool, effectful: hasExternalEffect, lane,
      executor: async (name) => { events.push(`exec:${name}`); return "ok"; },
      onBeforeTools: async () => {
        const pending = messages.find((m) => m.role === "assistant" && m.tool_calls);
        events.push(`save:${pending?.tool_calls?.map((c) => c.function.name).join(",")}`);
      },
      ledger: { started: async (c) => { events.push(`started:${c.name}`); }, settled: async () => {} },
    });
    // La demande d'envoi est dans le transcrit sauvegardé AVANT son départ ;
    // la lecture, elle, n'attend rien.
    assert.ok(events.indexOf("save:send_email") < events.indexOf("exec:send_email"));
    assert.ok(events.indexOf("started:send_email") < events.indexOf("exec:send_email"));
    assert.ok(events.includes("exec:web_search"));
  });

  it("un flux coupé après un appel complet : l'appel est exécuté, le tour continue", async () => {
    script = [
      { sse: [toolStart(0, "a", "web_search"), toolArgs(0, '{"query":"x"}'), toolStart(1, "b", "read_url"), toolArgs(1, '{"url":'), { delay: 150, destroy: true }] },
      { json: final("fin") },
    ];
    const executed: string[] = [];
    const out = await runToolRounds({
      messages: start(), tools: [tool("web_search"), tool("read_url")], maxRounds: 3,
      parallelSafe: isParallelSafeTool, lane,
      executor: async (name) => { executed.push(name); return "ok"; },
    });
    assert.deepEqual(executed, ["web_search"]);
    assert.equal(out.content, "fin");
    const asked = out.messages.find((m) => m.tool_calls)?.tool_calls ?? [];
    assert.deepEqual(asked.map((c) => c.id), ["a"]);
    assert.equal(out.harness.stream_interruptions, 1);
  });

  it("un fournisseur qui refuse le flux : la même requête repart d'un bloc", async () => {
    script = [{ status: 400, body: { error: { message: "stream is not supported for this model" } } }, { json: final("ok") }];
    const out = await runToolRounds({ messages: start(), tools: [tool("web_search")], maxRounds: 1, executor: async () => "ok", onDelta: () => {} });
    assert.equal(out.content, "ok");
    assert.equal(requests[0].stream, true);
    assert.equal(requests[1].stream, undefined);
  });
});

describe("couloirs d'exécution", () => {
  const turn = (...calls: Array<[string, string, Record<string, unknown>]>): Scripted => ({
    json: {
      model: "m",
      choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    },
  });

  it("tout part ensemble, sauf un même couloir qui passe dans l'ordre", async () => {
    script = [turn(["a", "browser_open", { url: "1" }], ["b", "browser_click", { sel: "x" }], ["c", "send_email", { to: "z" }], ["d", "web_search", { query: "q" }]), { json: final("fin") }];
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await runToolRounds({
      messages: start(), tools: [tool("browser_open"), tool("browser_click"), tool("send_email"), tool("web_search")], maxRounds: 2, stream: false,
      parallelSafe: isParallelSafeTool, lane,
      executor: async (name) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        log.push(`start:${name}`);
        await sleep(40);
        log.push(`end:${name}`);
        inFlight--;
        return "ok";
      },
    });
    // Le navigateur, dans l'ordre ; l'envoi et la recherche en même temps que lui.
    assert.ok(log.indexOf("end:browser_open") < log.indexOf("start:browser_click"));
    assert.equal(maxInFlight, 3);
  });

  it("ask_user part en dernier, une fois les autres finis ; leurs résultats sont gardés", async () => {
    script = [turn(["q", "ask_user", { question: "?" }], ["r", "web_search", { query: "x" }])];
    const messages = start();
    const log: string[] = [];
    class AwaitingInputError extends Error { override name = "AwaitingInputError"; }
    await assert.rejects(runToolRounds({
      messages, tools: [tool("ask_user"), tool("web_search")], maxRounds: 2, stream: false,
      parallelSafe: isParallelSafeTool, lane, runLast: (n) => n === "ask_user",
      executor: async (name) => {
        log.push(name);
        if (name === "ask_user") throw new AwaitingInputError("?");
        await sleep(30);
        return "trouvé";
      },
    }), /AwaitingInput|\?/);
    assert.deepEqual(log, ["web_search", "ask_user"]);
    assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.content), ["trouvé"]);
  });

  it("annulation : le signal part aux outils, le run s'arrête comme annulé", async () => {
    script = [turn(["a", "web_search", { query: "x" }])];
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 100);
    let sawAbort = false;
    await assert.rejects(runToolRounds({
      messages: start(), tools: [tool("web_search")], maxRounds: 2, stream: false,
      parallelSafe: isParallelSafeTool, lane, isCancelled: async () => cancelled,
      executor: async (_name, _args, ctx) => new Promise<string>((resolve) => {
        ctx?.signal?.addEventListener("abort", () => { sawAbort = true; resolve("arrêté proprement"); });
      }),
    }), (e: Error) => e.name === "RunCancelledError");
    assert.equal(sawAbort, true);
  });
});

describe("descriptions d'outils (mesure A/B)", () => {
  it("la variante d'un run est stable, et les deux existent", () => {
    delete process.env.AGENT_TOOL_DESC_MODE;
    const variants = new Set(Array.from({ length: 40 }, (_, i) => toolDescVariant(`run-${i}`)));
    assert.deepEqual([...variants].sort(), ["compact", "full"]);
    assert.equal(toolDescVariant("run-7"), toolDescVariant("run-7"));
    process.env.AGENT_TOOL_DESC_MODE = "full";
    assert.equal(toolDescVariant("run-7"), "full");
    delete process.env.AGENT_TOOL_DESC_MODE;
  });

  it("en « full », la description part entière ; en « compact », coupée", async () => {
    const long = "x".repeat(400);
    const t = { type: "function" as const, function: { name: "web_search", description: long, parameters: { type: "object", properties: {} } } };
    script = [{ json: final("a") }, { json: final("b") }];
    await runToolRounds({ messages: start(), tools: [t], maxRounds: 1, stream: false, executor: async () => "ok", toolDescriptions: "full" });
    await runToolRounds({ messages: start(), tools: [t], maxRounds: 1, stream: false, executor: async () => "ok" });
    assert.equal(requests[0].tools[0].function.description.length, 400);
    assert.ok(requests[1].tools[0].function.description.length <= 140);
  });
});
