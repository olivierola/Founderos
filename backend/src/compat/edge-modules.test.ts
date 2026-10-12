// Charge chacune des fonctions générées : un import introuvable, une API Deno
// non couverte par src/compat ou une erreur au chargement font échouer ce test.

import "../test-env.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeFunctions } from "../edge/registry.ts";

for (const [name, load] of Object.entries(edgeFunctions)) {
  test(`${name} se charge et exporte son handler`, async () => {
    const mod = await load();
    assert.equal(typeof mod.default, "function");
  });
}
