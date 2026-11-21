// Les garde-fous du harness repris de superharness, hors de la boucle d'outils
// (elle a les siens dans tool-loop.test.ts) : le suivi des refus de
// garde-fous dans le contrôleur, le délai maximal d'un appel MCP, l'extrait
// d'un gros résultat conservé et les suggestions pour un outil inconnu.

import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { decideNext, DENIAL_LIMITS, type LoopSignals } from "../edge/_shared/agent-loop.ts";
import { TOOL_RESULT_CAP } from "../edge/_shared/ai.ts";
import { closestToolNames, persistedOutputNote, persistedPreview } from "../edge/_shared/internal-agent-tools.ts";
import { mcpCallTool } from "../edge/_shared/mcp-client.ts";

const signals = (over: Partial<LoopSignals> = {}): LoopSignals => ({
  finished: false, roundsUsed: 10, maxRounds: 100, costUsd: 0, maxCostUsd: 0,
  errorCount: 0, loopDetected: false, brokenTools: [], stagnantTicks: 0,
  replans: 0, maxReplans: 3, ...over,
});

describe("contrôleur : refus des garde-fous", () => {
  it("trois refus d'affilée : on continue, avec une consigne de ne pas contourner et de demander", () => {
    const d = decideNext(signals({ guardrailDenials: { consecutive: DENIAL_LIMITS.maxConsecutive, total: 3 } }));
    assert.equal(d.action, "continue");
    const iv = d.interventions.find((i) => i.tag === "guardrail_denials");
    assert.ok(iv, "consigne attendue");
    assert.match(iv!.content, /ask_user/);
  });

  it("deux refus d'affilée : rien encore", () => {
    const d = decideNext(signals({ guardrailDenials: { consecutive: 2, total: 2 } }));
    assert.equal(d.interventions.length, 0);
  });

  it("vingt refus sur le run : finalisation avec l'acquis", () => {
    const d = decideNext(signals({ guardrailDenials: { consecutive: 0, total: DENIAL_LIMITS.maxTotal } }));
    assert.equal(d.action, "finalize");
    assert.match(d.reason, /garde-fous/);
  });

  it("une réponse finale n'est jamais retenue par les refus passés", () => {
    const d = decideNext(signals({ finished: true, guardrailDenials: { consecutive: 5, total: 25 } }));
    assert.equal(d.action, "finalize");
    assert.equal(d.interventions.length, 0);
  });
});

// ── Délai maximal d'un appel MCP ────────────────────────────────────────────
// Un serveur qui répond à la poignée de main mais jamais à tools/call.
let mcpUrl = "";
const mcp: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const msg = raw ? JSON.parse(raw) : {};
    if (msg.method === "initialize") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Mcp-Session-Id", "s1");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
      return;
    }
    if (!msg.id) { res.statusCode = 202; res.end(); return; } // notification
    if (msg.params?.name === "slow") return; // ne répond jamais
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "x".repeat(30_000) }] } }));
  });
});
before(async () => { mcpUrl = `${await listen(mcp)}/mcp`; });
after(() => { mcp.closeAllConnections?.(); mcp.close(); });

describe("client MCP", () => {
  it("un tools/call sans réponse rend une erreur à l'échéance au lieu de rester suspendu", async () => {
    const t0 = Date.now();
    const out = await mcpCallTool(mcpUrl, {}, "slow", {}, undefined, { timeoutMs: 300 });
    assert.match(out, /^ERROR: le serveur MCP n'a pas répondu en 0 s/);
    assert.ok(Date.now() - t0 < 2_000);
  });

  it("le plafond de sortie est réglable (12 000 par défaut)", async () => {
    assert.equal((await mcpCallTool(mcpUrl, {}, "big", {})).length, 12_000);
    assert.equal((await mcpCallTool(mcpUrl, {}, "big", {}, undefined, { maxChars: 50_000 })).length, 30_000);
  });
});

// ── Gros résultats conservés ────────────────────────────────────────────────
describe("extrait d'un résultat conservé", () => {
  it("tient sous le plafond du transcrit, garde la tête et la queue, et donne la référence", () => {
    const full = `DÉBUT ${"a".repeat(50_000)} MILIEU ${"b".repeat(50_000)} FIN`;
    const out = persistedPreview(full, "out_abc");
    assert.ok(out.length <= TOOL_RESULT_CAP, `${out.length}`);
    assert.ok(out.startsWith("DÉBUT"));
    assert.ok(out.includes("FIN"));
    assert.ok(!out.includes("MILIEU"));
    assert.ok(out.endsWith(persistedOutputNote("out_abc", full.length)));
    assert.match(out, /read_tool_output\(ref="out_abc"/);
  });

  it("passe par le compresseur propre à l'outil quand il en a un", () => {
    const out = persistedPreview("ligne\n".repeat(5_000), "out_x", (r, max) => `résumé de ${r.length} car. (max ${max})`);
    assert.match(out, /^résumé de 30000 car\./);
  });
});

describe("outil inconnu", () => {
  it("propose les noms proches, préfixe de serveur oublié compris", () => {
    const known = ["web_search", "read_url", "mcp_github_create_issue", "create_deliverable", "update_todos"];
    assert.deepEqual(closestToolNames("web_serch", known).slice(0, 1), ["web_search"]);
    assert.ok(closestToolNames("create_issue", known).includes("mcp_github_create_issue"));
    assert.deepEqual(closestToolNames("zzzzzzzz", known), []);
  });
});
