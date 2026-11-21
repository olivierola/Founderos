// La boucle d'outils des agents (ai.ts) : lectures en parallèle, arguments
// illisibles signalés au modèle au lieu d'être exécutés à vide, échéance de
// tick, sauvegarde après chaque tour, cache de préfixe compté. Contre une
// fausse passerelle Azure qui rejoue des réponses écrites d'avance.

import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  callAiWithTools, fitOutputBudget, isRetryableStatus, MISSING_TOOL_RESULT, parseToolArgs, repairToolPairing,
  retryDelayMs, runToolRounds, shrinkOldToolResults, validateToolArgs, type ChatMessage,
} from "../edge/_shared/ai.ts";
import { resetUpstreamCaches } from "../edge/_shared/llm-upstream.ts";
import { hasExternalEffect, isParallelSafeTool } from "../edge/_shared/internal-agent-tools.ts";

// ── Fausse passerelle : chaque requête consomme la réponse suivante ─────────
// Une réponse scriptée est soit un message (200), soit une panne : un statut
// avec son corps et ses en-têtes, un délai avant de répondre, ou une connexion
// coupée net.
type Scripted = {
  message?: Record<string, unknown>; finish?: string; cached?: number; cost?: number;
  status?: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; destroy?: boolean;
};
let script: Scripted[] = [];
const requests: Array<Record<string, any>> = [];
const gateway: Server = createHttpServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    requests.push(raw ? JSON.parse(raw) : {});
    const next = script.shift() ?? { message: { role: "assistant", content: "fin" } };
    if (next.destroy) { req.socket.destroy(); return; }
    const reply = () => {
      if (res.destroyed) return;
      for (const [k, v] of Object.entries(next.headers ?? {})) res.setHeader(k, v);
      res.setHeader("Content-Type", "application/json");
      if (next.status && next.status >= 400) {
        res.statusCode = next.status;
        res.end(JSON.stringify(next.body ?? { error: { message: "panne" } }));
        return;
      }
      const message = next.message ?? { role: "assistant", content: "fin" };
      res.end(JSON.stringify({
        model: "gpt-5.6-terra",
        choices: [{ message, finish_reason: next.finish ?? (message.tool_calls ? "tool_calls" : "stop") }],
        usage: {
          prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: next.cached ?? 0 },
          ...(next.cost != null ? { cost: next.cost } : {}),
        },
      }));
    };
    if (next.delayMs) setTimeout(reply, next.delayMs);
    else reply();
  });
});

const call = (id: string, name: string, args: unknown) =>
  ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const toolTurn = (...calls: ReturnType<typeof call>[]): Scripted => ({ message: { role: "assistant", content: null, tool_calls: calls } });
const answer = (content: string): Scripted => ({ message: { role: "assistant", content } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const start = (): ChatMessage[] => [{ role: "system", content: "s" }, { role: "user", content: "go" }];
const tool = { type: "function" as const, function: { name: "web_search", description: "d", parameters: { type: "object", properties: {} } } };

before(async () => {
  const base = await listen(gateway);
  Object.assign(process.env, {
    LLM_UPSTREAM: "azure",
    AZURE_OPENAI_BASE_URL: `${base}/openai/v1`,
    AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-terra",
    AZURE_OPENAI_API_KEY: "k",
    // Les relances attendent 1 ms × 2^n au lieu de 500 ms : la suite reste rapide.
    LLM_RETRY_BASE_MS: "1",
  });
  resetUpstreamCaches();
});
after(() => {
  gateway.closeAllConnections?.();
  gateway.close();
  for (const k of ["LLM_UPSTREAM", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_KEY", "LLM_RETRY_BASE_MS"]) delete process.env[k];
});
beforeEach(() => { script = []; requests.length = 0; });

describe("arguments d'outil", () => {
  it("un JSON valide passe, un JSON illisible devient une erreur adressée au modèle", () => {
    assert.deepEqual(parseToolArgs('{"q":"lyon"}'), { args: { q: "lyon" } });
    assert.deepEqual(parseToolArgs(""), { args: {} });
    assert.match(parseToolArgs('{"content":"début du rap').error ?? "", /pas un objet JSON valide/);
    assert.match(parseToolArgs('{"content":"début du rap', true).error ?? "", /coupés par la limite de sortie/);
    assert.match(parseToolArgs("[1,2]").error ?? "", /pas un objet JSON valide/);
  });
});

describe("runToolRounds", () => {
  it("force l'intégration explicitement demandée, puis revient au choix automatique", async () => {
    script = [
      answer("Je ne peux pas afficher les actions."),
      toolTurn(call("youtube", "use_youtube", {})),
      answer("Voici les statistiques."),
    ];
    const youtube = {
      type: "function" as const,
      function: { name: "use_youtube", description: "Discover and use YouTube actions.", parameters: { type: "object", properties: {} } },
    };
    const out = await runToolRounds({
      messages: start(), tools: [youtube], maxRounds: 4,
      toolChoice: { type: "function", function: { name: "use_youtube" } },
      executor: async () => "actions YouTube découvertes",
    });

    assert.equal(out.content, "Voici les statistiques.");
    assert.deepEqual(requests.map((request) => request.tool_choice), [
      { type: "function", function: { name: "use_youtube" } },
      { type: "function", function: { name: "use_youtube" } },
      "auto",
    ]);
  });

  it("les lectures d'un même tour partent ensemble, et leurs résultats restent dans l'ordre", async () => {
    script = [
      toolTurn(call("a", "web_search", { query: "lyon" }), call("b", "web_search", { query: "marseille" }), call("c", "read_url", { url: "u" })),
      answer("Lyon et Marseille."),
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 4, parallelSafe: isParallelSafeTool,
      executor: async (name, args) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        // Le plus lent finit le PREMIER : l'ordre des résultats ne doit pas en dépendre.
        await sleep(name === "web_search" && args.query === "lyon" ? 120 : 40);
        inFlight--;
        return `${name}:${args.query ?? args.url}`;
      },
    });
    assert.equal(out.finished, true);
    assert.equal(out.content, "Lyon et Marseille.");
    // Mesuré sur l'exécuteur, pas à la montre : la suite tourne en parallèle.
    assert.equal(maxInFlight, 3);
    const results = out.messages.filter((m) => m.role === "tool");
    assert.deepEqual(results.map((m) => m.tool_call_id), ["a", "b", "c"]);
    assert.deepEqual(results.map((m) => m.content), ["web_search:lyon", "web_search:marseille", "read_url:u"]);
  });

  it("une écriture passe seule, à son tour", async () => {
    script = [
      toolTurn(call("a", "web_search", { query: "x" }), call("b", "send_email", { to: "a@b.c" }), call("c", "web_search", { query: "y" })),
      answer("ok"),
    ];
    const events: string[] = [];
    await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 2, parallelSafe: isParallelSafeTool,
      executor: async (name) => { events.push(`start:${name}`); await sleep(30); events.push(`end:${name}`); return "ok"; },
    });
    assert.deepEqual(events, ["start:web_search", "end:web_search", "start:send_email", "end:send_email", "start:web_search", "end:web_search"]);
  });

  it("un appel d'outil coupé par la limite de sortie est relancé une fois, avec un plafond plus haut", async () => {
    const truncated = { ...toolTurn(call("a", "create_deliverable", '{"name":"Rapport","content":"# Titre\\n\\nDébut du te')), finish: "length" };
    script = [
      truncated,
      toolTurn(call("a2", "create_deliverable", { name: "Rapport", content: "# Titre\n\nTexte complet." })),
      answer("Livré."),
    ];
    const executed: string[] = [];
    const out = await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 3, maxTokens: 6000,
      executor: async (_name, args) => { executed.push(String(args.content)); return "ok"; },
    });
    assert.deepEqual(executed, ["# Titre\n\nTexte complet."]);
    assert.equal(out.content, "Livré.");
    // Même requête, plafond relevé (Azure : max_completion_tokens).
    assert.equal(requests[0].max_completion_tokens, 6000);
    assert.equal(requests[1].max_completion_tokens, 24000);
    assert.deepEqual(requests[1].messages, requests[0].messages);
    // La réponse coupée a été facturée : elle est comptée.
    assert.equal(out.usage.prompt_tokens, 3000);
  });

  it("si la relance est coupée elle aussi, l'outil ne part pas : le modèle reçoit pourquoi", async () => {
    const truncated = { ...toolTurn(call("a", "create_deliverable", '{"name":"Rapport","content":"# Titre\\n\\nDébut du te')), finish: "length" };
    script = [truncated, truncated, answer("Je découpe.")];
    let executed = 0;
    const out = await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 2,
      executor: async () => { executed++; return "ok"; },
    });
    assert.equal(executed, 0);
    const result = out.messages.find((m) => m.role === "tool");
    assert.match(String(result?.content), /coupés par la limite de sortie/);
    assert.equal(out.errorCount, 1);
    assert.equal(requests.length, 3);
  });

  it("la relance n'a pas lieu quand l'échéance ne laisse pas le temps de tout réécrire", async () => {
    const truncated = { ...toolTurn(call("a", "create_deliverable", '{"content":"Début')), finish: "length" };
    script = [truncated, answer("Je découpe.")];
    await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 2, executor: async () => "ok",
      hardDeadlineAt: Date.now() + 2_000,
    });
    // Pas de relance : le 2e appel est le tour suivant, au plafond normal.
    assert.equal(requests[1].max_completion_tokens, 4000);
  });

  it("l'échéance arrête la boucle avant un tour qui ne finirait pas à temps", async () => {
    script = [toolTurn(call("a", "web_search", { query: "x" })), toolTurn(call("b", "web_search", { query: "y" })), answer("fin")];
    const out = await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 4,
      // 10 s de marge minimale par tour : une échéance à 5 s ne laisse passer que le premier.
      deadlineAt: Date.now() + 5_000,
      executor: async () => "ok",
    });
    assert.equal(out.finished, false);
    assert.equal(out.stoppedForTime, true);
    assert.equal(out.roundsRun, 1);
    assert.equal(requests.length, 1);
  });

  it("le premier tour part toujours, même en retard", async () => {
    script = [answer("fin")];
    const out = await runToolRounds({ messages: start(), tools: [tool], maxRounds: 4, deadlineAt: Date.now() - 1, executor: async () => "ok" });
    assert.equal(out.finished, true);
    assert.equal(out.roundsRun, 1);
  });

  it("chaque tour d'outils est sauvegardé, avec la consommation cumulée et le cache", async () => {
    script = [
      { ...toolTurn(call("a", "web_search", { query: "x" })), cached: 0 },
      { ...toolTurn(call("b", "web_search", { query: "y" })), cached: 800 },
      answer("fin"),
    ];
    const saved: Array<[number, number, number, number]> = [];
    const messages = start();
    const out = await runToolRounds({
      messages, tools: [tool], maxRounds: 4,
      executor: async () => "ok",
      // Ce que le runtime enregistre : le transcrit À JOUR (résultats compris).
      onRoundEnd: async (p) => {
        saved.push([p.roundsRun, p.usage.prompt_tokens, p.usage.cached_tokens, messages.filter((m) => m.role === "tool").length]);
      },
    });
    assert.deepEqual(saved, [[1, 1000, 0, 1], [2, 2000, 800, 2]]);
    assert.equal(out.usage.cached_tokens, 800);
    assert.equal(out.usage.prompt_tokens, 3000);
  });

  it("le coût facturé (Runware : usage.cost) est cumulé, et ne vaut que s'il est donné à chaque appel", async () => {
    script = [{ ...toolTurn(call("a", "web_search", { query: "x" })), cost: 0.0125 }, { ...answer("fin"), cost: 0.0075 }];
    const priced = await runToolRounds({ messages: start(), tools: [tool], maxRounds: 3, executor: async () => "ok" });
    assert.equal(priced.usage.unpriced_calls, 0);
    assert.ok(Math.abs(priced.usage.reported_cost_usd - 0.02) < 1e-9);
    script = [{ ...toolTurn(call("a", "web_search", { query: "x" })), cost: 0.0125 }, answer("fin")];
    const partial = await runToolRounds({ messages: start(), tools: [tool], maxRounds: 3, executor: async () => "ok" });
    assert.equal(partial.usage.unpriced_calls, 1);
  });

  it("un appel à effet : transcrit sauvegardé AVANT l'exécution, départ et résultat notés au registre", async () => {
    script = [
      toolTurn(call("r", "web_search", { query: "x" })),
      toolTurn(call("w", "send_email", { to: "a@b.c" })),
      answer("fin"),
    ];
    const messages = start();
    const events: string[] = [];
    await runToolRounds({
      messages, tools: [tool], maxRounds: 4, parallelSafe: isParallelSafeTool, effectful: hasExternalEffect,
      executor: async (name) => { events.push(`exec:${name}`); return `${name} ok`; },
      onBeforeTools: async () => {
        // Ce que le runtime sauvegarde : la demande d'appel est déjà dans le transcrit.
        const last = messages[messages.length - 1];
        events.push(`save:${last.tool_calls?.map((c) => c.function.name).join(",")}`);
      },
      ledger: {
        started: async (c) => { events.push(`started:${c.id}:${c.name}:${JSON.stringify(c.args)}`); },
        settled: async (c, r) => { events.push(`settled:${c.id}:${r}`); },
      },
    });
    // La lecture ne déclenche ni sauvegarde préalable ni registre.
    assert.deepEqual(events, [
      "exec:web_search",
      "save:send_email",
      'started:w:send_email:{"to":"a@b.c"}',
      "exec:send_email",
      "settled:w:send_email ok",
    ]);
  });

  it("un appel refusé par son schéma n'est jamais noté comme parti", async () => {
    script = [toolTurn(call("w", "send_email", "{pas du json")), answer("fin")];
    const noted: string[] = [];
    await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 3, effectful: hasExternalEffect,
      executor: async () => "envoyé",
      ledger: { started: async (c) => { noted.push(c.id); }, settled: async () => {} },
    });
    assert.deepEqual(noted, []);
  });

  it("un registre en panne n'empêche pas l'appel de partir", async () => {
    script = [toolTurn(call("w", "send_email", { to: "a@b.c" })), answer("fin")];
    const out = await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 3, effectful: hasExternalEffect,
      executor: async () => "envoyé",
      onBeforeTools: async () => { throw new Error("base injoignable"); },
      ledger: { started: async () => { throw new Error("base injoignable"); }, settled: async () => { throw new Error("idem"); } },
    });
    assert.equal(out.finished, true);
    assert.deepEqual(out.toolCalls.map((c) => c.name), ["send_email"]);
  });

  it("une sauvegarde qui échoue n'arrête pas la boucle", async () => {
    script = [toolTurn(call("a", "web_search", { query: "x" })), answer("fin")];
    const out = await runToolRounds({
      messages: start(), tools: [tool], maxRounds: 3, executor: async () => "ok",
      onRoundEnd: async () => { throw new Error("base injoignable"); },
    });
    assert.equal(out.finished, true);
  });

  it("un signal de contrôle levé plus loin ne fait pas perdre les résultats déjà obtenus", async () => {
    script = [toolTurn(call("a", "web_search", { query: "x" }), call("b", "send_email", { to: "a@b.c" }))];
    const messages = start();
    class AwaitingApprovalError extends Error { override name = "AwaitingApprovalError"; }
    await assert.rejects(runToolRounds({
      messages, tools: [tool], maxRounds: 2, parallelSafe: isParallelSafeTool,
      executor: async (name) => { if (name === "send_email") throw new AwaitingApprovalError("validation"); return "trouvé"; },
    }), /validation/);
    const results = messages.filter((m) => m.role === "tool");
    assert.deepEqual(results.map((m) => m.content), ["trouvé"]);
  });
});

describe("callAiWithTools", () => {
  it("partage les mêmes briques : lectures parallèles et arguments vérifiés", async () => {
    script = [
      toolTurn(call("a", "web_search", { query: "x" }), call("b", "web_search", { query: "y" }), call("c", "web_search", "{oups")),
      answer("Réponse."),
    ];
    let executed = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await callAiWithTools({
      messages: start(), tools: [tool], maxRounds: 3, parallelSafe: isParallelSafeTool,
      executor: async () => {
        executed++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(60);
        inFlight--;
        return "ok";
      },
    });
    assert.equal(out.content, "Réponse.");
    assert.equal(executed, 2);
    assert.equal(maxInFlight, 2);
    assert.equal(out.toolCalls.length, 3);
    assert.equal(out.model, "gpt-5.6-terra");
  });
});

// ── Relances (withRetry) ────────────────────────────────────────────────────
describe("relances des appels de modèle", () => {
  const once = () => runToolRounds({ messages: start(), tools: [tool], maxRounds: 1, executor: async () => "ok" });

  it("une panne passagère (503) est relancée, la réponse suivante sert", async () => {
    script = [{ status: 503 }, { status: 502 }, answer("ok")];
    const out = await once();
    assert.equal(out.content, "ok");
    assert.equal(requests.length, 3);
  });

  it("une connexion coupée net est relancée", async () => {
    script = [{ destroy: true }, answer("ok")];
    const out = await once();
    assert.equal(out.content, "ok");
    assert.equal(requests.length, 2);
  });

  it("Retry-After fixe l'attente", async () => {
    script = [{ status: 429, body: { error: { message: "rate limited" } }, headers: { "retry-after-ms": "250" } }, answer("ok")];
    const t0 = Date.now();
    const out = await once();
    assert.equal(out.content, "ok");
    assert.ok(Date.now() - t0 >= 240, `attente trop courte : ${Date.now() - t0} ms`);
  });

  it("x-should-retry: false arrête net, et une erreur 400 n'est pas relancée", async () => {
    script = [{ status: 503, headers: { "x-should-retry": "false" } }];
    await assert.rejects(once(), /tool chat failed: 503/);
    assert.equal(requests.length, 1);
    requests.length = 0;
    script = [{ status: 400, body: { error: { message: "unsupported parameter" } } }];
    await assert.rejects(once(), /tool chat failed: 400/);
    assert.equal(requests.length, 1);
  });

  it("une requête qui ne répond pas est coupée, puis relancée", async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = "150";
    try {
      script = [{ delayMs: 1_000, message: { role: "assistant", content: "trop tard" } }, answer("ok")];
      const t0 = Date.now();
      const out = await once();
      assert.equal(out.content, "ok");
      assert.ok(Date.now() - t0 < 900, "la première requête aurait dû être coupée");
    } finally {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    }
  });

  it("une requête coupée deux fois pour délai n'est pas relancée une troisième", async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = "100";
    try {
      const slow = { delayMs: 600, message: { role: "assistant", content: "trop tard" } };
      script = [slow, slow, answer("jamais")];
      await assert.rejects(once(), /tool chat failed: pas de réponse en 0 s/);
      assert.equal(requests.length, 2);
    } finally {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    }
  });

  it("une sortie qui déborde la fenêtre réduit max_tokens au lieu de compacter", async () => {
    script = [
      { status: 400, body: { error: { code: "context_length_exceeded", message: "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion)." } } },
      answer("ok"),
    ];
    const out = await runToolRounds({ messages: start(), tools: [tool], maxRounds: 1, maxTokens: 10_000, executor: async () => "ok" });
    assert.equal(out.content, "ok");
    assert.equal(requests[0].max_completion_tokens, 10_000);
    assert.equal(requests[1].max_completion_tokens, 7_000);
  });

  it("le délai d'attente : Retry-After d'abord, sinon exponentiel avec aléa, plafonné", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    assert.equal(retryDelayMs(1, h({ "retry-after-ms": "1200" })), 1200);
    assert.equal(retryDelayMs(1, h({ "retry-after": "3" })), 3000);
    process.env.LLM_RETRY_BASE_MS = "500";
    try {
      for (const [attempt, base] of [[1, 500], [2, 1000], [4, 4000], [9, 32_000]] as const) {
        const d = retryDelayMs(attempt, null);
        assert.ok(d >= base && d <= base * 1.25, `tentative ${attempt} : ${d}`);
      }
    } finally {
      process.env.LLM_RETRY_BASE_MS = "1";
    }
    assert.equal(isRetryableStatus(408), true);
    assert.equal(isRetryableStatus(409), true);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(500, h({ "x-should-retry": "false" })), false);
    assert.equal(isRetryableStatus(400, h({ "x-should-retry": "true" })), true);
  });

  it("fitOutputBudget ne réduit que si l'entrée tient et qu'il reste au moins 3000 tokens", () => {
    const body = { max_completion_tokens: 20_000 };
    assert.equal(fitOutputBudget(body, "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"), true);
    assert.equal(body.max_completion_tokens, 200_000 - 188_059 - 1000);
    const tight = { max_tokens: 8000 };
    assert.equal(fitOutputBudget(tight, "maximum context length is 128000 tokens. However, you requested 135000 tokens (127000 in the messages, 8000 in the completion)"), false);
    assert.equal(tight.max_tokens, 8000);
  });
});

// ── Invariant tool_call / tool_result ───────────────────────────────────────
describe("paires appel / résultat d'outil", () => {
  const asst = (...ids: string[]): ChatMessage => ({ role: "assistant", content: null, tool_calls: ids.map((id) => call(id, "web_search", {}) as NonNullable<ChatMessage["tool_calls"]>[number]) });
  const res = (id: string, content = `r-${id}`): ChatMessage => ({ role: "tool", tool_call_id: id, content });

  it("un appel sans résultat reçoit un résultat synthétique ; les résultats obtenus restent", () => {
    const out = repairToolPairing([...start(), asst("a", "b", "c"), res("a"), res("c"), { role: "user", content: "suite" }]);
    assert.deepEqual(out.slice(2).map((m) => [m.role, m.tool_call_id ?? null, m.content]), [
      ["assistant", null, null],
      ["tool", "a", "r-a"],
      ["tool", "b", MISSING_TOOL_RESULT],
      ["tool", "c", "r-c"],
      ["user", null, "suite"],
    ]);
  });

  it("un résultat orphelin est retiré ; un transcrit valide est rendu tel quel", () => {
    const valid = [...start(), asst("a"), res("a")];
    assert.equal(repairToolPairing(valid), valid);
    const out = repairToolPairing([...start(), res("zombie"), asst("a"), res("a")]);
    assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  });
});

// ── Microcompaction stable pour le cache ────────────────────────────────────
describe("microcompaction par paliers", () => {
  const transcript = (n: number): ChatMessage[] => {
    const out = start();
    for (let i = 0; i < n; i++) out.push({ role: "assistant", content: null, tool_calls: [call(`c${i}`, "read_url", {}) as NonNullable<ChatMessage["tool_calls"]>[number]] }, { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(1000) });
    return out;
  };
  const stubbed = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === "tool" && (m.content?.length ?? 0) < 1000).length;

  it("la coupe avance par six résultats, pas à chaque nouveau", () => {
    assert.equal(stubbed(shrinkOldToolResults(transcript(11))), 0);
    assert.equal(stubbed(shrinkOldToolResults(transcript(12))), 6);
    assert.equal(stubbed(shrinkOldToolResults(transcript(17))), 6);
    assert.equal(stubbed(shrinkOldToolResults(transcript(18))), 12);
  });

  it("entre deux paliers, le préfixe envoyé ne change pas d'un octet", () => {
    const a = shrinkOldToolResults(transcript(13));
    const b = shrinkOldToolResults(transcript(14));
    assert.equal(JSON.stringify(b.slice(0, a.length)), JSON.stringify(a));
  });

  it("le pas 1 garde l'ancien comportement (passes de compaction d'urgence)", () => {
    assert.equal(stubbed(shrinkOldToolResults(transcript(10), 2, 200, 1)), 8);
  });
});

// ── Validation des arguments contre le schéma ──────────────────────────────
describe("arguments contre le schéma", () => {
  const schema = { type: "object", properties: { query: { type: "string" }, mode: { type: "string", enum: ["fast", "deep"] } }, required: ["query"] };

  it("obligatoire absent et valeur hors enum sont refusés ; la casse et les types ne le sont pas", () => {
    assert.deepEqual(validateToolArgs(schema, { query: "x", mode: "fast" }), []);
    assert.deepEqual(validateToolArgs(schema, { query: "x", mode: "DEEP" }), []);
    assert.deepEqual(validateToolArgs(schema, { query: 42 }), []);
    assert.equal(validateToolArgs(schema, {}).length, 1);
    assert.match(validateToolArgs(schema, { query: "x", mode: "turbo" })[0], /"fast", "deep"/);
    assert.deepEqual(validateToolArgs(undefined, {}), []);
  });

  it("un appel qui enfreint le schéma envoyé n'est pas exécuté", async () => {
    const strictTool = { type: "function" as const, function: { name: "web_search", description: "d", parameters: schema } };
    script = [toolTurn(call("a", "web_search", { mode: "fast" })), answer("fin")];
    let executed = 0;
    const out = await runToolRounds({ messages: start(), tools: [strictTool], maxRounds: 2, executor: async () => { executed++; return "ok"; } });
    assert.equal(executed, 0);
    assert.match(String(out.messages.find((m) => m.role === "tool")?.content), /arguments invalides pour web_search — « query » est obligatoire/);
    assert.equal(out.errorCount, 1);
  });

  it("un outil hors de la liste envoyée n'est pas validé (son schéma n'est pas connu)", async () => {
    script = [toolTurn(call("a", "send_email", {})), answer("fin")];
    let executed = 0;
    await runToolRounds({ messages: start(), tools: [tool], maxRounds: 2, executor: async () => { executed++; return "ok"; } });
    assert.equal(executed, 1);
  });
});

// ── Échéance dure des outils ────────────────────────────────────────────────
describe("outil bloqué à l'échéance du tick", () => {
  it("il est abandonné avec une erreur lisible, et son rejet tardif ne remonte pas", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      script = [toolTurn(call("a", "shell_exec", { command: "sleep 600" })), answer("fin")];
      const t0 = Date.now();
      const out = await runToolRounds({
        messages: start(), tools: [tool], maxRounds: 2,
        hardDeadlineAt: Date.now() + 200,
        // Rejette APRÈS l'abandon : ce rejet ne doit aller nulle part.
        executor: () => new Promise((_, reject) => setTimeout(() => reject(new Error("trop tard")), 1_300)),
      });
      assert.ok(Date.now() - t0 < 1_300 + 500);
      const result = String(out.messages.find((m) => m.role === "tool")?.content);
      assert.match(result, /n'a pas répondu avant la fin du temps du tick/);
      assert.match(result, /effet est INCONNU/);
      await sleep(400);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
