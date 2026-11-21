// Les modules du harnais aligné sur OpenCode, chacun seul : hooks, diagnostic
// des erreurs d'outil, contrôleur de boucle, mesure du contexte, classement
// Jev des outils, refus avec consigne, boîte de réception des sous-agents.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HarnessHooks } from "../edge/_shared/harness-hooks.ts";
import {
  autoRetryDelayMs, diagnoseToolError, withDiagnosis, makeDiagnosis,
} from "../edge/_shared/tool-error-diagnosis.ts";
import { decideNext, type LoopSignals } from "../edge/_shared/agent-loop.ts";
import {
  estimatePromptTokens, isValidCheckpoint, renderTranscript, shouldPrepareCheckpoint, checkpointBlock,
} from "../edge/_shared/context-checkpoint.ts";
import { selectTools } from "../edge/_shared/prompt-compiler.ts";
import { reusableRanking, taskHashOf, compactRanking } from "../edge/_shared/tool-ranking.ts";
import { rejectionResult, toolLane, isHumanPauseTool } from "../edge/_shared/internal-agent-tools.ts";
import { childBrief, inboxMessage, spawnedNotice } from "../edge/_shared/background-agents.ts";
import { registerRunToolHooks, querySig, type RunHookDeps } from "../edge/_shared/run-tool-hooks.ts";
import type { ChatMessage } from "../edge/_shared/ai.ts";

describe("hooks du harnais", () => {
  it("avant / après dans l'ordre d'inscription ; un court-circuit saute l'outil", async () => {
    const log: string[] = [];
    const hooks = new HarnessHooks()
      .onToolBefore("a", ({ args }) => { log.push("before:a"); return { args: { ...args, x: 2 } }; })
      .onToolBefore("b", ({ name }) => { log.push("before:b"); return name === "skip" ? { result: "court-circuit" } : undefined; })
      .onToolAfter("c", (e) => { log.push(`after:c:${e.shortCircuitBy ?? "-"}`); return `${e.result}+c`; });
    const exec = hooks.wrapExecutor(async (_n, args) => { log.push(`exec:${JSON.stringify(args)}`); return "ok"; });
    assert.equal(await exec("t", { x: 1 }), "ok+c");
    assert.deepEqual(log, ["before:a", "before:b", 'exec:{"x":2}', "after:c:-"]);
    log.length = 0;
    assert.equal(await exec("skip", {}), "court-circuit+c");
    assert.deepEqual(log, ["before:a", "before:b", "after:c:b"]);
  });

  it("un hook en panne est ignoré, sauf s'il est critique : l'outil ne part pas", async () => {
    let ran = 0;
    const soft = new HarnessHooks().onToolBefore("bruit", () => { throw new Error("journal en panne"); });
    assert.equal(await soft.wrapExecutor(async () => { ran++; return "ok"; })("t", {}), "ok");
    assert.equal(soft.failures.length, 1);
    const hard = new HarnessHooks().onToolBefore("garde-fou", () => { throw new Error("juge injoignable"); }, { critical: true });
    const out = await hard.wrapExecutor(async () => { ran++; return "ok"; })("t", {});
    assert.match(out, /^ERROR: contrôle « garde-fou » indisponible/);
    assert.equal(ran, 1);
  });

  it("un signal de contrôle traverse toujours", async () => {
    class AwaitingInputError extends Error { override name = "AwaitingInputError"; }
    const hooks = new HarnessHooks().onToolAfter("x", () => { throw new AwaitingInputError("?"); });
    await assert.rejects(hooks.wrapExecutor(async () => "ok")("t", {}), /\?/);
  });

  it("model.retry peut refuser une relance ou changer son délai ; run.idle : la première décision l'emporte", async () => {
    const hooks = new HarnessHooks()
      .onRetry("quota", (e) => (e.status === 429 && e.attempt >= 2 ? { retry: false } : undefined))
      .onRetry("délai", () => ({ delayMs: 50 }));
    assert.deepEqual(hooks.decideRetry({ attempt: 1, status: 503, error: "", delayMs: 500 }), { retry: true, delayMs: 50 });
    assert.equal(hooks.decideRetry({ attempt: 2, status: 429, error: "", delayMs: 500 }).retry, false);
    hooks.onIdle("rien", () => undefined).onIdle("attente", () => ({ wait: "2 sous-agents" })).onIdle("jamais", () => ({ wait: "x" }));
    assert.deepEqual(await hooks.runIdle({ runId: "r", finished: true, content: "" }), { wait: "2 sous-agents", by: "attente" });
  });
});

describe("diagnostic des erreurs d'outil", () => {
  const cases: Array<[string, string]> = [
    ["ERROR: arguments invalides pour send_email — « to » est obligatoire", "invalid_args"],
    ["ERROR: HTTP 401 Unauthorized: invalid api key", "auth"],
    ["ERROR: No connected account found for gmail — not connected", "not_connected"],
    ["ERROR: 403 Forbidden", "permission"],
    ["ERROR: HTTP 404 Not Found", "not_found"],
    ["ERROR: 429 Too Many Requests, retry after 3s", "rate_limit"],
    ["ERROR: « web_search » n'a pas répondu avant la fin du temps du tick", "timeout"],
    ["ERROR: fetch failed: getaddrinfo ENOTFOUND api.x.com", "network"],
    ["ERROR: HTTP 502 Bad Gateway", "server"],
    ["ERROR: Action bloquée par le guardrail « PII »", "guardrail"],
    ["ERROR: payment required (402): insufficient credits", "quota"],
    ["ERROR: quelque chose d'inédit s'est produit", "unknown"],
  ];
  for (const [text, cause] of cases) {
    it(`${cause} ← ${text.slice(7, 50)}`, () => {
      assert.equal(diagnoseToolError("t", { url: "https://x" }, text)?.cause, cause);
    });
  }

  it("un résultat qui n'est pas une erreur n'a pas de diagnostic", () => {
    assert.equal(diagnoseToolError("t", {}, "200 ok"), null);
  });

  it("le diagnostic s'ajoute à la fin, une seule fois, avec le schéma pour des arguments faux", () => {
    const schema = { type: "object", properties: { to: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } }, required: ["to"] };
    const d = diagnoseToolError("send_email", {}, "ERROR: arguments invalides pour send_email — « to » est obligatoire", schema)!;
    const once = withDiagnosis("ERROR: x", d);
    assert.match(once, /\[DIAGNOSTIC du harnais\] Cause probable : arguments invalides/);
    assert.match(once, /obligatoires : to: string/);
    assert.equal(withDiagnosis(once, d), once);
  });

  it("seule une lecture en échec passager est rejouée automatiquement", () => {
    const rate = makeDiagnosis("rate_limit", "web_search", {}, "rules");
    assert.equal(autoRetryDelayMs(rate, "429 retry after 3s", true), 3000);
    assert.equal(autoRetryDelayMs(rate, "429", false), null); // un appel à effet : jamais
    assert.equal(autoRetryDelayMs(makeDiagnosis("not_found", "t", {}, "rules"), "404", true), null);
    assert.equal(autoRetryDelayMs(rate, "retry after 120s", true), null); // trop long pour un tick
  });
});

describe("étapes du run (run-tool-hooks)", () => {
  const deps = (over: Partial<RunHookDeps> = {}): RunHookDeps => ({
    logEvent: async () => {}, searchSigs: {}, toolFails: {}, denials: { consecutive: 0, total: 0 }, toolErrors: {},
    research: { findings: [], recordFinding: async () => {}, probeMemory: async () => "", answerFromMemory: async () => "" },
    guardrails: [], judgeCtx: { admin: {} as never, workspaceId: "w" },
    recordGuardrailIncident: async () => {}, evalStub: () => null, evidence: () => ({ results: 0 }),
    rawExecutor: async () => "ok", isIdempotent: (n) => n === "web_search", schemaOf: () => undefined,
    deadlineAt: Date.now() + 60_000,
    stats: { diagnosed: 0, auto_retried: 0, auto_recovered: 0, by_cause: {} },
    ...over,
  });

  it("une même recherche, reformulée dans l'autre ordre, est refusée sans appel", async () => {
    assert.equal(querySig("web_search", { query: "McKinsey France effectif" }), querySig("web_search", { query: "effectif France mckinsey" }));
    let calls = 0;
    const d = deps();
    const exec = registerRunToolHooks(new HarnessHooks(), d).wrapExecutor(async () => { calls++; return "résultats du web, assez longs pour compter comme trouvaille"; });
    await exec("web_search", { query: "McKinsey France effectif" });
    const again = await exec("web_search", { query: "effectif France McKinsey" });
    assert.equal(calls, 1);
    assert.match(again, /recherche déjà effectuée/);
    assert.equal(d.toolFails.web_search, 0); // un refus de doublon n'est pas une panne
  });

  it("une lecture en panne passagère est rejouée et réussit ; le disjoncteur ne compte rien", async () => {
    let n = 0;
    const d = deps({ rawExecutor: async () => (++n === 1 ? "ERROR: HTTP 503 Service Unavailable" : "page lue") });
    const exec = registerRunToolHooks(new HarnessHooks(), d).wrapExecutor((name, args) => d.rawExecutor(name, args));
    assert.equal(await exec("web_search", { query: "x" }), "page lue");
    assert.equal(d.stats.auto_recovered, 1);
    assert.equal(d.toolFails.web_search, 0);
  });

  it("un envoi en échec n'est jamais rejoué ; il reçoit son diagnostic et entre au disjoncteur", async () => {
    let n = 0;
    const d = deps({ rawExecutor: async () => { n++; return "ERROR: HTTP 503 Service Unavailable"; } });
    const exec = registerRunToolHooks(new HarnessHooks(), d).wrapExecutor((name, args) => d.rawExecutor(name, args));
    const out = await exec("send_email", { to: "a@b.c" });
    assert.equal(n, 1);
    assert.match(out, /Cause probable : panne du service distant/);
    assert.equal(d.toolFails.send_email, 1);
    assert.equal(d.toolErrors.send_email.length, 1);
    assert.equal(d.toolErrors.send_email[0].cause, "server");
  });
});

describe("contrôleur : ajuster d'après la cause", () => {
  const base: LoopSignals = {
    finished: false, roundsUsed: 10, maxRounds: 100, costUsd: 0, maxCostUsd: 0, errorCount: 3,
    loopDetected: false, brokenTools: [], stagnantTicks: 0, replans: 0, maxReplans: 3,
  };

  it("le disjoncteur dit pourquoi l'outil échoue et quoi changer", () => {
    const d = decideNext({
      ...base, brokenTools: ["crm"],
      toolDiagnoses: [{ tool: "crm", label: "cible introuvable", needsHuman: false, transient: false, advice: "x", explanation: { cause: "L'id du contact est inventé.", fix: "Cherche le contact par e-mail avec crm(action=search) puis utilise son id.", giveUp: false } }],
    });
    const cb = d.interventions.find((i) => i.tag === "circuit_breaker")!;
    assert.match(cb.content, /L'id du contact est inventé\. → À FAIRE : Cherche le contact/);
    assert.equal(d.action, "continue");
  });

  it("un outil bloqué par un accès manquant : la question part tout de suite, sans changer de modèle", () => {
    const d = decideNext({
      ...base, brokenTools: ["gmail_send"],
      toolDiagnoses: [{ tool: "gmail_send", label: "application non connectée", needsHuman: true, transient: false, advice: "connecter" }],
    });
    assert.equal(d.action, "replan");
    assert.equal(d.escalateModel, false);
    assert.ok(d.interventions.some((i) => i.tag === "escalate_human"));
  });

  it("le flot d'erreurs donne les causes relevées", () => {
    const d = decideNext({ ...base, errorCount: 12, errorCauses: [{ label: "cible introuvable", count: 7 }, { label: "délai dépassé", count: 5 }] });
    assert.equal(d.action, "replan");
    assert.match(d.interventions.find((i) => i.tag === "replan")!.content, /cible introuvable ×7, délai dépassé ×5/);
  });
});

describe("contexte mesuré et point de situation", () => {
  const msgs = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(100) }) as ChatMessage);

  it("sans mesure : les caractères au taux pessimiste ; avec : la mesure plus le delta au taux mesuré", () => {
    const m = msgs(10);
    const chars = JSON.stringify(m).length;
    assert.equal(estimatePromptTokens(m), Math.ceil(chars / 3.4));
    const measure = { tokens: 5000, bodyChars: 20_000, msgChars: chars };
    assert.equal(estimatePromptTokens(m, measure), 5000);
    const more = [...m, ...msgs(10)];
    const delta = JSON.stringify(more).length - chars;
    assert.equal(estimatePromptTokens(more, measure), Math.round(5000 + delta * 0.25));
  });

  it("le point de situation se prépare à 60 % du seuil, puis seulement quand assez de neuf est arrivé", () => {
    assert.equal(shouldPrepareCheckpoint(5000, 10_000, null, 40), false);
    assert.equal(shouldPrepareCheckpoint(6500, 10_000, null, 40), true);
    const prev = { text: "## Exigences\n## Décisions\n## État du travail", covered: 35, at: "" };
    assert.equal(shouldPrepareCheckpoint(9000, 10_000, prev, 40), false);
    assert.equal(shouldPrepareCheckpoint(9000, 10_000, prev, 47), true);
  });

  it("un point hors gabarit n'entre jamais dans le segment scellé", () => {
    assert.equal(isValidCheckpoint("## Exigences\n- a\n## Décisions\n- b\n## État du travail\n- c"), true);
    assert.equal(checkpointBlock({ text: "résumé libre", covered: 3, at: "" }), "");
    assert.match(checkpointBlock({ text: "## Exigences\n## Décisions\n## État du travail", covered: 3, at: "" }), /Point de situation/);
  });

  it("le transcrit rendu au résumeur garde les appels et coupe les longs résultats", () => {
    const out = renderTranscript([
      { role: "system", content: "secret système" },
      { role: "user", content: "Fais le rapport Q3" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "query_table", arguments: '{"table":"deals"}' } }] },
      { role: "tool", tool_call_id: "a", content: "y".repeat(5000) },
    ]);
    assert.doesNotMatch(out, /secret système/);
    assert.match(out, /→ query_table\(\{"table":"deals"\}\)/);
    assert.ok(out.length < 1500);
  });
});

describe("classement des outils (Jev mêlé au lexical)", () => {
  const def = (name: string, description: string) => ({ type: "function" as const, function: { name, description, parameters: { type: "object", properties: {} } } });
  const toolbox = [
    def("web_search", "Search the web for a query"),
    def("hubspot_create_task", "Create a follow-up task on a HubSpot contact"),
    ...Array.from({ length: 20 }, (_, i) => def(`tool_${i}`, `Unrelated tool number ${i}`)),
  ];

  it("un jugement sûr fait passer l'outil utile devant, même sans mot commun", () => {
    const sel = (weight: number) => selectTools(toolbox, {
      task: "relance le client Acme", budget: 600, floorCount: 3,
      ranking: { probs: { hubspot_create_task: 0.8, web_search: 0.1 }, weight },
    }).defs.map((d) => d.function.name);
    assert.ok(sel(0.9).includes("hubspot_create_task"));
    // Poids nul : le lexical seul, comme avant.
    const lexical = selectTools(toolbox, { task: "relance le client Acme", budget: 600, floorCount: 3 }).defs.map((d) => d.function.name);
    assert.deepEqual(sel(0), lexical);
  });

  it("un classement se réutilise tant que l'étape ne change pas", () => {
    const r = { probs: { a: 0.6, b: 0.4 }, confidence: 0.8, taskHash: taskHashOf("étape 1"), at: Date.now() };
    assert.ok(reusableRanking(r, "étape 1"));
    assert.equal(reusableRanking(r, "étape 2"), null);
    assert.equal(reusableRanking({ ...r, at: Date.now() - 3_600_000 }, "étape 1"), null);
    assert.equal(Object.keys(compactRanking({ ...r, probs: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`t${i}`, i])) }).probs).length, 80);
  });
});

describe("couloirs, refus avec consigne, boîte de réception", () => {
  it("les couloirs : navigateur, monde d'exécution, état du run ; le reste libre", () => {
    assert.equal(toolLane("web_search"), null);
    assert.equal(toolLane("send_email"), null);
    assert.equal(toolLane("sandbox_browser"), "browser");
    assert.equal(toolLane("runner_shell_exec"), "exec:runner");
    assert.equal(toolLane("file_write"), "exec:local");
    assert.equal(toolLane("team_shell"), "exec:team");
    assert.equal(toolLane("report_section"), "run_state");
    assert.equal(isHumanPauseTool("ask_user"), true);
  });

  it("un refus avec consigne devient le résultat de l'outil", () => {
    assert.match(rejectionResult("Envoyer le devis"), /REFUSÉ l'action « Envoyer le devis »\. Ne la refais pas/);
    const out = rejectionResult("Envoyer le devis", "Mets Paul en copie et retire la remise de 15 %");
    assert.match(out, /avec cette consigne :\n« Mets Paul en copie et retire la remise de 15 % »/);
    assert.match(out, /Applique-la/);
  });

  it("un résultat de sous-agent devient un message <background-result>", () => {
    const m = inboxMessage({ id: "1", from_run_id: "run-9", kind: "background_result", label: "Concurrent \"A\"", status: "succeeded", content: "3 offres trouvées", created_at: "" });
    assert.equal(m, '<background-result kind="subagent" run_id="run-9" label="Concurrent \'A\'" status="succeeded">\n3 offres trouvées\n</background-result>');
    assert.match(inboxMessage({ id: "2", from_run_id: "p", kind: "follow_up", label: null, status: null, content: "Ajoute les prix", created_at: "" }), /^\[Message de l'agent qui t'a lancé/);
    assert.match(childBrief({ label: "A", brief: "Analyse A", acceptance: "3 sources" }), /## Sous-tâche : A\nAnalyse A\n\nC'est fini quand : 3 sources/);
    assert.match(spawnedNotice([{ runId: "r1", label: "A" }], []), /« A » → run_id r1[\s\S]*NE refais PAS leur travail/);
  });
});
