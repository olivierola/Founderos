// Le runner des migrations (G5) : ordre, registre, transactions, échecs,
// baseline. Un faux pilote enregistre ce qui est envoyé à la base.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { listMigrations, migrate } from "./runner.mjs";

function folder(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "founderos-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

/** Une base factice : le registre en mémoire, et le journal des instructions. */
function fakeDb({ done = [], failOn = null } = {}) {
  const registry = new Set(done);
  const log = [];
  let tx = null;
  return {
    log,
    registry,
    exec: async (sql) => {
      log.push(sql.trim().split("\n")[0]);
      if (sql === "begin") { tx = new Set(); return; }
      if (sql === "commit") { for (const v of tx) registry.add(v); tx = null; return; }
      if (sql === "rollback") { tx = null; return; }
      if (failOn && sql.includes(failOn)) throw new Error(`syntax error near "${failOn}"`);
    },
    query: async (sql, params = []) => {
      log.push(sql);
      if (sql.startsWith("select version")) return [...registry].map((version) => ({ version }));
      if (sql.startsWith("insert into supabase_migrations")) (tx ?? registry).add(params[0]);
      return [];
    },
  };
}

describe("liste des migrations", () => {
  it("triées par version, les autres fichiers ignorés", () => {
    const dir = folder({ "0010_b.sql": "", "0002_a.sql": "", "README.md": "", "0100_c.sql": "", "notes.sql": "" });
    assert.deepEqual(listMigrations(dir).map((m) => m.file), ["0002_a.sql", "0010_b.sql", "0100_c.sql"]);
  });
  it("une version en double est refusée", () => {
    assert.throws(() => listMigrations(folder({ "0002_a.sql": "", "0002_b.sql": "" })), /Version en double/);
  });
  it("les vraies migrations du dépôt : ordonnées, sans doublon", () => {
    const real = listMigrations(path.resolve(import.meta.dirname, "../../supabase/migrations"));
    assert.ok(real.length >= 283);
    assert.equal(real[0].version, "0001");
    assert.ok(real.some((m) => m.version === "0283"));
  });
});

describe("application", () => {
  const dir = () => folder({ "0001_init.sql": "create table a();", "0002_b.sql": "create table b();", "0003_c.sql": "create table c();" });

  it("applique dans l'ordre, chacune dans sa transaction, sous verrou, et la note", async () => {
    const db = fakeDb();
    const out = await migrate(db, listMigrations(dir()));
    assert.deepEqual(out.applied, ["0001", "0002", "0003"]);
    assert.deepEqual([...db.registry], ["0001", "0002", "0003"]);
    const flow = db.log.filter((l) => /^(begin|commit|create table|select pg_advisory)/.test(l));
    assert.deepEqual(flow, [
      "select pg_advisory_lock($1)",
      "begin", "create table a();", "commit",
      "begin", "create table b();", "commit",
      "begin", "create table c();", "commit",
      "select pg_advisory_unlock($1)",
    ]);
  });

  it("ne rejoue pas ce qui est déjà au registre (même celui de la CLI Supabase)", async () => {
    const db = fakeDb({ done: ["0001", "0002"] });
    const out = await migrate(db, listMigrations(dir()));
    assert.deepEqual(out.applied, ["0003"]);
    assert.equal(out.skipped, 2);
    assert.equal(db.log.includes("create table a();"), false);
  });

  it("une migration qui échoue : annulée, non notée, les suivantes non tentées, le verrou rendu", async () => {
    const db = fakeDb({ failOn: "table b" });
    await assert.rejects(migrate(db, listMigrations(dir())), (e) => /0002_b\.sql refusée : syntax error/.test(e.message) && e.applied.join() === "0001");
    assert.deepEqual([...db.registry], ["0001"]);
    assert.ok(db.log.includes("rollback"));
    assert.equal(db.log.includes("create table c();"), false);
    assert.equal(db.log.at(-1), "select pg_advisory_unlock($1)");
  });

  it("« -- founderos:no-transaction » : hors transaction", async () => {
    const db = fakeDb();
    await migrate(db, listMigrations(folder({ "0001_idx.sql": "-- founderos:no-transaction\ncreate index concurrently i on t(x);" })));
    assert.equal(db.log.includes("begin"), false);
    assert.deepEqual([...db.registry], ["0001"]);
  });

  it("à blanc : liste sans rien appliquer", async () => {
    const db = fakeDb({ done: ["0001"] });
    const out = await migrate(db, listMigrations(dir()), { dryRun: true });
    assert.deepEqual(out.pending, ["0002", "0003"]);
    assert.deepEqual([...db.registry], ["0001"]);
  });

  it("baseline : note sans rejouer jusqu'à la version donnée, le reste attend", async () => {
    const db = fakeDb();
    const out = await migrate(db, listMigrations(dir()), { baseline: "0002" });
    assert.deepEqual(out.marked, ["0001", "0002"]);
    assert.deepEqual(out.pending, ["0003"]);
    assert.equal(db.log.some((l) => l.startsWith("create table")), false);
  });
});
