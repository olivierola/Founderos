#!/usr/bin/env node
// Applique les migrations FounderOS à la base de l'installation (G5).
//
//   DATABASE_URL=postgres://postgres:…@db:5432/postgres node migrate.mjs
//   node migrate.mjs --dry-run          ce qui serait appliqué
//   node migrate.mjs --baseline 0272    base migrée à la main : noter jusqu'à 0272 sans rejouer
//
// MIGRATIONS_DIR : le dossier des fichiers (défaut : ./migrations, celui de l'image).
// Le rôle doit être propriétaire du schéma public et pouvoir créer dans auth
// (le rôle postgres de Supabase) : plusieurs migrations y posent des déclencheurs.

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

try {
  const migrations = listMigrations(dir);
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
