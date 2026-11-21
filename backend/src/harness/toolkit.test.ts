// L'outillage par lots (docs/harness-opencode/03) : les outils regroupés, le
// contexte en deux temps, les lots ouverts un à un, les spécialistes.

import "../test-env.ts";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { modelForRoute, type AgentProfile } from "./agent-profile.ts";
import { agentPlugin, newAgentState } from "./agent-plugin.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { startChatTurn, type AgentSupport } from "./chat.ts";
import { createHarness, type Harness } from "./host.ts";
import type { HarnessAgent } from "./store.ts";
import { memoryStore, startFakeLlm, type FakeLlm } from "./testing.ts";
import { buildKitTools, uncovered, type LegacyDef, type LegacyToolset } from "./toolkit/catalogue.ts";
import { buildContext, contextPage, newContextState, pinnedBlock, splitPieces } from "./toolkit/context.ts";
import type { Kit } from "./toolkit/plugin.ts";

// ── Un ancien jeu d'outils factice ──

const def = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): LegacyDef => ({
  name, description, parameters: { type: "object", properties, required, additionalProperties: false },
});

const DEFS: LegacyDef[] = [
  def("web_search", "Search the web. Returns results.", { query: { type: "string" }, max_results: { type: "number" } }, ["query"]),
  def("read_url", "Read a web page as markdown.", { url: { type: "string" } }, ["url"]),
  def("search_memory", "Search your memory.", { query: { type: "string" } }, ["query"]),
  def("search_knowledge", "Search the knowledge base.", { query: { type: "string" }, limit: { type: "number" } }, ["query"]),
  def("save_memory", "Save a memory.", { content: { type: "string" }, importance: { type: "number" } }, ["content"]),
  def("remember_preference", "Remember a preference.", { text: { type: "string" }, topic: { type: "string" } }, ["text"]),
  def("create_artifact", "Create an artifact document.", { title: { type: "string" }, content: { type: "string" } }, ["title"]),
  def("list_artifacts", "List artifacts.", { query: { type: "string" }, limit: { type: "number" } }),
  def("crm", "Read and write CRM records.", { action: { type: "string" }, record: { type: "object" } }, ["action"]),
  def("mcp_slack_post_message", "Post a message on Slack.", { channel: { type: "string" }, text: { type: "string" } }, ["channel", "text"]),
  def("tracker", "Work items tracker.", { action: { type: "string" } }, ["action"]),
  def("load_toolset", "Load a family."),
  def("brand_new_tool", "A tool nobody mapped yet."),
];

function fakeLegacy(results: Record<string, string> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const legacy: LegacyToolset = {
    defs: DEFS,
    run: async (name, args) => {
      calls.push({ name, args });
      return results[name] ?? `ok ${name}`;
    },
  };
  return { legacy, calls };
}

describe("catalogue regroupé", () => {
  const { legacy, calls } = fakeLegacy();
  const tools = buildKitTools(legacy);
  const byName = new Map(tools.map((t) => [t.name, t]));
  beforeEach(() => { calls.length = 0; });

  it("un outil par famille, ses actions limitées à ce que l'agent a", () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), ["apps", "document", "tracker", "web"]);
    const web = byName.get("web")!;
    assert.deepEqual((web.input as any).properties.action.enum, ["search", "read"]);
    assert.deepEqual((byName.get("document")!.input as any).properties.action.enum, ["create", "list"]);
    assert.match(web.description, /- search : Search the web\. Requis : query\./);
  });

  it("une action appelle l'ancien outil avec ses arguments ; un argument requis manquant est refusé", async () => {
    assert.equal(await byName.get("web")!.run({ action: "search", query: "acme" }), "ok web_search");
    assert.deepEqual(calls[0], { name: "web_search", args: { query: "acme" } });
    assert.match(await byName.get("web")!.run({ action: "read" }), /demande : url/);
    assert.match(await byName.get("web")!.run({ action: "fly" }), /inconnu/);
  });

  it("les applications passent par un seul outil : lister, décrire, appeler", async () => {
    const apps = byName.get("apps")!;
    const list = await apps.run({ action: "list" });
    assert.match(list, /crm/);
    assert.match(list, /mcp_slack_post_message/);
    assert.match(await apps.run({ action: "describe", app: "mcp_slack_post_message" }), /"channel"/);
    assert.match(await apps.run({ action: "call", app: "mcp_slack_post_message", params: { channel: "#ops" } }), /demande : text/);
    await apps.run({ action: "call", app: "mcp_slack_post_message", params: { channel: "#ops", text: "hello" } });
    assert.deepEqual(calls.at(-1), { name: "mcp_slack_post_message", args: { channel: "#ops", text: "hello" } });
  });

  it("un ancien outil qu'aucun outil ne sert est signalé ; les retirés ne le sont pas", () => {
    assert.deepEqual(uncovered(legacy), ["brand_new_tool"]);
  });
});

describe("build_context et context_page", () => {
  const long = Array.from({ length: 30 }, (_, i) => `${i + 1}. Passage ${i + 1} : ${"détail ".repeat(60)}`).join("\n");

  it("découpe un résultat par entrées", () => {
    const parts = splitPieces("1. Un\n2. Deux\n\n3. Trois", 12);
    assert.ok(parts.length >= 2);
    assert.ok(parts.join("\n").includes("Trois"));
  });

  it("court : le texte directement, chaque morceau dans la balise de son type", async () => {
    const { legacy, calls } = fakeLegacy({ search_memory: "- Le client Acme préfère le vouvoiement.", search_knowledge: "No results found." });
    const state = newContextState();
    const out = await buildContext(legacy, state, { query: "Acme", types: ["memory", "documents"] });
    assert.match(out, /<memory id="c1" source="search_memory">\n- Le client Acme préfère le vouvoiement\.\n<\/memory>/);
    assert.match(out, /<documents count="0">rien trouvé<\/documents>/);
    // Seuls les arguments que l'ancien outil déclare lui sont passés.
    assert.deepEqual(calls.find((c) => c.name === "search_memory")?.args, { query: "Acme" });
  });

  it("long : un index, puis les morceaux à la demande, par page, et ceux qu'on garde", async () => {
    const { legacy } = fakeLegacy({ search_knowledge: long });
    const state = newContextState();
    const index = await buildContext(legacy, state, { query: "x", types: ["documents"] });
    assert.match(index, /<documents count="\d+">\n\[c1\] Passage 1/);
    // L'index n'est pas le texte : un titre par morceau.
    assert.ok(index.length < long.length / 2, `index de ${index.length} car.`);
    const page1 = contextPage(state, { type: "documents", page: 1 });
    assert.match(page1, /<documents id="c1" source="search_knowledge">/);
    assert.match(page1, /suite : context_page\(type="documents", page=2\)/);
    const one = contextPage(state, { ids: ["c2"], keep: ["c2"] });
    assert.match(one, /<documents id="c2"/);
    assert.match(one, /gardés : c2/);
    assert.match(pinnedBlock(state)!, /<working_context>[\s\S]*<documents id="c2"/);
    contextPage(state, { drop: ["c2"] });
    assert.equal(pinnedBlock(state), null);
  });

  it("un type inconnu ou absent chez l'agent est refusé avec la liste", async () => {
    const { legacy } = fakeLegacy();
    assert.match(await buildContext(legacy, newContextState(), { query: "x", types: ["team"] }), /indisponible.*team[\s\S]*Valeurs : memory, documents, artifacts/);
  });
});

// ── Dans OpenCode ──

const AGENT: HarnessAgent = { id: "agent-kit", name: "Kit", workspace_id: "ws", project_id: "pj", harness: "opencode" };
const SYSTEM_BASE = "Tu es Kit, agent FounderOS.";

describe("l'outillage dans OpenCode", () => {
  let llm: FakeLlm;
  let dir: string;
  let host: Harness;
  let bridge: Bridge;
  let mem: ReturnType<typeof memoryStore>;
  let agents: AgentSupport;
  const fake = fakeLegacy({ web_search: "1. Acme lève 10 M€ (lesechos.fr)", search_memory: "- Acme : contact Léa Martin." });

  const toolNames = (body: Record<string, any>) => (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
  const systemOf = (body: Record<string, any>) =>
    (body.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === "system").map((m) => JSON.stringify(m.content)).join("\n");

  before(async () => {
    llm = await startFakeLlm();
    dir = await mkdtemp(path.join(os.tmpdir(), "founderos-kit-"));
    const state = newAgentState();
    const { BUILTIN_CAPABILITIES } = await import("./agent-profile.ts");
    const load = async (): Promise<AgentProfile> => ({
      agent: { id: AGENT.id, name: AGENT.name, workspace_id: "ws", project_id: "pj" } as AgentProfile["agent"],
      system: `${SYSTEM_BASE}\n## Capacités\n${BUILTIN_CAPABILITIES}`,
      steps: 40,
      connection: { baseURL: llm.baseUrl, apiKey: "k", headers: {}, openrouter: false, source: "platform" },
      routes: { light: "m-light", standard: "m-std" },
    });
    const kit: Kit = {
      agentName: AGENT.name, isOrchestrator: false, legacy: fake.legacy,
      skills: [
        { slug: "veille-marche", name: "Veille marché", description: "Méthode de veille", category: "research", instructions: "Lis trois sources." },
        { slug: "charte-redaction", name: "Charte de rédaction", description: "Le ton maison", category: "writing", instructions: "Phrases courtes." },
      ],
    };
    agents = {
      state, load,
      choose: async (p) => ({ model: modelForRoute(p, "standard"), tier: "standard", need: null }),
    };
    host = await createHarness({
      dataDir: dir,
      instances: {
        key: (session: { metadata?: unknown }) => String((session.metadata as { agent_id?: string } | undefined)?.agent_id ?? "default"),
        configure: (key: string) => ({
          plugins: key === "default" ? [] : [agentPlugin(key, load, state, { kit: async () => kit, skillsDir: path.join(dir, "skills") })],
        }),
      },
    });
    mem = memoryStore({ agents: [AGENT], conversations: [{ id: "conv", agentId: AGENT.id }], messages: [] });
    bridge = startBridge(host.opencode, mem.store, { liveIntervalMs: 10, cancelPollMs: 100 });
  });
  after(async () => {
    await bridge?.stop();
    await host?.close();
    await llm?.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  beforeEach(() => { llm.requests.length = 0; llm.annex.length = 0; llm.responder = undefined; fake.calls.length = 0; });

  const turn = async (text: string) => {
    mem.messages.push({ conversationId: "conv", role: "user", content: text });
    const out = await startChatTurn({ harness: host, store: mem.store, bridge, agents }, { agent: AGENT, conversationId: "conv", model: null });
    await bridge.settled(mem.conversations[0].sessionId!);
    return out;
  };

  it("au départ, le noyau seul ; un lot ouvert montre ses outils, avec leur vrai schéma, puis s'en sert", async () => {
    llm.script = [
      { tools: [{ id: "o1", name: "open_lot", args: { lot: "web" } }] },
      { tools: [{ id: "w1", name: "web", args: { action: "search", query: "Acme levée" } }] },
      { text: "Acme a levé 10 M€." },
    ];
    await turn("Que sait-on de la levée d'Acme ?");
    const [first, second] = llm.requests;
    assert.deepEqual(toolNames(first), ["build_context", "context_page", "open_lot", "question", "remember", "skill", "subagent", "todowrite"]);
    assert.ok(toolNames(second).includes("web"), toolNames(second).join(", "));
    assert.ok(!toolNames(second).includes("read"), "le lot fichiers reste fermé");
    const web = (second.tools as Array<{ function: { name: string; parameters: any } }>).find((t) => t.function.name === "web")!;
    assert.deepEqual(web.function.parameters.properties.action.enum, ["search", "read"]);
    assert.deepEqual(fake.calls, [{ name: "web_search", args: { query: "Acme levée" } }]);
    // Le prompt décrit les lots à la place de l'ancien texte de capacités.
    const system = systemOf(first);
    assert.match(system, /open_lot : ouvrir un lot d'outils/);
    assert.doesNotMatch(system, /webfetch, websearch : lire une page web/);
  });

  it("ouvrir un autre lot ferme le premier", async () => {
    llm.script = [
      { tools: [{ id: "o2", name: "open_lot", args: { lot: "livrables" } }] },
      { text: "Prêt." },
    ];
    await turn("Prépare un document.");
    const names = toolNames(llm.requests[1]);
    assert.ok(names.includes("document"));
    assert.ok(!names.includes("web"));
  });

  it("build_context rend le contexte balisé ; ce qu'on garde revient à chaque requête", async () => {
    llm.script = [
      { tools: [{ id: "b1", name: "build_context", args: { query: "Acme", types: ["memory"] } }] },
      { tools: [{ id: "p1", name: "context_page", args: { keep: ["c1"] } }] },
      { text: "Noté." },
    ];
    await turn("Qui est le contact chez Acme ?");
    const toolResult = JSON.stringify(llm.requests[1].messages);
    assert.match(toolResult, /<memory id=\\"c\d+\\" source=\\"search_memory\\">/);
    assert.match(systemOf(llm.requests[2]), /<working_context>[\s\S]*Léa Martin/);
  });

  it("un spécialiste ne voit que ses instructions, ses outils et ses skills", async () => {
    llm.responder = (body) => {
      const system = systemOf(body);
      if (!/Tu es un chercheur/.test(system)) return undefined;
      return JSON.stringify(body.messages).includes("tool") && JSON.stringify(body.messages).includes("web_search")
        ? { text: "Compte rendu : Acme a levé 10 M€." }
        : { tools: [{ id: "cw1", name: "web", args: { action: "search", query: "Acme" } }] };
    };
    llm.script = [
      { tools: [{ id: "s1", name: "subagent", args: { agent: "chercheur", description: "Levée Acme", prompt: "Trouve le montant de la levée d'Acme." } }] },
      { text: "J'ai lancé la recherche." },
      { text: "Acme a levé 10 M€." },
    ];
    await turn("Lance une recherche sur Acme.");
    // Laisse au spécialiste le temps de finir en arrière-plan.
    const end = Date.now() + 15_000;
    while (Date.now() < end && !fake.calls.some((c) => c.name === "web_search")) await new Promise((r) => setTimeout(r, 100));
    const child = llm.requests.find((b) => /Tu es un chercheur/.test(systemOf(b)));
    assert.ok(child, "le spécialiste a fait une requête");
    assert.deepEqual(toolNames(child!), ["build_context", "context_page", "skill", "todowrite", "web"]);
    const system = systemOf(child!);
    assert.doesNotMatch(system, /Tu es Kit, agent FounderOS/);
    assert.match(system, /veille-marche/);
    assert.doesNotMatch(system, /charte-redaction/);
    assert.ok(fake.calls.some((c) => c.name === "web_search"));
  });
});
