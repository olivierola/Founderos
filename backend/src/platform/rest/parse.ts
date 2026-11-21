// Analyse de l'URL d'une requête PostgREST — ce que supabase-js envoie.
//
//   select=id,name,alias:col->>key::text,rel!fkey!inner(id,sub(*))
//   col=eq.1  col=not.is.null  col=in.(a,b,"c,d")  or=(a.eq.1,and(b.gt.2,c.lt.3))
//   order=col.desc.nullslast  limit=10  offset=20  rel.col=eq.x  rel.order=…
//
// Pur : aucune connaissance du schéma ni de SQL (voir sql.ts).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

const bad = (message: string, details: string | null = null) => new ApiError(400, "PGRST100", message, details);

// ── Champs (colonne + chemin JSON + conversion) ─────────────────────────────

export interface Field {
  name: string;
  /** Chemin JSON : chaque pas dit s'il rend du texte (->>) ou du JSON (->). */
  path: Array<{ key: string; text: boolean }>;
}

const JSON_STEP = /(->>?)("(?:[^"\\]|\\.)*"|[^-]+?)(?=->|$)/g;

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s;
}

export function parseField(raw: string): Field {
  const s = raw.trim();
  const at = s.indexOf("->");
  const name = unquote(at < 0 ? s : s.slice(0, at)).trim();
  if (!name) throw bad(`Champ vide dans « ${raw} »`);
  const path: Field["path"] = [];
  if (at >= 0) {
    const rest = s.slice(at);
    let consumed = 0;
    for (const m of rest.matchAll(JSON_STEP)) {
      path.push({ key: unquote(m[2]), text: m[1] === "->>" });
      consumed += m[0].length;
    }
    if (consumed !== rest.length) throw bad(`Chemin JSON illisible : « ${raw} »`);
  }
  return { name, path };
}

// ── select ──────────────────────────────────────────────────────────────────

export type SelectItem =
  | { type: "star" }
  | { type: "field"; field: Field; alias: string | null; cast: string | null }
  | {
      type: "embed";
      /** La table (ou contrainte, ou colonne) désignée. */
      target: string;
      alias: string | null;
      hints: string[];
      inner: boolean;
      spread: boolean;
      items: SelectItem[];
    };

/** Coupe aux virgules de premier niveau (hors parenthèses et guillemets). */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && quoted) { cur += c + (s[i + 1] ?? ""); i++; continue; }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    if (!quoted && depth === 0 && c === sep) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (depth !== 0 || quoted) throw bad(`Parenthèses ou guillemets non fermés dans « ${s} »`);
  out.push(cur);
  return out;
}

export function parseSelect(raw: string | undefined | null): SelectItem[] {
  const s = (raw ?? "*").replace(/\s+(?=([^"]*"[^"]*")*[^"]*$)/g, "");
  if (!s) return [{ type: "star" }];
  return splitTop(s).filter((x) => x !== "").map(parseSelectItem);
}

function parseSelectItem(raw: string): SelectItem {
  if (raw === "*") return { type: "star" };
  const open = indexOfTop(raw, "(");
  if (open >= 0 && raw.endsWith(")")) {
    let head = raw.slice(0, open);
    const body = raw.slice(open + 1, -1);
    let spread = false;
    if (head.startsWith("...")) { spread = true; head = head.slice(3); }
    let alias: string | null = null;
    const colon = head.indexOf(":");
    if (colon >= 0) { alias = unquote(head.slice(0, colon)); head = head.slice(colon + 1); }
    const [target, ...hintList] = head.split("!");
    const hints: string[] = [];
    let inner = false;
    for (const h of hintList) {
      if (h === "inner") inner = true;
      else if (h === "left") inner = false;
      else if (h) hints.push(h);
    }
    if (!target) throw bad(`Ressource imbriquée sans nom : « ${raw} »`);
    return { type: "embed", target: unquote(target), alias, hints, inner, spread, items: parseSelect(body) };
  }
  let s = raw;
  let alias: string | null = null;
  // Un alias précède un « : » simple (pas le « :: » d'une conversion).
  const m = /^("(?:[^"\\]|\\.)*"|[^:"]+):(?!:)/.exec(s);
  if (m) { alias = unquote(m[1]); s = s.slice(m[0].length); }
  let cast: string | null = null;
  const c = s.lastIndexOf("::");
  if (c >= 0) { cast = s.slice(c + 2); s = s.slice(0, c); }
  if (cast !== null && !/^[a-z_][a-z0-9_ ]*(\[\])?$/i.test(cast)) throw bad(`Conversion refusée : « ${cast} »`);
  return { type: "field", field: parseField(s), alias, cast };
}

function indexOfTop(s: string, ch: string): number {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (!quoted && s[i] === ch) return i;
  }
  return -1;
}

// ── Filtres ─────────────────────────────────────────────────────────────────

export const OPERATORS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch",
  "in", "is", "isdistinct", "cs", "cd", "ov", "sl", "sr", "nxl", "nxr", "adj",
  "fts", "plfts", "phfts", "wfts",
]);

export interface Condition {
  type: "cond";
  field: Field;
  negate: boolean;
  op: string;
  /** Pour fts : la configuration (« fts(french).mot »). */
  ftsConfig: string | null;
  value: string;
  /** in.(…) : les valeurs, déjà découpées et déguillemetées. */
  list: string[] | null;
}
export interface Logic { type: "logic"; op: "and" | "or"; negate: boolean; children: Filter[] }
export type Filter = Condition | Logic;

/** `[not.]op[(config)].valeur` — la partie droite d'un filtre. */
export function parseOperation(field: Field, raw: string): Condition {
  let s = raw;
  let negate = false;
  if (s.startsWith("not.")) { negate = true; s = s.slice(4); }
  const dot = s.indexOf(".");
  if (dot < 0) throw bad(`Filtre illisible : « ${raw} »`, "Forme attendue : opérateur.valeur");
  let op = s.slice(0, dot);
  const value = s.slice(dot + 1);
  let ftsConfig: string | null = null;
  const fm = /^(fts|plfts|phfts|wfts)\(([a-z_]+)\)$/.exec(op);
  if (fm) { op = fm[1]; ftsConfig = fm[2]; }
  if (!OPERATORS.has(op)) throw bad(`Opérateur inconnu : « ${op} »`);
  let list: string[] | null = null;
  if (op === "in") {
    if (!value.startsWith("(") || !value.endsWith(")")) throw bad(`in attend une liste entre parenthèses : « ${value} »`);
    const inner = value.slice(1, -1);
    list = inner === "" ? [] : splitTop(inner).map((v) => unquote(v.trim()));
  }
  return { type: "cond", field, negate, op, ftsConfig, value, list };
}

/** Une liste logique : `(a.eq.1,b.not.is.null,and(c.gt.2,d.lt.3))`. */
export function parseLogic(op: "and" | "or", negate: boolean, raw: string): Logic {
  if (!raw.startsWith("(") || !raw.endsWith(")")) throw bad(`${op} attend une liste entre parenthèses : « ${raw} »`);
  const children = splitTop(raw.slice(1, -1)).map((part): Filter => {
    const p = part.trim();
    const lm = /^(not\.)?(and|or)(\(.*\))$/s.exec(p);
    if (lm) return parseLogic(lm[2] as "and" | "or", !!lm[1], lm[3]);
    // col.op.valeur — la colonne s'arrête au premier point hors chemin JSON
    // et hors guillemets.
    const at = fieldEnd(p);
    if (at < 0) throw bad(`Élément logique illisible : « ${p} »`);
    return parseOperation(parseField(p.slice(0, at)), p.slice(at + 1));
  });
  return { type: "logic", op, negate, children };
}

function fieldEnd(s: string): number {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ".") return i;
  }
  return -1;
}

// ── Tri ─────────────────────────────────────────────────────────────────────

export interface OrderTerm { field: Field; desc: boolean; nulls: "first" | "last" | null }

export function parseOrder(raw: string): OrderTerm[] {
  return splitTop(raw).filter(Boolean).map((part) => {
    const bits = part.split(".");
    const mods: string[] = [];
    while (bits.length > 1 && ["asc", "desc", "nullsfirst", "nullslast"].includes(bits[bits.length - 1])) {
      mods.unshift(bits.pop()!);
    }
    const field = parseField(bits.join("."));
    return {
      field,
      desc: mods.includes("desc"),
      nulls: mods.includes("nullsfirst") ? "first" : mods.includes("nullslast") ? "last" : null,
    };
  });
}

// ── La requête entière ──────────────────────────────────────────────────────

/** Ce qui s'applique à UN niveau : la table principale, ou une ressource imbriquée. */
export interface Level {
  filters: Filter[];
  order: OrderTerm[];
  limit: number | null;
  offset: number | null;
}

export interface ParsedQuery {
  select: SelectItem[];
  /** "" = la table principale ; "rel" ou "rel.sub" = une ressource imbriquée (par alias ou nom). */
  levels: Map<string, Level>;
  onConflict: string[] | null;
  columns: string[] | null;
}

const level = (levels: Map<string, Level>, key: string): Level => {
  let l = levels.get(key);
  if (!l) { l = { filters: [], order: [], limit: null, offset: null }; levels.set(key, l); }
  return l;
};

const int = (v: string, what: string): number => {
  if (!/^\d+$/.test(v)) throw bad(`${what} doit être un entier positif : « ${v} »`);
  return Number(v);
};

/** `params` : les paires de la query string, dans l'ordre, doublons compris. */
export function parseQuery(params: Array<[string, string]>, opts: { rpcArgs?: Set<string> } = {}): ParsedQuery {
  const out: ParsedQuery = { select: [{ type: "star" }], levels: new Map(), onConflict: null, columns: null };
  level(out.levels, "");
  for (const [key, value] of params) {
    if (key === "select") { out.select = parseSelect(value); continue; }
    if (key === "on_conflict") { out.onConflict = splitTop(value).map((c) => unquote(c.trim())).filter(Boolean); continue; }
    if (key === "columns") { out.columns = splitTop(value).map((c) => unquote(c.trim())).filter(Boolean); continue; }
    // Un argument de fonction passé en GET n'est pas un filtre.
    if (opts.rpcArgs?.has(key)) continue;

    // rel.sub.order / rel.limit / rel.or / rel.not.and
    const mod = /^(?:(.*?)\.)?(order|limit|offset)$/.exec(key);
    if (mod) {
      const l = level(out.levels, mod[1] ?? "");
      if (mod[2] === "order") l.order.push(...parseOrder(value));
      else if (mod[2] === "limit") l.limit = int(value, "limit");
      else l.offset = int(value, "offset");
      continue;
    }
    // La forme niée d'abord : sinon « not.or » se lirait comme le « or » d'une
    // ressource imbriquée nommée « not ».
    const neg = /^(?:(.*)\.)?not\.(and|or)$/.exec(key);
    const lg = neg ? null : /^(?:(.*)\.)?(and|or)$/.exec(key);
    if (neg || lg) {
      const m = (neg ?? lg)!;
      level(out.levels, m[1] ?? "").filters.push(parseLogic(m[2] as "and" | "or", !!neg, value));
      continue;
    }
    // Un filtre de colonne. Une colonne avec chemin JSON contient « -> » et
    // peut contenir des points : seuls les points AVANT le premier « -> »
    // séparent les ressources imbriquées.
    const arrow = key.indexOf("->");
    const base = arrow >= 0 ? key.slice(0, arrow) : key;
    const bdot = base.lastIndexOf(".");
    const embedPath = bdot >= 0 ? base.slice(0, bdot) : "";
    const col = bdot >= 0 ? key.slice(bdot + 1) : key;
    level(out.levels, embedPath).filters.push(parseOperation(parseField(col), value));
  }
  return out;
}
