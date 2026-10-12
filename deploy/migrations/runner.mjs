// Application des migrations de supabase/migrations (G5) : le Job « migrations »
// du chart Helm, le service « migrate » du docker-compose.
//
// Même registre que la CLI Supabase (supabase_migrations.schema_migrations) :
// une base migrée ici ne rejoue rien à un `supabase db push`, et inversement.
//
//   - dans l'ordre des versions (le préfixe numérique du fichier) ;
//   - chaque migration dans SA transaction, notée dans le registre dans la même
//     transaction : une migration qui échoue n'est ni appliquée ni notée ;
//   - un verrou consultatif : deux Jobs lancés ensemble ne migrent pas deux fois ;
//   - « -- founderos:no-transaction » en tête d'un fichier : hors transaction
//     (CREATE INDEX CONCURRENTLY…) ;
//   - baseline : une base déjà migrée à la main, sans registre, note les
//     versions jusqu'à N sans les rejouer.
//
// Le pilote de base est injecté ({ exec, query, close }) : les tests jouent
// l'ordre, le registre et les échecs sans Postgres.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const FILE_RE = /^(\d+)_([A-Za-z0-9_.-]+)\.sql$/;
export const LOCK_KEY = 4_200_283; // pg_advisory_lock : un entier propre à FounderOS

/** Les migrations d'un dossier, triées par version. */
export function listMigrations(dir) {
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f));
  const seen = new Map();
  for (const f of files) {
    const version = FILE_RE.exec(f)[1];
    if (seen.has(version)) throw new Error(`Version en double : ${seen.get(version)} et ${f}.`);
    seen.set(version, f);
  }
  return files
    .map((file) => {
      const [, version, name] = FILE_RE.exec(file);
      return { version, name, file, path: path.join(dir, file) };
    })
    .sort((a, b) => (a.version.length - b.version.length) || a.version.localeCompare(b.version));
}

const REGISTRY = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);`;

/**
 * Applique ce qui manque. `db` : { exec(sql), query(sql, params) → rows }.
 * Renvoie { applied: [versions], skipped: n, pending: [versions] }.
 */
export async function migrate(db, migrations, opts = {}) {
  const log = opts.log ?? (() => {});
  await db.exec(REGISTRY);
  await db.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const done = new Set((await db.query("select version from supabase_migrations.schema_migrations")).map((r) => String(r.version)));
    const pending = migrations.filter((m) => !done.has(m.version));

    if (opts.baseline) {
      const upTo = String(opts.baseline);
      const marked = [];
      for (const m of pending) {
        if (m.version.length > upTo.length || (m.version.length === upTo.length && m.version > upTo)) continue;
        await db.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict do nothing", [m.version, m.name]);
        marked.push(m.version);
      }
      log(`baseline : ${marked.length} version(s) notée(s) sans être rejouée(s), jusqu'à ${upTo}.`);
      return { applied: [], marked, skipped: done.size, pending: pending.filter((m) => !marked.includes(m.version)).map((m) => m.version) };
    }

    if (opts.dryRun) {
      for (const m of pending) log(`à appliquer : ${m.file}`);
      return { applied: [], skipped: done.size, pending: pending.map((m) => m.version) };
    }

    const applied = [];
    for (const m of pending) {
      const sql = m.sql ?? readFileSync(m.path, "utf8");
      const noTx = /^\s*--\s*founderos:no-transaction\b/m.test(sql.split("\n").slice(0, 5).join("\n"));
      const record = ["insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [m.version, m.name]];
      try {
        if (noTx) {
          await db.exec(sql);
          await db.query(...record);
        } else {
          await db.exec("begin");
          try {
            await db.exec(sql);
            await db.query(...record);
            await db.exec("commit");
          } catch (e) {
            await db.exec("rollback").catch(() => {});
            throw e;
          }
        }
      } catch (e) {
        const err = new Error(`Migration ${m.file} refusée : ${e instanceof Error ? e.message : String(e)}`);
        err.migration = m.file;
        err.applied = applied;
        throw err;
      }
      applied.push(m.version);
      log(`appliquée : ${m.file}`);
    }
    return { applied, skipped: done.size, pending: [] };
  } finally {
    await db.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  }
}
