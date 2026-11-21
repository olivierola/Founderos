// Les applications connectées via Composio servent aux agents : une ligne
// d'outil maison (« slack » du coffre) passe par Composio quand l'application
// y est connectée, et les applications partagées sont exposées sans ligne.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildInternalToolset } = await import("../edge/_shared/internal-agent-tools.ts");

const baseCtx = {
  admin: {}, workspaceId: "ws-1", projectId: "p-1", agentId: "a-1", agentName: "Agent", runId: "r-1",
  requestApproval: async () => "", logEvent: async () => {}, isCancelled: async () => false,
};
const row = (kind: string, config: Record<string, unknown>) =>
  ({ id: `t-${kind}-${JSON.stringify(config)}`, kind, name: kind, description: null, config, enabled: true, requires_approval: false });

const toolsOf = (rows: unknown[], extra: Record<string, unknown>) => {
  const set = buildInternalToolset(rows as never, { ...baseCtx, ...extra } as never);
  return new Map((set.defs as Array<{ function: { name: string; description: string } }>).map((d) => [d.function.name, d.function.description]));
};

describe("applications Composio", () => {
  it("un connecteur maison dont l'application est connectée via Composio passe par Composio", () => {
    const tools = toolsOf([row("connector_action", { provider: "slack" }), row("connector_action", { provider: "teams" })], { composioApps: ["slack", "microsoft_teams"] });
    assert.match(tools.get("use_slack") ?? "", /via Composio/);
    assert.match(tools.get("use_microsoft_teams") ?? "", /via Composio/);
    assert.equal(tools.has("use_teams"), false);
  });

  it("sans connexion Composio, le connecteur maison reste", () => {
    const tools = toolsOf([row("connector_action", { provider: "slack" })], { composioApps: [] });
    assert.ok(tools.has("use_slack"));
    assert.doesNotMatch(tools.get("use_slack") ?? "", /via Composio/);
  });

  it("une application connectée est partagée avec l'agent même sans ligne d'outil — AGENT_SHARED_APPS=0 coupe", () => {
    assert.ok(toolsOf([], { composioApps: ["notion", "gmail"] }).has("use_gmail"));
    process.env.AGENT_SHARED_APPS = "0";
    try {
      assert.equal(toolsOf([], { composioApps: ["notion"] }).has("use_notion"), false);
    } finally {
      delete process.env.AGENT_SHARED_APPS;
    }
  });
});
