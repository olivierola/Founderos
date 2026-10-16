// CRM masqué (12/10/2026) : sans CRM_ENABLED=1, rien ne sollicite plus le CRM
// côté serveur — ni la fonction crm-action, ni l'outil crm des agents, ni la
// lecture de tables crm_* par query_table.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { crmEnabled, isCrmTable } = await import("../edge/_shared/crm-switch.ts");
const { buildInternalToolset } = await import("../edge/_shared/internal-agent-tools.ts");

const ctx = {
  admin: {}, workspaceId: "ws-1", projectId: "p-1", agentId: "a-1", agentName: "Agent", runId: "r-1",
  requestApproval: async () => "", logEvent: async () => {}, isCancelled: async () => false,
} as never;
const rows = [
  { id: "t1", kind: "crm", name: "CRM", description: null, config: {}, enabled: true, requires_approval: false },
  { id: "t2", kind: "db_read", name: "Lecture", description: null, config: { tables: ["crm_records", "product_events"] }, enabled: true, requires_approval: false },
] as never;

/** Les outils annoncés à l'agent : nom et description. */
const defsOf = () => (buildInternalToolset(rows, ctx).defs as Array<{ function: { name: string; description: string } }>)
  .map((d) => ({ name: d.function.name, description: d.function.description }));

describe("interrupteur du CRM", () => {
  it("éteint par défaut ; une table crm_* est reconnue", () => {
    delete process.env.CRM_ENABLED;
    assert.equal(crmEnabled(), false);
    assert.equal(isCrmTable("crm_records"), true);
    assert.equal(isCrmTable("product_events"), false);
  });

  it("éteint : ni outil crm, ni table crm_* dans query_table, même si l'agent les a reçus", () => {
    delete process.env.CRM_ENABLED;
    const tools = defsOf();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("crm"), names.join(", "));
    const query = tools.find((t) => t.name === "query_table")!;
    assert.match(query.description, /Allowed tables: product_events\./);
  });

  it("rallumé (CRM_ENABLED=1) : l'outil et la table reviennent", () => {
    process.env.CRM_ENABLED = "1";
    const tools = defsOf();
    delete process.env.CRM_ENABLED;
    assert.ok(tools.some((t) => t.name === "crm"));
    assert.match(tools.find((t) => t.name === "query_table")!.description, /crm_records, product_events/);
  });
});
