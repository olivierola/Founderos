// Compare le schéma public d'une base reconstruite depuis les migrations avec
// celui de l'instance Supabase (lu dans la description OpenAPI de PostgREST).
//   npx tsx src/platform/schema-drift.ts <DATABASE_URL locale>
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY : l'instance de référence (la
// description OpenAPI n'est servie qu'à la clé service). La base locale vient
// de `npm run platform:migrate`.
import { readFileSync } from "node:fs";
import { openDb } from "./db.ts";

const env = (k: string) => process.env[k] ?? process.env[`VITE_${k}`] ?? "";
const url = env("SUPABASE_URL"), key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis");
const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" } });
const spec = await res.json() as { definitions: Record<string, { properties?: Record<string, { format?: string }> }> };
const remote = new Map(Object.entries(spec.definitions).map(([t, d]) => [t, new Map(Object.entries(d.properties ?? {}).map(([c, p]) => [c, p.format ?? ""]))]));

const db = await openDb(process.argv[2]);
const rows = await db.query<{ t: string; c: string; ty: string }>(
  `select table_name t, column_name c, data_type ty from information_schema.columns where table_schema = 'public'`);
await db.close();
const local = new Map<string, Map<string, string>>();
for (const r of rows) (local.get(r.t) ?? local.set(r.t, new Map()).get(r.t)!).set(r.c, r.ty);

const missingTables = [...remote.keys()].filter((t) => !local.has(t));
const extraTables = [...local.keys()].filter((t) => !remote.has(t));
const missingCols: string[] = [];
for (const [t, cols] of remote) {
  const l = local.get(t); if (!l) continue;
  for (const [c, f] of cols) if (!l.has(c)) missingCols.push(`${t}.${c} (${f})`);
}
console.log(JSON.stringify({ remoteTables: remote.size, localTables: local.size, missingTables, extraTables, missingCols }, null, 1));
