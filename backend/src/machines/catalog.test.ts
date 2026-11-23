// Le catalogue des outils : cohérent, sans paquet qui sorte de sa commande, et
// des images construites sur team-machine à partir d'une sélection.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRESETS, selectionDockerfile, selectionImage, selectionKey, selectionLayer, TOOL_CATEGORIES, TOOLS,
  presetById, resolveTools, toolById,
} from "./catalog.ts";

describe("catalogue des outils", () => {
  it("des identifiants uniques, chaque catégorie remplie, chaque outil utile", () => {
    const ids = TOOLS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    const cats = new Set(TOOL_CATEGORIES.map((c) => c.id));
    for (const t of TOOLS) {
      assert.ok(cats.has(t.category), `${t.id} : catégorie ${t.category}`);
      assert.ok(t.apt.length + t.pip.length + t.npm.length > 0, `${t.id} : aucun paquet`);
    }
    for (const c of TOOL_CATEGORIES) assert.ok(TOOLS.some((t) => t.category === c.id), `catégorie vide : ${c.id}`);
  });

  it("les presets ne pointent que vers des outils existants", () => {
    const ids = PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of PRESETS) {
      assert.ok(p.tools.length > 0, p.id);
      for (const t of p.tools) assert.ok(toolById(t), `${p.id} → outil inconnu ${t}`);
    }
  });

  it("chaque paquet reste un argument : guillemets, aucun caractère de shell", () => {
    for (const t of TOOLS) {
      for (const p of [...t.apt, ...t.pip, ...t.npm]) assert.doesNotMatch(p, /[\s;&|`$'"()\\]/, `${t.id} : ${p}`);
    }
    // Une injection dans une sélection ne passe pas ; les crochets non plus.
    const layer = selectionLayer(["netsec-recon", "data-sql"]).join("\n");
    assert.match(layer, /'nmap'/);
    assert.match(layer, /'psycopg\[binary\]'/);
  });

  it("resolveTools garde l'ordre du catalogue, sans doublon ni inconnu", () => {
    const got = resolveTools(["data-sql", "dev-node", "data-sql", "inconnu"]).map((t) => t.id);
    assert.deepEqual(got, TOOLS.filter((t) => ["data-sql", "dev-node"].includes(t.id)).map((t) => t.id));
  });

  it("l'image d'une sélection part de team-machine et désarme les setuid ; une clé stable", () => {
    const sel = ["defsec-dfir", "defsec-logs"];
    const df = selectionDockerfile(sel, "founderos/team-machine:0.3.0");
    assert.match(df, /^FROM founderos\/team-machine:0\.3\.0$/m);
    assert.match(df, /apt-get install .*'yara'/);
    assert.ok(df.indexOf("chmod a-s") > df.indexOf("apt-get install"), "les setuid ajoutés par les paquets sont désarmés");
    // Même sélection, même clé et même image, quel que soit l'ordre demandé.
    assert.equal(selectionKey(["defsec-logs", "defsec-dfir"]), selectionKey(sel));
    assert.equal(selectionImage("founderos/team-machine:0.3.0", sel), selectionImage("founderos/team-machine:0.3.0", ["defsec-logs", "defsec-dfir"]));
    assert.match(selectionImage("founderos/team-machine:0.3.0", sel), /^founderos\/team-machine-tools-[0-9a-f]{10}:0\.3\.0$/);
    assert.equal(selectionImage("registry.local:5000/fos/team-machine:1", []), "registry.local:5000/fos/team-machine:1", "sans outil, l'image de base");
    assert.equal(toolById("inconnu"), null);
    assert.equal(presetById(null), null);
  });
});
