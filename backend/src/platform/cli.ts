// Outils de la plateforme auto-hébergée (npm run platform -- <commande>).
//
//   keys      les clés anon et service_role dérivées de JWT_SECRET, et les
//             variables à donner au front (VITE_SUPABASE_URL / _ANON_KEY).
//   migrate   socle + migrations sur DATABASE_URL, sans démarrer le serveur.
//   import    copie une base Supabase (ou tout PostgreSQL migré pareil) vers
//             DATABASE_URL : comptes (mots de passe, sessions, MFA compris),
//             identités, tout le schéma public, le storage (métadonnées et,
//             avec --storage, les fichiers) et les secrets du vault.
//
//   npm run platform -- import --from "postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres" \
//       [--storage --source-url https://<ref>.supabase.co --source-key <service_role>] [--force]
//
// La source fait foi : l'import VIDE d'abord les tables de données de la cible
// (public, storage, auth) — y compris les données de référence que ses propres
// migrations ont insérées avec d'autres identifiants, qui feraient sinon
// doublon. Une cible qui a déjà des comptes est refusée, sauf --force
// (= écraser). L'import désactive
// déclencheurs et contraintes le temps de la copie (session_replication_role =
// replica) : le rôle de DATABASE_URL doit être superutilisateur — le cas d'une
// base neuve, et de PGlite.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openDb, type Db } from "./db.ts";
import { apiKeys } from "./jwt.ts";
import { migrateDatabase } from "./migrate.ts";
import { ident } from "./rest/sql.ts";

// .env.self d'abord : ce sont les outils de la plateforme auto-hébergée, et un
// .env resté en mode Supabase ne doit pas leur fournir son FUNCTIONS_URL.
for (const file of [".env.self", ".env.local", ".env"]) { try { process.loadEnvFile(file); } catch { /* absent */ } }

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);

/** Ce que l'import emporte, dans cet ordre. Le reste (registre des migrations,
 *  files pgmq, historique cron/net) appartient à l'instance, pas aux données. */
const AUTH_TABLES = [
  "users", "identities", "sessions", "refresh_tokens", "mfa_factors", "mfa_challenges", "mfa_amr_claims",
  "one_time_tokens", "flow_state", "sso_providers", "sso_domains",
];
/** Posés par le backend à chaque démarrage : ceux de la source ne valent pas ici. */
const INSTANCE_SECRETS = new Set(["functions_base_url", "agent_service_key", "agent_tick_secret"]);

async function columnsOf(db: Db, schema: string, table: string) {
  return db.query<{ name: string; generated: boolean }>(
    `select a.attname as name, (a.attgenerated <> '' or a.attidentity = 'a') as generated
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped`, [schema, table]);
}

async function copyTable(src: Db, dst: Db, schema: string, table: string): Promise<number> {
  const [srcCols, dstCols] = await Promise.all([columnsOf(src, schema, table), columnsOf(dst, schema, table)]);
  if (!srcCols.length || !dstCols.length) return -1;
  const srcNames = new Set(srcCols.map((c) => c.name));
  const cols = dstCols.filter((c) => !c.generated && srcNames.has(c.name)).map((c) => c.name);
  if (!cols.length) return 0;
  const t = `${ident(schema)}.${ident(table)}`;
  const list = cols.map(ident).join(", ");
  const BATCH = 500;
  let copied = 0;
  for (let offset = 0; ; offset += BATCH) {
    // ctid : un ordre stable sans supposer de clé primaire.
    const rows = await src.query<{ r: unknown }>(`select to_jsonb(t) as r from ${t} t order by ctid limit ${BATCH} offset ${offset}`);
    if (!rows.length) break;
    const payload = JSON.stringify(rows.map((x) => (typeof x.r === "string" ? JSON.parse(x.r) : x.r)));
    copied += await dst.command(
      `insert into ${t} (${list}) select ${list} from jsonb_populate_recordset(null::${t}, $1::jsonb) on conflict do nothing`, [payload]);
    if (rows.length < BATCH) break;
  }
  return copied;
}

async function resetSequences(dst: Db) {
  const seqs = await dst.query<{ schema: string; table: string; column: string; seq: string }>(
    `select n.nspname as schema, c.relname as table, a.attname as column, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) as seq
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'auth', 'storage') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) is not null`);
  for (const s of seqs) {
    await dst.query(`select setval($1, greatest(coalesce((select max(${ident(s.column)}) from ${ident(s.schema)}.${ident(s.table)}), 0), 1))`, [s.seq]);
  }
  return seqs.length;
}

async function importDatabase() {
  const from = opt("--from") ?? process.env.SOURCE_DATABASE_URL;
  const to = opt("--to") ?? process.env.DATABASE_URL;
  if (!from || !to) throw new Error("--from <URL source> et DATABASE_URL (ou --to) sont requis.");
  const src = await openDb(from);
  const dst = await openDb(to);
  try {
    console.log("cible : socle et migrations…");
    await migrateDatabase(dst, { log: () => {} });
    const [{ n }] = await dst.query<{ n: number }>("select count(*)::int as n from auth.users");
    if (n > 0 && !has("--force")) throw new Error(`La base cible a déjà ${n} compte(s). Relancez avec --force pour l'écraser avec la source.`);

    const tables: Array<[string, string]> = [
      ...AUTH_TABLES.map((t): [string, string] => ["auth", t]),
      ["storage", "buckets"], ["storage", "objects"],
      ...(await src.query<{ name: string }>(
        "select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname"))
        .map((r): [string, string] => ["public", r.name]),
    ];

    let total = 0;
    await dst.tx(async (q) => {
      await q.query("set local session_replication_role = replica");
      const tx: Db = { ...dst, query: q.query, command: q.command };
      const present = await q.query<{ s: string; t: string }>(
        `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p') and ((n.nspname = 'public') or (n.nspname = 'storage' and c.relname in ('buckets','objects'))
             or (n.nspname = 'auth' and c.relname = any($1)))`, [AUTH_TABLES]);
      if (present.length) await q.query(`truncate table ${present.map((x) => `${ident(x.s)}.${ident(x.t)}`).join(", ")} cascade`);
      for (const [schema, table] of tables) {
        const n = await copyTable(src, tx, schema, table);
        if (n < 0) { console.log(`  ${schema}.${table} : absente d'un côté, ignorée`); continue; }
        if (n > 0) console.log(`  ${schema}.${table} : ${n}`);
        total += n;
      }
    });
    console.log(`lignes copiées : ${total} ; séquences recalées : ${await resetSequences(dst)}`);

    // Les secrets du vault : déchiffrés à la source, rechiffrés ici.
    const secrets = await src.query<{ name: string; decrypted_secret: string; description: string | null }>(
      "select name, decrypted_secret, description from vault.decrypted_secrets where name is not null").catch(() => []);
    let kept = 0;
    for (const s of secrets) {
      if (INSTANCE_SECRETS.has(s.name) || !s.decrypted_secret) continue;
      const [existing] = await dst.query<{ id: string }>("select id from vault.secrets where name = $1", [s.name]);
      if (existing) await dst.query("select vault.update_secret($1::uuid, $2)", [existing.id, s.decrypted_secret]);
      else await dst.query("select vault.create_secret($1, $2, $3)", [s.decrypted_secret, s.name, s.description ?? ""]);
      kept++;
    }
    console.log(`secrets du vault : ${kept}`);

    if (has("--storage")) await importFiles(dst);
    console.log("import terminé.");
  } finally {
    await src.close();
    await dst.close();
  }
}

/** Les octets du storage, lus à la source par son API (clé service_role). */
async function importFiles(dst: Db) {
  const base = (opt("--source-url") ?? process.env.SOURCE_SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = opt("--source-key") ?? process.env.SOURCE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key) throw new Error("--storage demande --source-url et --source-key (clé service_role de la source).");
  const dir = path.resolve(process.env.STORAGE_DIR || "./.data/storage");
  const objects = await dst.query<{ bucket_id: string; name: string }>("select bucket_id, name from storage.objects order by bucket_id, name");
  let ok = 0, failed = 0;
  for (const o of objects) {
    const res = await fetch(`${base}/storage/v1/object/${encodeURIComponent(o.bucket_id)}/${o.name.split("/").map(encodeURIComponent).join("/")}`,
      { headers: { Authorization: `Bearer ${key}`, apikey: key } });
    if (!res.ok) { failed++; console.log(`  ✗ ${o.bucket_id}/${o.name} : ${res.status}`); continue; }
    const f = path.join(dir, o.bucket_id, o.name);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, Buffer.from(await res.arrayBuffer()));
    ok++;
  }
  console.log(`fichiers du storage : ${ok} copié(s), ${failed} en échec`);
}

async function main() {
  if (cmd === "keys") {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error("JWT_SECRET (32 caractères au moins) est requis.");
    const keys = apiKeys(secret);
    const url = (process.env.FUNCTIONS_URL || `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
    console.log(`# Front (.env à la racine) pour la plateforme auto-hébergée :
VITE_SUPABASE_URL=${url}
VITE_SUPABASE_ANON_KEY=${keys.anon}
VITE_API_URL=${url}

# Clé service_role (runners, relais, scripts — jamais dans le front) :
SERVICE_ROLE_KEY=${keys.service}`);
    return;
  }
  if (cmd === "migrate") {
    const url = opt("--to") ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL est requis.");
    const db = await openDb(url);
    try {
      const out = await migrateDatabase(db, { log: (l) => console.log(l), dryRun: has("--dry-run") });
      console.log(`migrations : ${out.applied.length} appliquée(s), ${out.skipped} déjà présente(s), ${out.pending.length} en attente.`);
    } finally { await db.close(); }
    return;
  }
  if (cmd === "import") return importDatabase();
  console.log("Usage : npm run platform -- keys | migrate [--dry-run] | import --from <URL> [--storage --source-url … --source-key …] [--force]");
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
