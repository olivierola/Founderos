// Les connecteurs maison dans les pools (0293), à l'exécution : ce que la
// portée ouvre, l'outil use_<app> limité aux actions données, et ce que
// l'agent en découvre.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  scopeFromItems, applyPoolToToolRows, allowedAppActions, allowsAppAction, workflowViolations, forgetPoolScope,
} = await import("../edge/_shared/resource-pools.ts");
const { buildInternalToolset } = await import("../edge/_shared/internal-agent-tools.ts");

const AGENT = "a-1";
const item = (id: string, kind: string, itemKey = "", status = "active", parent: string | null = null) => ({
  id, kind, source: "app_connector", source_id: "conn-slack", item_key: itemKey, parent_id: parent, name: itemKey || "Slack",
  description: itemKey === "post_message" ? "Poster un message" : null, risk: itemKey.startsWith("post") ? "write" : itemKey ? "read" : "unknown",
  status, metadata: { provider: "slack" },
});
const row = (kind: string, config: Record<string, unknown> = {}) =>
  ({ id: `row-${kind}-${JSON.stringify(config)}`, kind, name: kind, description: null, config, enabled: true, requires_approval: false });

const onlyRead = scopeFromItems(AGENT, [{ id: "p1", name: "Support" }], [item("r-list", "tool", "list_channels", "active", "r-slack")] as never);
const wholeApp = scopeFromItems(AGENT, [{ id: "p1", name: "Support" }], [item("r-slack", "toolset")] as never);
const legacy = scopeFromItems(AGENT, [{ id: "p1", name: "Ancien" }], [
  { id: "b", kind: "toolset", source: "builtin", source_id: "proj", item_key: "connector_action", status: "active", metadata: {} },
] as never);

describe("connecteurs maison : la portée", () => {
  it("une action donnée seule n'ouvre qu'elle ; l'app entière ouvre tout ; la famille d'avant 0293 reste une limite", () => {
    assert.deepEqual(allowedAppActions(onlyRead, "slack"), ["list_channels"]);
    assert.equal(allowsAppAction(onlyRead, "Slack", "LIST_CHANNELS"), true, "casse ignorée");
    assert.equal(allowsAppAction(onlyRead, "slack", "post_message"), false);
    assert.equal(allowedAppActions(wholeApp, "slack"), null);
    assert.deepEqual(allowedAppActions(wholeApp, "hubspot"), [], "une autre app n'est pas ouverte");
    assert.equal(allowedAppActions(legacy, "hubspot"), null, "pool d'avant : la ligne configurée de l'agent décide");
  });

  it("l'app des pools est synthétisée sans ligne ; une ligne d'une app absente tombe", () => {
    const out = applyPoolToToolRows([row("connector_action", { provider: "hubspot" })], wholeApp);
    assert.deepEqual(out.map((r) => [r.kind, r.config]), [["connector_action", { provider: "slack" }]]);
    const kept = applyPoolToToolRows([row("connector_action", { provider: "hubspot" })], legacy);
    assert.deepEqual(kept.map((r) => r.config), [{ provider: "hubspot" }], "pool d'avant : la ligne survit");
  });

  it("une automatisation qui appelle l'app en connecteur maison est couverte", () => {
    const refs = { agentIds: [], mcp: [], collectionIds: [], apps: [{ provider: "slack", action: "POST_MESSAGE" }] };
    const wf = { id: "wf-1", name: "Alerte" };
    const withWf = (s: typeof onlyRead) => ({ ...s, workflows: new Set(["wf-1"]) });
    assert.deepEqual(workflowViolations(withWf(wholeApp), wf, refs), []);
    assert.deepEqual(workflowViolations(withWf(onlyRead), wf, refs), ["il utilise POST_MESSAGE (slack), hors de ses pools"]);
    assert.deepEqual(workflowViolations(withWf(legacy), wf, refs), ["il utilise l'app « slack », absente de ses pools"],
      "un workflow nomme une app : le pool doit la nommer aussi");
  });
});

describe("connecteurs maison : l'outil de l'agent", () => {
  /** Un client réduit : les pools de l'agent et leur contenu. */
  const admin = {
    from(table: string) {
      const data = table === "agent_resource_pools" ? [{ pool_id: "p1", pool: { id: "p1", name: "Support" } }]
        : table === "resource_pool_items" ? [{ pool_id: "p1", registry: item("r-list", "tool", "list_channels", "active", "r-slack") }]
        : table === "resource_pools" ? [{ id: "p1", name: "Support", description: null }]
        : table === "resource_registry" ? [{ id: "r-slack", name: "Slack", source_id: "conn-slack", status: "active", metadata: { provider: "slack" } }]
        : [];
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, in: () => chain, neq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok),
      };
      return chain;
    },
  };
  const toolset = () => buildInternalToolset(applyPoolToToolRows([], onlyRead) as never, {
    admin, workspaceId: "ws-1", projectId: "proj", agentId: AGENT, agentName: "Agent", runId: "r-1",
    requestApproval: async () => "", logEvent: async () => {}, isCancelled: async () => false,
    poolScope: onlyRead,
  } as never);

  it("use_slack n'annonce que les actions des pools, et refuse les autres à l'appel", async () => {
    forgetPoolScope();
    const ts = toolset();
    const def = ts.defsFor("full").find((d) => d.function.name === "use_slack")!;
    const enumOf = ((def.function.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum);
    assert.deepEqual(enumOf, ["list_channels"]);
    assert.match(await ts.executor("use_slack", { action: "post_message", params: { text: "x" } }), /hors des ressources de cet agent/);
  });

  it("my_resources montre le connecteur, l'action donnée et son geste ; sa fiche en donne les paramètres", async () => {
    forgetPoolScope();
    const ts = toolset();
    const inv = await ts.executor("my_resources", {});
    assert.match(inv, /Connecteur « Slack »\n  - list_channels \[lecture\] → use_slack \(action="list_channels"\)/);
    const sheet = await ts.executor("my_resources", { id: "list_channels" });
    assert.match(sheet, /# Outil du connecteur « Slack » : list_channels/);
    assert.match(sheet, /Actions :\n- list_channels \[lecture\]/);
    assert.match(sheet, /Appelable dès maintenant : use_slack/);
  });
});
