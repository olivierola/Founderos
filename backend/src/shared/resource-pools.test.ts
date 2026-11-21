// La passerelle de ressources à l'exécution (0291) : ce qu'un agent en mode
// pools atteint, et ce qui lui est refusé.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  scopeFromItems, applyPoolToToolRows, limitMcpServers, allowsComposioAction, allowedComposioActions,
  allowedCustomOperations, allowsPeer, workflowRefsOf, workflowViolations, loadPoolScope, forgetPoolScope,
  poolRefusal,
} = await import("../edge/_shared/resource-pools.ts");

const AGENT = "agent-a";
const item = (source: string, sourceId: string, kind = "toolset", itemKey = "", status = "active", metadata: Record<string, unknown> = {}) =>
  ({ id: `${source}:${sourceId}:${itemKey}`, kind, source, source_id: sourceId, item_key: itemKey, status, metadata });
const row = (kind: string, config: Record<string, unknown> = {}, enabled = true) =>
  ({ id: `row-${kind}-${JSON.stringify(config)}`, kind, name: kind, description: null, config, enabled, requires_approval: false });

const scope = scopeFromItems(AGENT, [{ id: "p1", name: "Support" }, { id: "p2", name: "Infra" }], [
  item("mcp", "srv-1", "tool", "pods_list"),
  item("mcp", "srv-1", "tool", "pods_logs"),
  item("mcp", "srv-2"),
  item("mcp", "srv-2", "tool", "sync_app"), // la source entière l'emporte
  item("mcp", "srv-3", "toolset", "", "unavailable"),
  item("composio", "conn-1", "toolset", "", "active", { toolkit: "GitHub" }),
  item("composio", "conn-2", "tool", "SLACK_SEND_MESSAGE", "active", { toolkit: "slack" }),
  item("custom_connector", "cc-1", "tool", "get_ticket"),
  item("custom_connector", "cc-2"),
  item("builtin", "proj", "toolset", "web_search"),
  item("builtin", "proj", "toolset", "db_read"),
  item("rag", "col-1", "knowledge"),
  item("skill", "sk-1", "skill"),
  item("guardrail", "g-1", "guardrail"),
  item("workflow", "wf-1", "procedure"),
  item("agent", "agent-b", "agent"),
  item("agent", AGENT, "agent"),
  item("agent", "agent-x", "agent", "", "removed"),
]);

describe("passerelle de ressources : l'union des pools", () => {
  it("additionne les pools ; une source entière l'emporte ; l'indisponible et soi-même n'ouvrent rien", () => {
    assert.deepEqual(scope.poolNames, ["Support", "Infra"]);
    assert.deepEqual([...(scope.mcp.get("srv-1") as Set<string>)].sort(), ["pods_list", "pods_logs"]);
    assert.equal(scope.mcp.get("srv-2"), "all");
    assert.equal(scope.mcp.has("srv-3"), false);
    assert.equal(scope.composio.get("github"), "all", "le toolkit est rangé en minuscules");
    assert.deepEqual([...scope.agents], ["agent-b"]);
    assert.ok(scope.skills.has("sk-1") && scope.guardrails.has("g-1") && scope.workflows.has("wf-1") && scope.knowledge.has("col-1"));
  });
});

describe("passerelle de ressources : les lignes d'outils", () => {
  it("garde ce que les pools couvrent, coupe le reste, et synthétise ce qu'ils donnent", () => {
    const out = applyPoolToToolRows([
      row("web_search"),
      row("crm"),                                   // pas dans les pools
      row("db_read", { tables: ["product_events"] }),
      row("composio_toolkit", { toolkit: "github" }),
      row("composio_toolkit", { toolkit: "notion" }), // pas dans les pools
      row("custom_connector", { connector_id: "cc-9" }),
      row("rag_search", { collection_ids: ["col-1", "col-2"] }),
      row("tracker", {}, false),                     // désactivée : ignorée
    ], scope);
    const keys = out.map((r) => `${r.kind}:${JSON.stringify(r.config)}`).sort();
    assert.deepEqual(keys, [
      'composio_toolkit:{"toolkit":"github"}',
      'composio_toolkit:{"toolkit":"slack"}',         // synthétisée
      'custom_connector:{"connector_id":"cc-1"}',      // synthétisée
      'custom_connector:{"connector_id":"cc-2"}',      // synthétisée
      'db_read:{"tables":["product_events"]}',         // limite du pool, config de l'agent
      'rag_search:{"collection_ids":["col-1"]}',       // intersection
      "web_search:{}",
    ].sort());
  });

  it("une famille qui exige une configuration n'est jamais synthétisée", () => {
    const out = applyPoolToToolRows([], scope);
    assert.ok(out.some((r) => r.kind === "web_search"));
    assert.ok(!out.some((r) => r.kind === "db_read"), "db_read sans tables ne s'invente pas");
    assert.deepEqual(out.find((r) => r.kind === "rag_search")?.config, { collection_ids: ["col-1"] });
  });
});

describe("passerelle de ressources : les portes", () => {
  it("MCP : seuls les serveurs des pools, limités à leurs outils", () => {
    const servers = [
      { id: "srv-1", tools: [{ name: "pods_list" }, { name: "deployment_restart" }] },
      { id: "srv-2", tools: [{ name: "sync_app" }, { name: "delete_app" }] },
      { id: "srv-4", tools: [{ name: "anything" }] },
    ];
    const out = limitMcpServers(servers, scope);
    assert.deepEqual(out.map((s) => [s.id, s.tools.map((t) => t.name)]), [
      ["srv-1", ["pods_list"]],
      ["srv-2", ["sync_app", "delete_app"]],
    ]);
  });

  it("Composio : toute l'app, ou les seules actions accordées", () => {
    assert.equal(allowsComposioAction(scope, "github", "github_create_an_issue"), true);
    assert.equal(allowsComposioAction(scope, "Slack", "slack_send_message"), true);
    assert.equal(allowsComposioAction(scope, "slack", "SLACK_DELETE_CHANNEL"), false);
    assert.equal(allowsComposioAction(scope, "notion", "NOTION_SEARCH"), false);
    assert.equal(allowedComposioActions(scope, "github"), null);
    assert.deepEqual(allowedComposioActions(scope, "slack"), ["SLACK_SEND_MESSAGE"]);
  });

  it("outils customisés : toutes les opérations, ou une sélection", () => {
    assert.equal(allowedCustomOperations(scope, "cc-2"), null);
    assert.deepEqual([...(allowedCustomOperations(scope, "cc-1") as Set<string>)], ["get_ticket"]);
    assert.equal(allowedCustomOperations(scope, "cc-9")?.size, 0);
  });

  it("A2A : seulement les collègues des pools", () => {
    assert.equal(allowsPeer(scope, "agent-b"), true);
    assert.equal(allowsPeer(scope, "agent-x"), false);
    assert.match(poolRefusal(scope, "solliciter « X »"), /pools : « Support », « Infra »/);
  });
});

describe("passerelle de ressources : les workflows", () => {
  const blocks = {
    nodes: [
      { id: "t", type: "trigger", data: {} },
      { id: "s", type: "step", data: { agent_id: "agent-b", refs: [{ kind: "collection", id: "col-2", label: "x" }] } },
      { id: "h", type: "handoff", data: { agent_ids: ["agent-c", "agent-b"] } },
      { id: "m", type: "tool", data: { tool: "mcp", mcp: [{ server_id: "srv-1", tools: ["pods_list", "deployment_restart"] }] } },
      { id: "a", type: "tool", data: { provider: "Slack", action: "slack_delete_channel" } },
    ],
  };

  it("lit ce qu'un graphe fait intervenir, comme la fonction SQL", () => {
    assert.deepEqual(workflowRefsOf(blocks), {
      agentIds: ["agent-b", "agent-c"],
      mcp: [{ server_id: "srv-1", tools: ["pods_list", "deployment_restart"] }],
      apps: [{ provider: "slack", action: "SLACK_DELETE_CHANNEL" }],
      collectionIds: ["col-2"],
    });
  });

  it("dit tout ce qui sortirait des pools, et d'abord le workflow lui-même", () => {
    assert.deepEqual(workflowViolations(scope, { id: "wf-9", name: "Autre" }, workflowRefsOf(blocks)),
      ["le workflow « Autre » n'est pas dans ses pools"]);
    const v = workflowViolations(scope, { id: "wf-1", name: "Incident" }, workflowRefsOf(blocks), {
      agents: new Map([["agent-c", "Cyrus"]]), servers: new Map([["srv-1", "openshift-prd"]]),
    });
    assert.deepEqual(v, [
      "il fait intervenir « Cyrus », absent de ses pools",
      "il utilise deployment_restart sur « openshift-prd », hors de ses pools",
      "il utilise SLACK_DELETE_CHANNEL (slack), hors de ses pools",
      "il consulte une collection (col-2) absente de ses pools",
    ]);
  });
});

describe("passerelle de ressources : la lecture", () => {
  /** Un client Supabase réduit à ce que loadPoolScope appelle. */
  const fakeAdmin = (tables: Record<string, { data?: unknown; error?: { message: string } | null }>) => ({
    from(table: string) {
      const res = tables[table] ?? { data: [], error: null };
      const chain = {
        select: () => chain, eq: () => chain, in: () => chain,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }).then(ok, ko),
      };
      return chain;
    },
  }) as never;

  it("sans pool : un scope VIDE, plus de mode granulaire (0310) ; sans la migration 0291 : null", async () => {
    forgetPoolScope();
    const none = await loadPoolScope(fakeAdmin({ agent_resource_pools: { data: [] } }), "a1");
    assert.ok(none);
    assert.deepEqual([none!.builtin.size, none!.mcp.size, none!.skills.size, none!.knowledge.size, none!.agents.size], [0, 0, 0, 0, 0]);
    assert.equal(await loadPoolScope(fakeAdmin({ agent_resource_pools: { error: { message: "relation does not exist" } } }), "a2"), null);
    // Une autre panne de lecture : accès fermé.
    const broken = await loadPoolScope(fakeAdmin({ agent_resource_pools: { error: { message: "timeout" } } }), "a5");
    assert.ok(broken && broken.builtin.size === 0);
  });

  it("des pools dont le contenu ne se lit pas : accès FERMÉ, pas grand ouvert", async () => {
    forgetPoolScope();
    const s = await loadPoolScope(fakeAdmin({
      agent_resource_pools: { data: [{ pool_id: "p1", pool: { id: "p1", name: "Support" } }] },
      resource_pool_items: { error: { message: "timeout" } },
    }), "a3");
    assert.ok(s);
    assert.deepEqual([s!.mcp.size, s!.builtin.size, s!.agents.size], [0, 0, 0]);
    assert.deepEqual(s!.poolNames, ["Support"]);
  });

  it("lit les jointures en objet comme en tableau", async () => {
    forgetPoolScope();
    const s = await loadPoolScope(fakeAdmin({
      agent_resource_pools: { data: [{ pool_id: "p1", pool: [{ id: "p1", name: "Support" }] }] },
      resource_pool_items: { data: [{ registry: item("builtin", "proj", "toolset", "web_search") }, { registry: [item("agent", "agent-b", "agent")] }] },
    }), "a4");
    assert.deepEqual([...s!.builtin], ["web_search"]);
    assert.deepEqual([...s!.agents], ["agent-b"]);
  });
});
