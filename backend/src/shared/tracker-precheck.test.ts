import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTrackerParams, precheckTrackerAction } from "../edge/_shared/tracker-actions.ts";

// Un faux client : pj_issues répond le projet d'un work item connu.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: any = {
  from: (table: string) => ({
    select: () => ({
      eq: (_col: string, id: string) => ({
        maybeSingle: async () => ({ data: table === "pj_issues" && id === "issue-1" ? { pj_project_id: "proj-1" } : null }),
      }),
    }),
  }),
};

describe("suivi de travail : paramètres complétés et vérifiés avant approbation", () => {
  it("déduit le projet d'un work item, et lit `type` comme `kind`", async () => {
    const out = await normalizeTrackerParams(db, "create_asset", { issue_id: "issue-1", name: "Plan", type: "report" });
    assert.equal(out.project_id, "proj-1");
    assert.equal(out.kind, "report");
  });

  it("ne touche pas à un project_id donné, ni aux actions qui n'en ont pas besoin", async () => {
    assert.equal((await normalizeTrackerParams(db, "create_asset", { issue_id: "issue-1", project_id: "autre" })).project_id, "autre");
    assert.equal((await normalizeTrackerParams(db, "comment", { issue_id: "issue-1", body: "ok" })).project_id, undefined);
  });

  it("refuse avant approbation ce qui échouerait à coup sûr", () => {
    // Le cas réel : un livrable à rattacher, sans lien ni contenu.
    assert.match(precheckTrackerAction("create_asset", { project_id: "p", name: "Plan", description: "Rapport publié" })!, /url .* ou content/);
    assert.match(precheckTrackerAction("create_asset", { name: "Plan", url: "https://x" })!, /project_id/);
    assert.match(precheckTrackerAction("comment", { issue_id: "i" })!, /body/);
    assert.equal(precheckTrackerAction("create_asset", { project_id: "p", name: "Plan", url: "https://x" }), null);
    assert.equal(precheckTrackerAction("update_work_item", { issue_id: "i", state_group: "completed" }), null);
  });
});
