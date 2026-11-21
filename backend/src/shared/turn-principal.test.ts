// Un tour, une seule personne (turn-principal.ts, 0300) : dans un fil partagé,
// seul l'auteur du tour le pilote ; l'auteur du fil ne change pas pendant un
// tour ; une approbation se valide par l'auteur du tour qui l'a demandée.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindingForUpdate, insertChannelMessage, splitForTurn, steersTurn, turnRequester,
} from "../edge/_shared/turn-principal.ts";

type Admin = Parameters<typeof bindingForUpdate>[0];

/** Un client réduit : chaque table rend ce qu'on lui donne, quels que soient
 *  les filtres, et garde les insertions. */
function fakeAdmin(tables: Record<string, unknown>, opts: { rejectColumn?: string } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (data: unknown) => {
    const c: Record<string, unknown> = {};
    for (const k of ["select", "eq", "gt", "lte", "not", "order", "limit"]) c[k] = () => c;
    c.maybeSingle = () => Promise.resolve({ data: Array.isArray(data) ? data[0] ?? null : data });
    c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data }).then(ok, ko);
    return c;
  };
  const admin = {
    from: (t: string) => ({
      ...chain(tables[t] ?? null),
      insert: (row: Record<string, unknown>) => {
        if (opts.rejectColumn && opts.rejectColumn in row) {
          return Promise.resolve({ error: { message: `Could not find the '${opts.rejectColumn}' column` } });
        }
        inserted.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as Admin;
  return { admin, inserted };
}

describe("un tour, une seule personne", () => {
  it("seul l'auteur du tour le pilote ; l'application et l'inconnu pilotent toujours", () => {
    assert.equal(steersTurn("U_ALICE", "U_ALICE"), true);
    assert.equal(steersTurn("U_ALICE", "U_BOB"), false);
    assert.equal(steersTurn("U_ALICE", null), true, "message de l'application");
    assert.equal(steersTurn(null, "U_BOB"), true, "tour sans auteur connu : comme avant");
  });

  it("les messages de Bob pendant le tour d'Alice attendent, dans l'ordre", () => {
    const msgs = [
      { id: 1, author_ref: "U_BOB" }, { id: 2, author_ref: "U_ALICE" },
      { id: 3, author_ref: null }, { id: 4, author_ref: "U_BOB" },
    ];
    const { steer, deferred } = splitForTurn(msgs, "U_ALICE");
    assert.deepEqual(steer.map((m) => m.id), [2, 3]);
    assert.deepEqual(deferred.map((m) => m.id), [1, 4]);
  });

  it("pendant un tour, la passerelle ne change pas l'auteur du fil", async () => {
    const binding = { channel_id: "c", external_channel_ref: "C1", external_user_ref: "U_BOB" };
    const busy = fakeAdmin({ internal_agent_run_state: [{ run_id: "r1" }] });
    assert.deepEqual(await bindingForUpdate(busy.admin, "conv", binding), { channel_id: "c", external_channel_ref: "C1" });
    const idle = fakeAdmin({ internal_agent_run_state: [] });
    assert.deepEqual(await bindingForUpdate(idle.admin, "conv", binding), binding);
  });

  it("l'approbation se valide par l'auteur du tour qui l'a demandée", async () => {
    const { admin } = fakeAdmin({
      internal_agent_runs: { started_at: "2026-11-18T09:00:00Z" },
      internal_agent_messages: [{ author_ref: "U_ALICE" }],
    });
    assert.equal(await turnRequester(admin, "run-1", "conv"), "U_ALICE");
    const unknown = fakeAdmin({ internal_agent_runs: null });
    assert.equal(await turnRequester(unknown.admin, "run-1", "conv"), null);
  });

  it("sans la colonne author_ref (0300 non appliquée), le message part quand même", async () => {
    const { admin, inserted } = fakeAdmin({}, { rejectColumn: "author_ref" });
    await insertChannelMessage(admin, { conversation_id: "conv", agent_id: "a", content: "salut", author_ref: "U_BOB" });
    assert.deepEqual(inserted, [{ conversation_id: "conv", agent_id: "a", content: "salut", role: "user" }]);
  });
});
