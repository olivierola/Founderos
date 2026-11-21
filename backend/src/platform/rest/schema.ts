// Le cache de schéma, comme celui de PostgREST : tables et vues exposées, leurs
// colonnes, clés primaires et étrangères (pour résoudre les ressources
// imbriquées), et les fonctions appelables par /rpc.
//
// Lu au démarrage, puis à chaque `NOTIFY pgrst, 'reload schema'` (le signal
// que les migrations Supabase envoient déjà) ou après une migration.

import type { Query } from "../db.ts";

export interface Column { name: string; type: string; generated: boolean; nullable: boolean }
export interface ForeignKey {
  name: string;
  from: { schema: string; table: string; columns: string[] };
  to: { schema: string; table: string; columns: string[] };
}
export interface Table {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: Map<string, Column>;
  pk: string[];
  /** Colonnes couvertes par une contrainte unique (pour les tables de jointure). */
  uniques: string[][];
}
export interface FnArg { name: string; type: string; isArray: boolean; isJson: boolean; hasDefault: boolean }
export interface Fn {
  schema: string;
  name: string;
  args: FnArg[];
  returnsSet: boolean;
  /** "scalar" | "composite" (ligne ou table) | "void". */
  returns: "scalar" | "composite" | "void";
  returnType: string;
  volatile: boolean;
}

export interface SchemaCache {
  tables: Map<string, Table>;
  fks: ForeignKey[];
  fns: Map<string, Fn[]>;
  loadedAt: number;
}

const key = (schema: string, name: string) => `${schema}.${name}`;

export async function loadSchema(q: Query, schemas: string[]): Promise<SchemaCache> {
  const [rels, cols, cons, procs] = await Promise.all([
    q.query<{ schema: string; name: string; kind: string }>(
      `select n.nspname as schema, c.relname as name, c.relkind::text as kind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('r','v','m','f','p')`, [schemas]),
    q.query<{ schema: string; table: string; name: string; type: string; generated: string; notnull: boolean; num: number }>(
      `select n.nspname as schema, c.relname as table, a.attname as name,
              format_type(a.atttypid, a.atttypmod) as type, a.attgenerated::text as generated,
              a.attnotnull as notnull, a.attnum as num
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('r','v','m','f','p')
          and a.attnum > 0 and not a.attisdropped
        order by c.relname, a.attnum`, [schemas]),
    q.query<{ name: string; type: string; schema: string; table: string; cols: string[]; fschema: string | null; ftable: string | null; fcols: string[] | null }>(
      `select con.conname as name, con.contype::text as type,
              n.nspname as schema, c.relname as table,
              array(select a.attname from unnest(con.conkey) with ordinality k(n, i)
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i)::text[] as cols,
              fn.nspname as fschema, fc.relname as ftable,
              case when con.confrelid = 0 then null else
              array(select a.attname from unnest(con.confkey) with ordinality k(n, i)
                      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i)::text[] end as fcols
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_class fc on fc.oid = con.confrelid
         left join pg_namespace fn on fn.oid = fc.relnamespace
        where con.contype in ('p','u','f') and n.nspname = any($1)`, [schemas]),
    q.query<{
      schema: string; name: string; argnames: string[] | null; argmodes: string[] | null; argtypes: string[]; argcats: string[];
      nargs: number; ndefaults: number; retset: boolean; rettype: string; rettyptype: string; volatile: string;
    }>(
      `select n.nspname as schema, p.proname as name, p.proargnames::text[] as argnames, p.proargmodes::text[] as argmodes,
              array(select format_type(t, null) from unnest(p.proargtypes) t)::text[] as argtypes,
              array(select ty.typcategory::text from unnest(p.proargtypes) t join pg_type ty on ty.oid = t)::text[] as argcats,
              p.pronargs as nargs, p.pronargdefaults as ndefaults, p.proretset as retset,
              format_type(p.prorettype, null) as rettype, rt.typtype::text as rettyptype,
              p.provolatile::text as volatile
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_type rt on rt.oid = p.prorettype
        where n.nspname = any($1) and p.prokind = 'f'`, [schemas]),
  ]);

  const tables = new Map<string, Table>();
  for (const r of rels) {
    tables.set(key(r.schema, r.name), {
      schema: r.schema, name: r.name, kind: r.kind === "v" || r.kind === "m" ? "view" : "table",
      columns: new Map(), pk: [], uniques: [],
    });
  }
  for (const c of cols) {
    tables.get(key(c.schema, c.table))?.columns.set(c.name, {
      name: c.name, type: c.type, generated: c.generated !== "" && c.generated != null, nullable: !c.notnull,
    });
  }
  const fks: ForeignKey[] = [];
  for (const c of cons) {
    const t = tables.get(key(c.schema, c.table));
    if (!t) continue;
    if (c.type === "p") { t.pk = c.cols; t.uniques.push(c.cols); }
    else if (c.type === "u") t.uniques.push(c.cols);
    else if (c.type === "f" && c.fschema && c.ftable && c.fcols) {
      fks.push({
        name: c.name,
        from: { schema: c.schema, table: c.table, columns: c.cols },
        to: { schema: c.fschema, table: c.ftable, columns: c.fcols },
      });
    }
  }

  const fns = new Map<string, Fn[]>();
  for (const p of procs) {
    // proargnames couvre aussi les colonnes de sortie (RETURNS TABLE, OUT) :
    // seules les entrées comptent pour l'appel.
    const names = p.argmodes
      ? (p.argnames ?? []).filter((_, i) => ["i", "b", "v"].includes(p.argmodes![i]))
      : (p.argnames ?? []);
    const firstDefault = p.nargs - p.ndefaults;
    const args: FnArg[] = p.argtypes.map((type, i) => ({
      name: names[i] ?? "",
      type,
      isArray: p.argcats[i] === "A",
      isJson: type === "json" || type === "jsonb",
      hasDefault: i >= firstDefault,
    }));
    const returns: Fn["returns"] = p.rettype === "void" ? "void"
      : p.rettyptype === "c" || p.rettype === "record" ? "composite" : "scalar";
    const fn: Fn = {
      schema: p.schema, name: p.name, args, returnsSet: p.retset, returns, returnType: p.rettype,
      volatile: p.volatile !== "i" && p.volatile !== "s",
    };
    const k = key(p.schema, p.name);
    fns.set(k, [...(fns.get(k) ?? []), fn]);
  }
  return { tables, fks, fns, loadedAt: Date.now() };
}

export function findTable(cache: SchemaCache, schema: string, name: string): Table | undefined {
  return cache.tables.get(key(schema, name));
}

export function findFunctions(cache: SchemaCache, schema: string, name: string): Fn[] {
  return cache.fns.get(key(schema, name)) ?? [];
}
