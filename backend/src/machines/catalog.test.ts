// Le catalogue des machines taillées par métier : cohérent, sans paquet qui
// sorte de sa commande, et des images construites sur team-machine.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATEGORIES, machineDockerfile, templateById, templateImage, templateLayer, TEMPLATES } from "./catalog.ts";

describe("catalogue des machines", () => {
  it("des identifiants uniques et stables, chaque catégorie remplie", () => {
    const ids = TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z]+-[a-z0-9-]+$/);
    const cats = new Set(CATEGORIES.map((c) => c.id));
    for (const t of TEMPLATES) assert.ok(cats.has(t.category), `${t.id} : catégorie ${t.category}`);
    for (const c of CATEGORIES) assert.ok(TEMPLATES.some((t) => t.category === c.id), `catégorie vide : ${c.id}`);
  });

  it("des ressources raisonnables et des outils annoncés", () => {
    for (const t of TEMPLATES) {
      assert.ok(t.cpus >= 1 && t.cpus <= 16, t.id);
      assert.ok(t.memory_mb >= 1024 && t.memory_mb <= 65536, t.id);
      assert.ok(t.highlights.length > 0 && t.apt.length + t.pip.length + t.npm.length > 0, t.id);
    }
  });

  it("chaque paquet reste un argument : guillemets, aucun caractère de shell", () => {
    for (const t of TEMPLATES) {
      for (const p of [...t.apt, ...t.pip, ...t.npm]) assert.doesNotMatch(p, /[\s;&|`$'"()\\]/, `${t.id} : ${p}`);
    }
    const layer = templateLayer({ ...TEMPLATES[0], apt: ["nmap", "x; rm -rf /", "$(id)"], pip: ["psycopg[binary]"], npm: [] }).join("\n");
    assert.match(layer, /'nmap'/);
    assert.doesNotMatch(layer, /x; rm|\$\(id\)/);
    assert.match(layer, /'psycopg\[binary\]'/, "les crochets ne passent pas par le shell");
  });

  it("l'image d'une machine du catalogue part de team-machine et désarme les setuid", () => {
    const t = templateById("cyber-recon")!;
    const df = machineDockerfile(t, "founderos/team-machine:0.3.0");
    assert.match(df, /^FROM founderos\/team-machine:0\.3\.0$/m);
    assert.match(df, /apt-get install .*'nmap'/);
    assert.ok(df.indexOf("chmod a-s") > df.indexOf("apt-get install"), "les setuid ajoutés par les paquets sont désarmés");
    assert.equal(templateImage("founderos/team-machine:0.3.0", t), "founderos/team-machine-cyber-recon:0.3.0");
    assert.equal(templateImage("registry.local:5000/fos/team-machine:1", t), "registry.local:5000/fos/team-machine-cyber-recon:1");
    assert.equal(templateById("inconnu"), null);
    assert.equal(templateById(null), null);
  });
});
