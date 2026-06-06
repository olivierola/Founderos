// Postgres / Neon CRUD adapter for db-admin. Connects directly over the wire
// protocol using a connection string (works for Neon, Supabase direct, RDS, …).
// Tables/columns come from information_schema; rows via parameterised SQL.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { jsonResponse } from "../_shared/cors.ts";

type Json = Record<string, unknown>;

interface OpArgs {
  connStr: string;
  op: string;
  body: Json;
}

// Quote an identifier safely for interpolation (we never interpolate values —
// those are bound as parameters).
function qIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

export async function postgresOp(args: OpArgs): Promise<Response> {
  const { connStr, op, body } = args;
  const client = new Client(connStr);
  try {
    await client.connect();

    switch (op) {
      case "list_tables": {
        const cols = await client.queryObject<{
          table_name: string; column_name: string; data_type: string; is_nullable: string;
        }>(`
          select table_name, column_name, data_type, is_nullable
          from information_schema.columns
          where table_schema = 'public'
          order by table_name, ordinal_position
        `);
        // Primary keys per table.
        const pks = await client.queryObject<{ table_name: string; column_name: string }>(`
          select tc.table_name, kcu.column_name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
          where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
        `);
        const pkSet = new Set(pks.rows.map((r) => `${r.table_name}.${r.column_name}`));
        const byTable = new Map<string, Array<{ name: string; type: string; nullable: boolean; is_pk: boolean }>>();
        for (const c of cols.rows) {
          const arr = byTable.get(c.table_name) ?? [];
          arr.push({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === "YES",
            is_pk: pkSet.has(`${c.table_name}.${c.column_name}`),
          });
          byTable.set(c.table_name, arr);
        }
        const tables = [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
        return jsonResponse({ tables });
      }

      case "list_rows": {
        const table = qIdent(String(body.table));
        const limit = Math.min(Number(body.limit ?? 50), 200);
        const res = await client.queryObject(`select * from ${table} limit ${limit}`);
        return jsonResponse({ rows: res.rows });
      }

      case "query": {
        const table = qIdent(String(body.table));
        const columns: string[] = Array.isArray(body.columns) ? body.columns : [];
        const filters: Array<{ column: string; op: string; value: string }> = body.filters ?? [];
        const sorts: Array<{ column: string; dir: "asc" | "desc" }> = body.sorts ?? [];
        const limit = Math.min(Number(body.limit ?? 50), 500);
        const offset = Math.max(Number(body.offset ?? 0), 0);

        const sel = columns.length ? columns.map(qIdent).join(", ") : "*";
        const where: string[] = [];
        const params: unknown[] = [];
        const opMap: Record<string, string> = {
          "=": "=", "!=": "<>", ">": ">", ">=": ">=", "<": "<", "<=": "<=",
          contains: "ilike", starts_with: "ilike",
        };
        for (const f of filters) {
          if (!f.column || !f.op) continue;
          const col = qIdent(f.column);
          if (f.op === "is_null") { where.push(`${col} is null`); continue; }
          const sqlOp = opMap[f.op] ?? "=";
          let val: string = f.value;
          if (f.op === "contains") val = `%${f.value}%`;
          else if (f.op === "starts_with") val = `${f.value}%`;
          params.push(val);
          where.push(`${col} ${sqlOp} $${params.length}`);
        }
        const order = sorts.filter((s) => s.column).map((s) => `${qIdent(s.column)} ${s.dir === "desc" ? "desc" : "asc"}`);
        let sql = `select ${sel} from ${table}`;
        if (where.length) sql += ` where ${where.join(" and ")}`;
        if (order.length) sql += ` order by ${order.join(", ")}`;
        sql += ` limit ${limit} offset ${offset}`;
        const res = await client.queryObject(sql, params);
        return jsonResponse({ rows: res.rows, query: sql });
      }

      case "insert_row": {
        const table = qIdent(String(body.table));
        const values = (body.values ?? {}) as Json;
        const keys = Object.keys(values);
        if (keys.length === 0) return jsonResponse({ error: "No values" }, { status: 400 });
        const cols = keys.map(qIdent).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const params = keys.map((k) => values[k]);
        const res = await client.queryObject(
          `insert into ${table} (${cols}) values (${placeholders}) returning *`,
          params,
        );
        return jsonResponse({ row: res.rows[0] ?? null });
      }

      case "delete_row": {
        const table = qIdent(String(body.table));
        const pkCol = qIdent(String(body.pk_col));
        await client.queryObject(`delete from ${table} where ${pkCol} = $1`, [String(body.pk_val)]);
        return jsonResponse({ ok: true });
      }

      default:
        return jsonResponse({ error: `Op ${op} not supported for Postgres` }, { status: 400 });
    }
  } catch (e) {
    return jsonResponse({ error: `Postgres: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}
