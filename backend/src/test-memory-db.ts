// Tests : une base en mémoire qui répond comme le client Supabase, pour les
// requêtes simples (select, insert, upsert, update, delete ; eq, in, is,
// limit, maybeSingle). Chaque table est une liste de lignes.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export function memoryDb(tables: Record<string, Row[]> = {}, keys: Record<string, string> = {}) {
  const table = (name: string) => (tables[name] ??= []);
  const from = (name: string) => {
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limit = Infinity;
    let single = false;
    const run = () => {
      const rows = table(name);
      const match = (r: Row) => filters.every((f) => f(r));
      if (op === "insert" || op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const key = keys[name] ?? "id";
        for (const p of list) {
          const existing = op === "upsert" ? rows.find((r) => r[key] === p[key]) : undefined;
          if (existing) Object.assign(existing, p); else rows.push({ ...p });
        }
        return { data: list, error: null };
      }
      if (op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (op === "delete") {
        const keep = rows.filter((r) => !match(r));
        tables[name] = keep;
        return { data: null, error: null };
      }
      const hit = rows.filter(match).slice(0, limit).map((r) => ({ ...r }));
      return { data: single ? hit[0] ?? null : hit, error: null };
    };
    const q: any = {
      select: () => q,
      insert: (p: any) => { op = "insert"; payload = p; return q; },
      upsert: (p: any) => { op = "upsert"; payload = p; return q; },
      update: (p: any) => { op = "update"; payload = p; return q; },
      delete: () => { op = "delete"; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      limit: (n: number) => { limit = n; return q; },
      order: () => q,
      maybeSingle: () => { single = true; return q; },
      single: () => { single = true; return q; },
      then: (resolve: (v: any) => void, reject: (e: unknown) => void) => {
        try { resolve(run()); } catch (e) { reject(e); }
      },
    };
    return q;
  };
  return { admin: { from } as any, tables };
}
