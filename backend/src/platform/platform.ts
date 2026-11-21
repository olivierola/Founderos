// La plateforme auto-hébergée : ce backend sert lui-même ce que Supabase
// fournissait — base (PostgREST), auth (GoTrue), storage, realtime — sur un
// PostgreSQL à nous. Activée par PLATFORM=self ; voir README, « Plateforme
// auto-hébergée ».
//
// Les chemins et les formats sont ceux de Supabase (/rest/v1, /auth/v1,
// /storage/v1, /realtime/v1) : supabase-js, côté front comme dans le code des
// fonctions, ne voit pas la différence. Basculer = changer l'URL et les clés.

import express, { type Router } from "express";
import cors from "cors";
import { openDb, type Db } from "./db.ts";
import { migrateDatabase, seedVault } from "./migrate.ts";
import { loadSchema, type SchemaCache } from "./rest/schema.ts";
import { restRouter } from "./rest/router.ts";
import { authRouter } from "./auth/router.ts";
import { storageRouter } from "./storage/router.ts";
import { installRealtimeTriggers } from "./realtime.ts";
import { startWorkers } from "./workers.ts";

export interface PlatformConfig {
  databaseUrl: string;
  jwtSecret: string;
  /** URL publique de ce backend (liens d'e-mail, redirections OAuth, storage). */
  publicUrl: string;
  /** Schémas exposés par /rest/v1 (PGRST_DB_SCHEMAS). */
  schemas: string[];
  /** Appliquer socle + migrations au démarrage. */
  migrate: boolean;
  /** Dossier des fichiers du storage. */
  storageDir: string;
  anonKey: string;
  serviceKey: string;
  /** Exécuter les tâches planifiées et les requêtes sortantes (pg_cron, pg_net). */
  workers: boolean;
}

export interface Platform {
  readonly config: PlatformConfig;
  readonly db: Db;
  readonly jwtSecret: string;
  readonly schemas: string[];
  cache(): SchemaCache;
  reloadSchema(): Promise<void>;
  close(): Promise<void>;
}

export async function startPlatform(config: PlatformConfig, log: (l: string) => void = (l) => console.log(`[platform] ${l}`)): Promise<Platform> {
  const db = await openDb(config.databaseUrl);
  log(`base : ${db.kind}`);
  if (config.migrate) {
    const t = Date.now();
    const out = await migrateDatabase(db, { log: (l) => { if (!l.startsWith("appliquée")) log(l); } });
    log(`migrations : ${out.applied.length} appliquée(s), ${out.skipped} déjà présente(s) (${Math.round((Date.now() - t) / 1000)} s)`);
  }
  // Les tâches planifiées (pg_cron) appellent les fonctions avec ces secrets.
  await seedVault(db, {
    functions_base_url: config.publicUrl,
    agent_service_key: config.serviceKey,
    agent_tick_secret: process.env.AGENT_TICK_SECRET ?? "",
  }).catch((e) => log(`vault : ${e instanceof Error ? e.message : e}`));

  let cache = await loadSchema(db, config.schemas);
  log(`schéma : ${cache.tables.size} tables et vues, ${cache.fns.size} fonctions`);
  const platform = {} as Platform;
  const reloadSchema = async () => {
    cache = await loadSchema(db, config.schemas);
    // Une table ajoutée à la publication depuis le démarrage reçoit son déclencheur.
    await installRealtimeTriggers(platform);
  };
  // Le signal de PostgREST, que des migrations envoient déjà.
  const unlisten = await db.listen("pgrst", (payload) => {
    if (/reload schema/i.test(payload)) reloadSchema().catch((e) => log(`rechargement du schéma : ${e}`));
  });

  Object.assign(platform, {
    config, db, jwtSecret: config.jwtSecret, schemas: config.schemas,
    cache: () => cache,
    reloadSchema,
    close: async () => { await workers?.stop(); await unlisten(); await db.close(); },
  });
  const published = await installRealtimeTriggers(platform);
  log(`realtime : ${published} table(s) publiée(s)`);
  // pg_cron et pg_net : le backend fait leur travail (workers.ts).
  const workers = config.workers ? startWorkers(db, log) : null;
  return platform;
}

/** Les routes de la plateforme, montées AVANT le reste de l'app (CORS propre). */
export function platformRouter(p: Platform): Router {
  const r = express.Router();
  // Le CORS de Supabase : toute origine, toutes les méthodes de PostgREST, et
  // les en-têtes que supabase-js envoie et lit.
  r.use(["/rest/v1", "/auth/v1", "/storage/v1", "/realtime/v1"], cors({
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization", "apikey", "content-type", "x-client-info", "prefer", "range", "range-unit",
      "accept-profile", "content-profile", "x-upsert", "cache-control", "x-supabase-api-version",
    ],
    exposedHeaders: ["content-range", "content-location", "location", "x-supabase-api-version"],
    maxAge: 86400,
  }));
  r.use("/rest/v1", restRouter(p));
  r.use("/auth/v1", authRouter(p));
  r.use("/storage/v1", storageRouter(p));
  return r;
}
