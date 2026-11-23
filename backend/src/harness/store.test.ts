// Ce qui déclenche un run, dans les valeurs que la base accepte (0268) : sans
// cette conversion, un run de collègue (a2a) ou de salle créé par le harnais
// était refusé par la contrainte internal_agent_runs_triggered_via_check.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triggeredVia } from "./store.ts";

describe("triggeredVia", () => {
  it("garde les valeurs acceptées par la base", () => {
    for (const v of ["manual", "schedule", "api", "chat", "event"]) assert.equal(triggeredVia(v), v);
  });
  it("range salle, workflow, collègue et mission parmi les événements", () => {
    for (const v of ["a2a", "room", "workflow", "mission", "trigger"]) assert.equal(triggeredVia(v), "event");
  });
  it("le reste devient « manual »", () => {
    assert.equal(triggeredVia("scheduler"), "schedule");
    assert.equal(triggeredVia(undefined), "manual");
    assert.equal(triggeredVia("inconnu"), "manual");
  });
});
