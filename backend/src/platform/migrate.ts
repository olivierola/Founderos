// Prépare la base auto-hébergée : le socle Supabase (platform/sql), puis les
// migrations de supabase/migrations telles quelles, puis les secrets du vault
// dont les tâches planifiées ont besoin.
//
// Même runner et même registre que deploy/migrations (et que la CLI Supabase) :
// une base migrée ici reconnaît ce qu'elle a déjà, et inversement.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Db } from "./db.ts";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PLATFORM_SQL_DIR = path.join(backendDir, "platform/sql");
export const DEFAULT_MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.resolve(backendDir, "../supabase/migrations");

/**
 * Les extensions que le socle remplace : pg_cron, pg_net et pgmq ne sont pas
 * sur un PostgreSQL standard, leurs schémas sont déjà là (00_platform.sql).
 * L'instruction est neutralisée, pas le reste du fichier.
 */
const SHIMMED = /create\s+extension\s+if\s+not\s+exists\s+"?(pg_cron|pg_net|pgmq)"?(\s+(with\s+)?schema\s+\w+)?(\s+cascade)?\s*;/gi;

export function adaptMigration(sql: string): string {
  return sql.replace(SHIMMED, (_m, ext) => `select 1; -- ${ext} : fourni par le socle de la plateforme\n`);
}

interface Migration { version: string; name: string; file: string; path: string; sql?: string }
interface RunnerModule {
  listMigrations(dir: string): Migration[];
  migrate(db: { exec(t: string): Promise<unknown>; query(t: string, p?: unknown[]): Promise<Row[]> }, m: Migration[], opts?: Record<string, unknown>): Promise<{ applied: string[]; skipped: number; pending: string[] }>;
}
type Row = Record<string, unknown>;

async function loadRunner(): Promise<RunnerModule> {
  const p = path.resolve(backendDir, "../deploy/migrations/runner.mjs");
  if (!existsSync(p) || !existsSync(PLATFORM_SQL_DIR)) {
    throw new Error("Migrations introuvables (hors du dépôt, en conteneur ?) : PLATFORM_MIGRATE=false, et le service « migrate » (deploy/migrations, PLATFORM=self) prépare la base.");
  }
  // Chemin calculé : le runner vit hors du projet TypeScript du backend.
  return (await import(pathToFileURL(p).href)) as RunnerModule;
}

export async function applyPlatform(db: Db, log: (l: string) => void = () => {}): Promise<void> {
  for (const f of readdirSync(PLATFORM_SQL_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(PLATFORM_SQL_DIR, f), "utf8"));
    log(`socle : ${f}`);
  }
}

export async function migrateDatabase(db: Db, opts: {
  dir?: string; log?: (l: string) => void; dryRun?: boolean;
} = {}) {
  const log = opts.log ?? (() => {});
  const runner = await loadRunner();
  await applyPlatform(db, log);
  const migrations = runner.listMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR)
    .map((m) => ({ ...m, sql: adaptMigration(readFileSync(m.path, "utf8")) }));
  return runner.migrate(
    { exec: (t) => db.exec(t), query: (t, p) => db.query(t, p) },
    migrations,
    { log, dryRun: opts.dryRun },
  );
}

/**
 * Les secrets que les tâches planifiées lisent dans le vault (0095, 0096,
 * 0273) : l'URL des fonctions — ce backend —, la clé service et le secret des
 * ticks. Posés à chaque démarrage pour suivre la configuration.
 */
export async function seedVault(db: Db, secrets: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    const [row] = await db.query<{ id: string }>("select id from vault.secrets where name = $1", [name]);
    if (row) await db.query("select vault.update_secret($1::uuid, $2)", [row.id, value]);
    else await db.query("select vault.create_secret($1, $2)", [value, name]);
  }
}
