// La machine d'un agent embarqué vue de son conteneur : les limites du cgroup
// l'emportent sur ce que voit l'hôte, et le format est celui d'une machine
// d'équipe (mêmes jauges dans l'onglet Machines).

import assert from "node:assert/strict";
import os from "node:os";
import { describe, it } from "node:test";
import { cpusFromCgroup, machineInfo, memFromCgroup } from "./machine-info.ts";

describe("machine d'un agent embarqué", () => {
  it("les processeurs : la limite du cgroup (v2, puis v1), sinon l'hôte", () => {
    assert.equal(cpusFromCgroup("200000 100000", null, null, 16), 2);
    assert.equal(cpusFromCgroup("150000 100000", null, null, 16), 1.5);
    assert.equal(cpusFromCgroup("max 100000", null, null, 16), 16, "pas de limite : l'hôte");
    assert.equal(cpusFromCgroup(null, "50000", "100000", 8), 0.5, "cgroup v1");
    assert.equal(cpusFromCgroup(null, "-1", "100000", 8), 8);
    assert.equal(cpusFromCgroup(null, null, null, 4), 4);
  });

  it("la mémoire : limite et usage du cgroup, sinon l'hôte", () => {
    const host = { total: 32 * 1024 ** 3, free: 20 * 1024 ** 3 };
    const two = String(2 * 1024 ** 3);
    assert.deepEqual(memFromCgroup(two, String(512 * 1024 ** 2), host), { total_kb: 2 * 1024 * 1024, free_kb: 1.5 * 1024 * 1024 });
    assert.deepEqual(memFromCgroup("max", String(512 * 1024 ** 2), host), { total_kb: 32 * 1024 * 1024, free_kb: 20 * 1024 * 1024 }, "« max » ne limite rien");
    // cgroup v1 sans limite : un nombre immense, plus grand que l'hôte.
    assert.equal(memFromCgroup("9223372036854771712", "1000", host).total_kb, 32 * 1024 * 1024);
    assert.equal(memFromCgroup(two, String(3 * 1024 ** 3), host).free_kb, 0, "jamais négatif");
  });

  it("le format d'une machine d'équipe, avec les outils et la version", async () => {
    const info = await machineInfo({ workspaceDir: os.tmpdir(), version: "agent-runtime 1", tools: ["data-analysis"], built: true });
    assert.equal(info.version, "agent-runtime 1");
    assert.deepEqual(info.tools, ["data-analysis"]);
    assert.equal(info.built, true);
    assert.ok(info.cpus > 0);
    assert.equal(info.load.length, 3);
    assert.ok(info.mem.total_kb > 0 && info.mem.free_kb >= 0);
    assert.ok(info.disk && info.disk.total_kb > 0, "le disque du dossier de travail");
    assert.ok(info.uptime_s >= 0 && info.hostname && info.platform && info.node.startsWith("v"));
    const none = await machineInfo({ workspaceDir: "/chemin/qui/n/existe/pas" });
    assert.equal(none.disk, null, "un dossier absent ne fait pas échouer la description");
  });
});
