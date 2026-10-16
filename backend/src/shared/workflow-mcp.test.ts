// Workflows et serveurs MCP : une étape s'appuie sur un ou plusieurs serveurs,
// avec tous leurs outils ou une sélection. Le playbook cite les outils sous le
// nom que l'agent appelle ; le run de la procédure reçoit ces serveurs, limités
// aux outils choisis ; une automatisation appelle elle-même UN outil.

import "../test-env.ts";

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { memoryDb } from "../test-memory-db.ts";

const doc = await import("../edge/_shared/workflow-doc.ts");
const { parseMcpGrants, validateMcpGrants, loadRunMcpServers } = await import("../edge/_shared/mcp-servers.ts");
const { runAutomation } = await import("../edge/_shared/automation-engine.ts");

const PRD = "11111111-1111-4111-8111-111111111111";
const HUB = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const toolBlock = (id: string, mcp: unknown[], extra: Record<string, unknown> = {}) => ({
  id, type: "tool", position: { x: 0, y: 0 }, data: { ...doc.BLOCK_DOC.tool.defaults, tool: "mcp", mcp, ...extra },
});

describe("bloc Outil : serveurs MCP", () => {
  it("la sélection est nettoyée : un serveur une fois, des noms d'outils plausibles, rien hors mode MCP", () => {
    const sel = doc.mcpSelectionsOf({
      tool: "mcp",
      mcp: [
        { server_id: PRD, server_name: "mcp-prd", tools: ["pods_list", "pods_list", "../etc", "pod_logs"] },
        { server_id: PRD, server_name: "doublon", tools: [] },
        { server_id: "", server_name: "sans id" },
      ],
    });
    assert.deepEqual(sel, [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list", "pod_logs"] }]);
    assert.deepEqual(doc.mcpSelectionsOf({ tool: "web_search", mcp: [{ server_id: PRD, server_name: "x", tools: [] }] }), []);
  });

  it("l'union d'un workflow : par serveur, « tous ses outils » l'emporte sur une sélection", () => {
    const graph = {
      nodes: [
        toolBlock("t1", [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list"] }]),
        toolBlock("t2", [{ server_id: PRD, server_name: "mcp-prd", tools: ["pod_logs"] }, { server_id: HUB, server_name: "mcp-hub", tools: ["alerts_list"] }]),
        toolBlock("t3", [{ server_id: HUB, server_name: "mcp-hub", tools: [] }]),
        { id: "s1", type: "step", data: { label: "Diagnostiquer" } },
      ],
      edges: [],
    };
    assert.deepEqual(doc.mcpGrantsOf(graph), [
      { server_id: PRD, tools: ["pod_logs", "pods_list"] },
      { server_id: HUB, tools: [] },
    ]);
  });

  it("le playbook cite chaque outil sous le nom que l'agent appelle ; un outil unique avec paramètres est un appel exact", () => {
    const multi = doc.toolCall({ tool: "mcp", mcp: [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list", "pod_logs"] }, { server_id: HUB, server_name: "mcp-hub", tools: [] }] });
    assert.equal(multi.isAction, false);
    assert.match(multi.text, /serveur MCP « mcp-prd » : `mcp_mcp_prd_pods_list`, `mcp_mcp_prd_pod_logs`/);
    assert.match(multi.text, /serveur MCP « mcp-hub » : tous ses outils \(`mcp_mcp_hub_\*`\)/);
    const exact = doc.toolCall({ tool: "mcp", mcp: [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list"] }], args: { namespace: "app-a", vide: "" } });
    assert.deepEqual(exact, { text: '`mcp_mcp_prd_pods_list` avec {"namespace":"app-a"}', isAction: true });
    // Le même nom que celui que construit internal-agent-tools pour l'agent.
    assert.equal(doc.mcpToolName("MCP PRD!", "pods_list"), "mcp_mcp_prd_pods_list");
  });

  it("attaché à une étape, le bloc est imprimé DANS l'étape", () => {
    const graph = {
      nodes: [
        { id: "trig", type: "trigger", data: { label: "Déclencheur", mode: "manual" } },
        { id: "s1", type: "step", data: { label: "Diagnostiquer l'API", body: "Regarde l'état des pods." } },
        toolBlock("t1", [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list"] }]),
      ],
      edges: [
        { id: "e1", source: "trig", target: "s1" },
        { id: "a1", source: "t1", target: "s1", sourceHandle: doc.APPLIES_HANDLE, targetHandle: doc.ATTACH_HANDLE },
      ],
    };
    const md = doc.compileWorkflow({ name: "Incident API" }, graph);
    const step = md.slice(md.indexOf("Diagnostiquer l'API"));
    assert.match(step, /Outil imposé :\*\* serveur MCP « mcp-prd » : `mcp_mcp_prd_pods_list`/);
  });
});

describe("accès MCP accordés au run", () => {
  it("une valeur illisible n'accorde rien ; au plus 20 serveurs, des noms d'outils plausibles", () => {
    assert.deepEqual(parseMcpGrants("tout"), []);
    assert.deepEqual(parseMcpGrants([{ server_id: "pas-un-uuid" }, { server_id: PRD, tools: ["ok_tool", "pas bon", 3] }]), [{ server_id: PRD, tools: ["ok_tool"] }]);
  });

  it("seuls les serveurs activés de l'espace du workflow sont accordés", async () => {
    const { admin } = memoryDb({
      mcp_servers: [
        { id: PRD, workspace_id: "ws-1", enabled: true },
        { id: HUB, workspace_id: "ws-1", enabled: false },
        { id: OTHER, workspace_id: "ws-2", enabled: true },
      ],
    });
    const out = await validateMcpGrants(admin as never, "ws-1", [{ server_id: PRD, tools: [] }, { server_id: HUB, tools: [] }, { server_id: OTHER, tools: [] }]);
    assert.deepEqual(out, [{ server_id: PRD, tools: [] }]);
  });

  it("le run voit ses serveurs activés en entier, les serveurs accordés limités aux outils choisis, rien d'un autre espace", async () => {
    const server = (id: string, ws: string, name: string, tools: string[]) => ({
      id, workspace_id: ws, name, url: `https://${name}.interne.exemple/mcp`, enabled: true, auth_mode: "none",
      auth_config: {}, oauth: null, relay_id: null, environment: null, cached_tools: tools.map((t) => ({ name: t })),
    });
    const hub = server(HUB, "ws-1", "mcp-hub", ["alerts_list", "metrics_query"]);
    const prd = server(PRD, "ws-1", "mcp-prd", ["pods_list", "pod_logs", "deployment_restart"]);
    const other = server(OTHER, "ws-2", "mcp-ailleurs", ["pods_list"]);
    const { admin } = memoryDb({
      internal_agents: [{ id: "agent-1", workspace_id: "ws-1" }],
      // Les lignes de liaison arrivent déjà jointes (la base en mémoire ne résout pas les relations).
      agent_mcp_servers: [{ agent_id: "agent-1", server: hub }],
      mcp_servers: [hub, prd, other],
      internal_agent_runs: [{ id: "run-1", mcp_grants: [{ server_id: PRD, tools: ["pods_list", "pod_logs"] }, { server_id: HUB, tools: ["alerts_list"] }, { server_id: OTHER, tools: [] }] }],
      mcp_server_headers: [], mcp_server_secrets: [],
    });
    const loaded = await loadRunMcpServers(admin as never, "agent-1", "run-1");
    const byName = Object.fromEntries(loaded.map((s) => [s.name, s.tools.map((t) => t.name)]));
    assert.deepEqual(byName, {
      "mcp-hub": ["alerts_list", "metrics_query"], // activé : l'accès complet de l'activation
      "mcp-prd": ["pods_list", "pod_logs"],         // accordé : seulement la sélection, jamais deployment_restart
    });
    assert.deepEqual((await loadRunMcpServers(admin as never, "agent-1", null)).map((s) => s.name), ["mcp-hub"]);
  });
});

describe("automatisation : un outil MCP appelé par le moteur", () => {
  let server: ReturnType<typeof createServer>;
  let url = "";
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let answer: (params: Record<string, unknown>) => unknown = () => ({ content: [{ type: "text", text: '{"pods":2}' }] });

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}") as { id?: number; method: string; params?: Record<string, unknown> };
        calls.push({ method: msg.method, params: msg.params });
        if (msg.id === undefined) { res.writeHead(202).end(); return; }
        const result = msg.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "faux", version: "1" } }
          : answer(msg.params ?? {});
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const db = () => memoryDb({
    mcp_servers: [{
      id: PRD, workspace_id: "ws-1", name: "mcp-prd", url, enabled: true, auth_mode: "none", auth_config: {},
      oauth: null, relay_id: null, environment: "prd", cached_tools: [{ name: "pods_list" }, { name: "pod_logs" }],
    }],
    mcp_server_headers: [], mcp_server_secrets: [], agent_workflow_run_steps: [],
  });
  const flow = (tool: Record<string, unknown>) => ({
    nodes: [
      { id: "trig", type: "trigger", data: { label: "Déclencheur", mode: "manual" } },
      { id: "t1", ...tool },
    ],
    edges: [{ id: "e1", source: "trig", target: "t1" }],
  });
  const run = (admin: unknown, blocks: unknown, payload: Record<string, unknown> = {}) => runAutomation(admin as never, {
    runId: "wfrun-1", workflow: { id: "wf-1", workspace_id: "ws-1", project_id: "p-1", blocks: blocks as never }, payload,
  });

  it("UN outil d'UN serveur : appelé avec ses paramètres résolus, résultat rangé sous sa variable", async () => {
    const { admin, tables } = db();
    const block = toolBlock("t1", [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list"] }], { args: { namespace: "{{trigger.ns}}" }, output_var: "pods" });
    const out = await run(admin, flow(block), { ns: "app-a" });
    assert.equal(out.status, "succeeded", out.error);
    const call = calls.find((c) => c.method === "tools/call")!;
    assert.deepEqual(call.params, { name: "pods_list", arguments: { namespace: "app-a" } });
    const step = tables.agent_workflow_run_steps[0];
    assert.equal(step.status, "succeeded");
    assert.deepEqual(step.input, { mcp_server: "mcp-prd", tool: "pods_list", params: { namespace: "app-a" }, variable: "pods" });
  });

  it("un jeu d'outils ne s'exécute pas sans agent : l'étape échoue avec la consigne", async () => {
    const { admin } = db();
    const out = await run(admin, flow(toolBlock("t1", [{ server_id: PRD, server_name: "mcp-prd", tools: [] }])));
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /UN outil d'UN serveur MCP/);
  });

  it("une écriture soumise à approbation échoue : personne ne peut la valider dans une automatisation", async () => {
    const { admin } = db();
    answer = () => ({ content: [{ type: "text", text: JSON.stringify({ error: "approval_required", tool: "pods_list", target_cluster: "prd", params_hash: "a".repeat(64) }) }], isError: true });
    const out = await run(admin, flow(toolBlock("t1", [{ server_id: PRD, server_name: "mcp-prd", tools: ["pods_list"] }])));
    answer = () => ({ content: [{ type: "text", text: '{"pods":2}' }] });
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /soumise à approbation/);
  });

  it("un outil que le serveur n'expose pas est refusé avant tout appel", async () => {
    const { admin } = db();
    const before = calls.length;
    const out = await run(admin, flow(toolBlock("t1", [{ server_id: PRD, server_name: "mcp-prd", tools: ["deployment_restart"] }])));
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /n'est pas exposé par mcp-prd/);
    assert.equal(calls.length, before);
  });
});
