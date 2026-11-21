// Traduction d'une requête PostgREST analysée (parse.ts) en UNE instruction SQL.
//
// Comme PostgREST, la réponse est construite par PostgreSQL lui-même
// (json_agg / row_to_json) : dates, nombres, JSON et tableaux sortent sous la
// forme exacte que le front reçoit aujourd'hui de Supabase.
//
// Les valeurs de filtre sont des littéraux SQL échappés et NON typés
// ('…'), que PostgreSQL convertit au type de la colonne — le comportement de
// PostgREST, qui fait qu'un uuid mal formé donne la même erreur 22P02 qu'avant.

import {
  ApiError, type Condition, type Field, type Filter, type Level, type ParsedQuery, type SelectItem,
} from "./parse.ts";
import { findTable, type Fn, type ForeignKey, type SchemaCache, type Table } from "./schema.ts";

export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
export function lit(s: string): string {
  if (s.includes("\u0000")) throw new ApiError(400, "22021", "Caractère nul refusé dans une valeur.");
  return `'${s.replace(/'/g, "''")}'`;
}
const qualified = (t: { schema: string; name: string }) => `${ident(t.schema)}.${ident(t.name)}`;

// ── Champs et filtres ───────────────────────────────────────────────────────

export function fieldSql(alias: string, f: Field): string {
  let e = `${ident(alias)}.${ident(f.name)}`;
  for (const step of f.path) {
    const k = /^-?\d+$/.test(step.key) ? step.key : lit(step.key);
    e = `(${e}${step.text ? "->>" : "->"}${k})`;
  }
  return e;
}

const fieldOutputName = (f: Field) => (f.path.length ? f.path[f.path.length - 1].key : f.name);

const FTS: Record<string, string> = { fts: "to_tsquery", plfts: "plainto_tsquery", phfts: "phraseto_tsquery", wfts: "websearch_to_tsquery" };
const CMP: Record<string, string> = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  match: "~", imatch: "~*", cs: "@>", cd: "<@", ov: "&&",
  sl: "<<", sr: ">>", nxl: "&<", nxr: "&>", adj: "-|-",
};

export function conditionSql(alias: string, c: Condition): string {
  const col = fieldSql(alias, c.field);
  let s: string;
  if (c.op in CMP) {
    let v = c.value;
    // ov/cs/cd acceptent aussi la forme (a,b) de PostgREST pour un tableau.
    if ((c.op === "ov" || c.op === "cs" || c.op === "cd") && v.startsWith("(") && v.endsWith(")")) v = `{${v.slice(1, -1)}}`;
    s = `${col} ${CMP[c.op]} ${lit(v)}`;
  } else if (c.op === "like" || c.op === "ilike") {
    s = `${col} ${c.op === "like" ? "like" : "ilike"} ${lit(c.value.replace(/\*/g, "%"))}`;
  } else if (c.op === "in") {
    s = c.list && c.list.length ? `${col} in (${c.list.map(lit).join(", ")})` : "false";
  } else if (c.op === "is") {
    const v = c.value.toLowerCase();
    if (!["null", "true", "false", "unknown", "not_null"].includes(v)) {
      throw new ApiError(400, "PGRST100", `is n'accepte que null, true, false ou unknown (reçu : « ${c.value} »)`);
    }
    s = v === "not_null" ? `${col} is not null` : `${col} is ${v}`;
  } else if (c.op === "isdistinct") {
    s = `${col} is distinct from ${lit(c.value)}`;
  } else if (c.op in FTS) {
    s = `${col} @@ ${FTS[c.op]}(${c.ftsConfig ? `${lit(c.ftsConfig)}, ` : ""}${lit(c.value)})`;
  } else {
    throw new ApiError(400, "PGRST100", `Opérateur non pris en charge : ${c.op}`);
  }
  return c.negate ? `not (${s})` : s;
}

export function filterSql(alias: string, f: Filter): string {
  if (f.type === "cond") return conditionSql(alias, f);
  const parts = f.children.map((c) => filterSql(alias, c));
  const joined = parts.length ? `(${parts.join(f.op === "and" ? " and " : " or ")})` : (f.op === "and" ? "true" : "false");
  return f.negate ? `not ${joined}` : joined;
}

function orderSql(alias: string, level: Level | undefined): string {
  if (!level?.order.length) return "";
  return ` order by ${level.order.map((o) =>
    `${fieldSql(alias, o.field)} ${o.desc ? "desc" : "asc"}${o.nulls ? ` nulls ${o.nulls}` : ""}`).join(", ")}`;
}

function pageSql(level: Level | undefined): string {
  return `${level?.limit != null ? ` limit ${level.limit}` : ""}${level?.offset != null ? ` offset ${level.offset}` : ""}`;
}

// ── Relations ───────────────────────────────────────────────────────────────

export interface Relationship {
  kind: "m2o" | "o2m" | "m2m";
  target: Table;
  fk: ForeignKey;
  junction?: { table: Table; toParent: ForeignKey; toTarget: ForeignKey };
}

const sameTable = (a: { schema: string; table: string }, t: Table) => a.schema === t.schema && a.table === t.name;
const covered = (cols: string[], t: Table) => t.uniques.some((u) => cols.every((c) => u.includes(c)))
  || (t.pk.length > 0 && cols.every((c) => t.pk.includes(c)));

export function resolveRelationship(cache: SchemaCache, parent: Table, embed: Extract<SelectItem, { type: "embed" }>): Relationship {
  const candidates: Relationship[] = [];
  const target = findTable(cache, parent.schema, embed.target) ?? findTable(cache, "public", embed.target);
  if (target) {
    for (const fk of cache.fks) {
      if (sameTable(fk.from, parent) && sameTable(fk.to, target)) candidates.push({ kind: "m2o", target, fk });
      if (sameTable(fk.from, target) && sameTable(fk.to, parent)) candidates.push({ kind: "o2m", target, fk });
    }
    // Plusieurs-à-plusieurs : une table de jointure avec une clé vers chacune,
    // les deux couvertes par sa clé primaire ou une contrainte unique.
    for (const j of cache.tables.values()) {
      if (j.kind !== "table" || (j.schema === parent.schema && j.name === parent.name) || (j.schema === target.schema && j.name === target.name)) continue;
      const toParent = cache.fks.filter((fk) => sameTable(fk.from, j) && sameTable(fk.to, parent));
      const toTarget = cache.fks.filter((fk) => sameTable(fk.from, j) && sameTable(fk.to, target));
      for (const a of toParent) for (const b of toTarget) {
        if (covered([...a.from.columns, ...b.from.columns], j)) {
          candidates.push({ kind: "m2m", target, fk: b, junction: { table: j, toParent: a, toTarget: b } });
        }
      }
    }
  } else {
    // Désignée par une colonne ou une contrainte de la table parente.
    for (const fk of cache.fks) {
      if (!sameTable(fk.from, parent)) continue;
      if (fk.name === embed.target || (fk.from.columns.length === 1 && fk.from.columns[0] === embed.target)) {
        const t = findTable(cache, fk.to.schema, fk.to.table);
        if (t) candidates.push({ kind: "m2o", target: t, fk });
      }
    }
  }

  let found = candidates;
  for (const hint of embed.hints) {
    found = found.filter((r) =>
      r.fk.name === hint
      || (r.kind === "m2o" && r.fk.from.columns.length === 1 && r.fk.from.columns[0] === hint)
      || (r.kind === "o2m" && r.fk.from.columns.length === 1 && r.fk.from.columns[0] === hint)
      || (r.kind === "m2m" && (r.junction!.table.name === hint || r.junction!.toParent.name === hint))
      || r.target.name === hint);
  }
  // Une clé directe l'emporte sur une table de jointure, comme dans PostgREST.
  if (found.length > 1 && found.some((r) => r.kind !== "m2m")) found = found.filter((r) => r.kind !== "m2m");

  if (found.length === 0) {
    throw new ApiError(400, "PGRST200",
      `Could not find a relationship between '${parent.name}' and '${embed.target}' in the schema cache`,
      `Searched for a foreign key relationship between '${parent.name}' and '${embed.target}'${embed.hints.length ? ` using the hint '${embed.hints.join("!")}'` : ""} in the schema '${parent.schema}', but no matches were found.`);
  }
  if (found.length > 1) {
    throw new ApiError(300, "PGRST201",
      `Could not embed because more than one relationship was found for '${parent.name}' and '${embed.target}'`,
      found.map((r) => `${r.kind} via ${r.fk.name}`).join("; "),
      `Try changing '${embed.target}' to one of the following: ${found.map((r) => `'${embed.target}!${r.fk.name}'`).join(", ")}.`);
  }
  return found[0];
}

function joinCondition(rel: Relationship, parentAlias: string, childAlias: string): string {
  const eq = (a: string, ac: string, b: string, bc: string) => `${ident(a)}.${ident(ac)} = ${ident(b)}.${ident(bc)}`;
  if (rel.kind === "m2o") {
    return rel.fk.from.columns.map((c, i) => eq(childAlias, rel.fk.to.columns[i], parentAlias, c)).join(" and ");
  }
  if (rel.kind === "o2m") {
    return rel.fk.from.columns.map((c, i) => eq(childAlias, c, parentAlias, rel.fk.to.columns[i])).join(" and ");
  }
  const j = rel.junction!;
  const jAlias = `${childAlias}_j`;
  const toParent = j.toParent.from.columns.map((c, i) => eq(jAlias, c, parentAlias, j.toParent.to.columns[i])).join(" and ");
  const toTarget = j.toTarget.from.columns.map((c, i) => eq(jAlias, c, childAlias, j.toTarget.to.columns[i])).join(" and ");
  return `exists (select 1 from ${qualified(j.table)} as ${ident(jAlias)} where ${toParent} and ${toTarget})`;
}

// ── La liste de sélection ───────────────────────────────────────────────────

export interface SelectCtx {
  cache: SchemaCache;
  query: ParsedQuery;
  n: number;
}

interface SelectOut { cols: string[]; inner: string[] }

/**
 * `levelPath` : le chemin des ressources imbriquées jusqu'ici, par alias (ou
 * nom). Les filtres `rel.col=…`, `rel.order=…`, `rel.limit=…` s'y rattachent.
 */
export function selectList(ctx: SelectCtx, table: Table | null, alias: string, items: SelectItem[], levelPath: string): SelectOut {
  const cols: string[] = [];
  const inner: string[] = [];
  for (const item of items) {
    if (item.type === "star") { cols.push(`${ident(alias)}.*`); continue; }
    if (item.type === "field") {
      if (table && !item.field.path.length && !table.columns.has(item.field.name)) {
        throw new ApiError(400, "42703", `column ${table.name}.${item.field.name} does not exist`);
      }
      let e = fieldSql(alias, item.field);
      if (item.cast) e = `(${e})::${item.cast}`;
      cols.push(`${e} as ${ident(item.alias ?? fieldOutputName(item.field))}`);
      continue;
    }
    if (!table) throw new ApiError(400, "PGRST100", "Une ressource imbriquée n'est possible que depuis une table.");
    if (item.spread) throw new ApiError(400, "PGRST100", "La syntaxe « ...rel() » n'est pas prise en charge par ce serveur.");
    const rel = resolveRelationship(ctx.cache, table, item);
    const name = item.alias ?? item.target;
    const childPath = levelPath ? `${levelPath}.${name}` : name;
    const level = ctx.query.levels.get(childPath)
      ?? (item.alias ? ctx.query.levels.get(levelPath ? `${levelPath}.${item.target}` : item.target) : undefined);
    const childAlias = `pgrst_${ctx.n++}`;
    const sub = selectList(ctx, rel.target, childAlias, item.items, childPath);
    const where = [
      joinCondition(rel, alias, childAlias),
      ...(level?.filters ?? []).map((f) => filterSql(childAlias, f)),
      ...sub.inner,
    ].join(" and ");
    const from = `${qualified(rel.target)} as ${ident(childAlias)}`;
    const row = `${childAlias}_r`;
    if (rel.kind === "m2o") {
      cols.push(`(select row_to_json(${ident(row)}) from (select ${sub.cols.join(", ")} from ${from} where ${where} limit 1) ${ident(row)}) as ${ident(name)}`);
    } else {
      cols.push(`coalesce((select json_agg(${ident(row)}) from (select ${sub.cols.join(", ")} from ${from} where ${where}${orderSql(childAlias, level)}${pageSql(level)}) ${ident(row)}), '[]'::json) as ${ident(name)}`);
    }
    if (item.inner) inner.push(`exists (select 1 from ${from} where ${where})`);
  }
  if (!cols.length) cols.push(`${ident(alias)}.*`);
  return { cols, inner };
}

// ── Lectures ────────────────────────────────────────────────────────────────

export interface BuiltRead { sql: string; params: unknown[] }

/** `source` : une table, ou l'appel d'une fonction (rpc) qui rend des lignes. */
export function buildRead(cache: SchemaCache, query: ParsedQuery, source: {
  table: Table | null; from: string; alias: string; params?: unknown[];
}, opts: { count: boolean; scalarSet?: boolean; single?: boolean }): BuiltRead {
  const ctx: SelectCtx = { cache, query, n: 0 };
  const top = query.levels.get("");
  const sel = selectList(ctx, source.table, source.alias, query.select, "");
  const conds = [...(top?.filters ?? []).map((f) => filterSql(source.alias, f)), ...sel.inner];
  const where = conds.length ? ` where ${conds.join(" and ")}` : "";
  const main = `select ${opts.scalarSet ? `${ident(source.alias)}.${ident(source.alias)}` : sel.cols.join(", ")} from ${source.from}${where}${orderSql(source.alias, top)}${pageSql(top)}`;
  const agg = opts.scalarSet
    ? `coalesce(json_agg(_pgrst_r.${ident(source.alias)}), '[]'::json)::text`
    : `coalesce(json_agg(_pgrst_r), '[]'::json)::text`;
  const total = opts.count ? `, (select count(*) from ${source.from}${where})::bigint as total` : "";
  return { sql: `select ${agg} as body, count(*)::int as n${total} from (${main}) _pgrst_r`, params: source.params ?? [] };
}

// ── Écritures ───────────────────────────────────────────────────────────────

export type Returning = "minimal" | "representation";

function checkColumns(table: Table, cols: string[]) {
  for (const c of cols) {
    if (!table.columns.has(c)) {
      throw new ApiError(400, "PGRST204", `Could not find the '${c}' column of '${table.name}' in the schema cache`);
    }
  }
}

function wrapMutation(cache: SchemaCache, query: ParsedQuery, table: Table, mutation: string, returning: Returning, params: unknown[]): BuiltRead {
  if (returning === "minimal") return { sql: mutation, params };
  const ctx: SelectCtx = { cache, query, n: 0 };
  const alias = table.name;
  const sel = selectList(ctx, table, alias, query.select, "");
  const where = sel.inner.length ? ` where ${sel.inner.join(" and ")}` : "";
  return {
    sql: `with pgrst_mut as (${mutation} returning *)
select coalesce(json_agg(_pgrst_r), '[]'::json)::text as body, count(*)::int as n
  from (select ${sel.cols.join(", ")} from pgrst_mut as ${ident(alias)}${where}) _pgrst_r`,
    params,
  };
}

export function buildInsert(cache: SchemaCache, query: ParsedQuery, table: Table, rows: Record<string, unknown>[], opts: {
  returning: Returning;
  upsert: "merge" | "ignore" | null;
}): BuiltRead {
  if (table.kind === "view" && opts.upsert) throw new ApiError(405, "PGRST105", "Upsert impossible sur une vue.");
  const cols = query.columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  checkColumns(table, cols);
  const t = qualified(table);
  let ins: string;
  if (!cols.length) {
    if (rows.length > 1) throw new ApiError(400, "PGRST102", "Plusieurs lignes vides : précisez au moins une colonne.");
    ins = `insert into ${t} as ${ident(table.name)} default values`;
  } else {
    const list = cols.map(ident).join(", ");
    ins = `insert into ${t} as ${ident(table.name)} (${list}) select ${list} from json_populate_recordset(null::${t}, $1::json)`;
  }
  if (opts.upsert) {
    const target = query.onConflict ?? table.pk;
    if (!target.length) throw new ApiError(400, "PGRST100", `Upsert sur ${table.name} : aucune clé de conflit (on_conflict) ni clé primaire.`);
    checkColumns(table, target);
    const updatable = cols.filter((c) => !target.includes(c));
    ins += opts.upsert === "ignore" || !updatable.length
      ? ` on conflict (${target.map(ident).join(", ")}) do nothing`
      : ` on conflict (${target.map(ident).join(", ")}) do update set ${updatable.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
  }
  return wrapMutation(cache, query, table, ins, opts.returning, cols.length ? [JSON.stringify(rows)] : []);
}

export function buildUpdate(cache: SchemaCache, query: ParsedQuery, table: Table, patch: Record<string, unknown>, returning: Returning): BuiltRead | null {
  const cols = Object.keys(patch);
  if (!cols.length) return null;
  checkColumns(table, cols);
  const alias = table.name;
  const top = query.levels.get("");
  const conds = (top?.filters ?? []).map((f) => filterSql(alias, f));
  const list = cols.map(ident).join(", ");
  const upd = `update ${qualified(table)} as ${ident(alias)} set (${list}) = (select ${list} from json_populate_record(null::${qualified(table)}, $1::json))${conds.length ? ` where ${conds.join(" and ")}` : ""}`;
  return wrapMutation(cache, query, table, upd, returning, [JSON.stringify(patch)]);
}

export function buildDelete(cache: SchemaCache, query: ParsedQuery, table: Table, returning: Returning): BuiltRead {
  const alias = table.name;
  const top = query.levels.get("");
  const conds = (top?.filters ?? []).map((f) => filterSql(alias, f));
  const del = `delete from ${qualified(table)} as ${ident(alias)}${conds.length ? ` where ${conds.join(" and ")}` : ""}`;
  return wrapMutation(cache, query, table, del, returning, []);
}

// ── Fonctions (rpc) ─────────────────────────────────────────────────────────

/** La surcharge qui accepte exactement ces arguments nommés. */
export function pickFunction(fns: Fn[], given: string[]): Fn | null {
  const ok = fns.filter((f) => {
    const names = new Set(f.args.map((a) => a.name));
    return given.every((g) => names.has(g)) && f.args.every((a) => a.hasDefault || given.includes(a.name));
  });
  ok.sort((a, b) => a.args.length - b.args.length);
  return ok[0] ?? null;
}

/** `fn(a := …, b := …)`, chaque argument lu dans le corps JSON ($1). */
export function callSql(fn: Fn, given: Set<string>, body: Record<string, unknown>): string {
  const args = fn.args.filter((a) => given.has(a.name)).map((a) => {
    const v = body[a.name];
    const path = `($1::json -> ${lit(a.name)})`;
    let expr: string;
    if (v === null || v === undefined) expr = `null::${a.type}`;
    else if (a.isJson) expr = `${path}::${a.type}`;
    else if (a.isArray && Array.isArray(v)) {
      expr = `(select array_agg(e) from json_array_elements_text(${path}) e)::${a.type}`;
    } else expr = `($1::json ->> ${lit(a.name)})::${a.type}`;
    return `${ident(a.name)} := ${expr}`;
  });
  return `${ident(fn.schema)}.${ident(fn.name)}(${args.join(", ")})`;
}
