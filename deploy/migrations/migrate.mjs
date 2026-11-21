#!/usr/bin/env node
// Applique les migrations FounderOS à la base de l'installation (G5).
//
//   DATABASE_URL=postgres://postgres:…@db:5432/postgres node migrate.mjs
//   node migrate.mjs --dry-run          ce qui serait appliqué
//   node migrate.mjs --baseline 0272    base migrée à la main : noter jusqu'à 0272 sans rejouer
//   PLATFORM=self node migrate.mjs      PostgreSQL ordinaire, sans Supabase : le socle
//                                       d'abord (backend/platform/sql), puis les migrations
//
// MIGRATIONS_DIR : le dossier des fichiers (défaut : ./migrations, celui de l'image).
// PLATFORM_SQL_DIR : le socle (défaut : ./platform-sql dans l'image, sinon
// backend/platform/sql du dépôt).
// Le rôle doit être propriétaire du schéma public et pouvoir créer dans auth
// (le rôle postgres de Supabase) : plusieurs migrations y posent des déclencheurs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { listMigrations, migrate } from "./runner.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL est requis (postgres://utilisateur:mot-de-passe@hôte:5432/base).");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.MIGRATIONS_DIR || path.join(here, "migrations");

const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 30 });
const db = {
  exec: (text) => sql.unsafe(text),
  query: (text, params = []) => sql.unsafe(text, params),
};

// Mode self : pg_cron, pg_net et pgmq ne sont pas sur un PostgreSQL standard,
// le socle les remplace. Même règle que backend/src/platform/migrate.ts.
const SHIMMED = /create\s+extension\s+if\s+not\s+exists\s+"?(pg_cron|pg_net|pgmq)"?(\s+(with\s+)?schema\s+\w+)?(\s+cascade)?\s*;/gi;
const selfHosted = (process.env.PLATFORM || "").toLowerCase() === "self";

try {
  let migrations = listMigrations(dir);
  if (selfHosted) {
    const socle = process.env.PLATFORM_SQL_DIR
      || [path.join(here, "platform-sql"), path.join(here, "../../backend/platform/sql")].find((d) => existsSync(d));
    if (!socle) throw new Error("PLATFORM=self : socle introuvable (PLATFORM_SQL_DIR).");
    for (const f of readdirSync(socle).filter((x) => x.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(path.join(socle, f), "utf8"));
      console.log(`socle : ${f}`);
    }
    migrations = migrations.map((m) => ({
      ...m,
      sql: readFileSync(m.path, "utf8").replace(SHIMMED, (_m, ext) => `select 1; -- ${ext} : fourni par le socle de la plateforme
`),
    }));
  }
  const out = await migrate(db, migrations, {
    dryRun: flag("--dry-run"),
    baseline: value("--baseline"),
    log: (line) => console.log(line),
  });
  console.log(`migrations : ${out.applied.length} appliquée(s), ${out.skipped} déjà présente(s), ${out.pending.length} en attente.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
