// Firestore CRUD adapter for db-admin. Maps Firestore onto the console's
// table/row model: collections are "tables", documents are "rows".
//
// Firestore stores typed values; we convert to/from plain JSON for the UI.
import { jsonResponse } from "../_shared/cors.ts";

const API = "https://firestore.googleapis.com/v1";

type Json = Record<string, unknown>;

interface OpArgs {
  projectId: string;
  token: string;
  op: string;
  body: Json;
}

function docPath(projectId: string, rest = ""): string {
  return `${API}/projects/${projectId}/databases/(default)/documents${rest}`;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Firestore typed value → plain JS.
function fromFsValue(v: Json): unknown {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) {
    const f = (v.mapValue as Json).fields as Json ?? {};
    return Object.fromEntries(Object.entries(f).map(([k, val]) => [k, fromFsValue(val as Json)]));
  }
  if ("arrayValue" in v) {
    const vals = ((v.arrayValue as Json).values as Json[]) ?? [];
    return vals.map((x) => fromFsValue(x));
  }
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  return JSON.stringify(v);
}

// Plain JS → Firestore typed value.
function toFsValue(v: unknown): Json {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(v as Json).map(([k, val]) => [k, toFsValue(val)])) } };
  }
  // strings (incl. ISO timestamps kept as strings for simplicity)
  return { stringValue: String(v) };
}

function fsDocToRow(doc: Json): Json {
  const fields = (doc.fields as Json) ?? {};
  const row: Json = {};
  for (const [k, val] of Object.entries(fields)) row[k] = fromFsValue(val as Json);
  // Surface the document id as a stable primary key.
  const name = String(doc.name ?? "");
  row.id = name.split("/").pop() ?? "";
  return row;
}

export async function firestoreOp(args: OpArgs): Promise<Response> {
  const { projectId, token, op, body } = args;
  const h = authHeaders(token);

  switch (op) {
    case "list_tables": {
      // Collections → tables. Columns are inferred from the first few docs.
      const res = await fetch(docPath(projectId, ":listCollectionIds"), { method: "POST", headers: h, body: "{}" });
      if (!res.ok) return jsonResponse({ error: `Firestore listCollectionIds ${res.status}` }, { status: 400 });
      const json = await res.json();
      const ids: string[] = json.collectionIds ?? [];
      const tables = [];
      for (const name of ids) {
        // Sample one document to infer columns.
        const sample = await fetch(docPath(projectId, `/${encodeURIComponent(name)}?pageSize=1`), { headers: h });
        let columns: Array<{ name: string; type: string; nullable: boolean; is_pk?: boolean }> = [
          { name: "id", type: "string", nullable: false, is_pk: true },
        ];
        if (sample.ok) {
          const sj = await sample.json();
          const doc = (sj.documents ?? [])[0];
          if (doc?.fields) {
            columns = [
              { name: "id", type: "string", nullable: false, is_pk: true },
              ...Object.entries(doc.fields as Json).map(([cName, val]) => ({
                name: cName,
                type: Object.keys(val as Json)[0]?.replace("Value", "") ?? "string",
                nullable: true,
              })),
            ];
          }
        }
        tables.push({ name, columns });
      }
      return jsonResponse({ tables });
    }

    case "list_rows":
    case "query": {
      const table = String(body.table);
      const limit = Math.min(Number(body.limit ?? 50), 300);
      const res = await fetch(docPath(projectId, `/${encodeURIComponent(table)}?pageSize=${limit}`), { headers: h });
      if (!res.ok) return jsonResponse({ error: `Firestore list ${res.status}: ${(await res.text()).slice(0, 160)}` }, { status: 400 });
      const json = await res.json();
      let rows = (json.documents ?? []).map(fsDocToRow);
      // Client-style filtering for the query builder (Firestore REST structured
      // queries are limited; we filter in-memory on the page for simplicity).
      const filters: Array<{ column: string; op: string; value: string }> = body.filters ?? [];
      for (const f of filters) {
        if (!f.column || !f.op) continue;
        rows = rows.filter((r: Json) => {
          const cell = r[f.column];
          const val = f.value;
          switch (f.op) {
            case "=": return String(cell) === val;
            case "!=": return String(cell) !== val;
            case ">": return Number(cell) > Number(val);
            case ">=": return Number(cell) >= Number(val);
            case "<": return Number(cell) < Number(val);
            case "<=": return Number(cell) <= Number(val);
            case "contains": return String(cell ?? "").toLowerCase().includes(val.toLowerCase());
            case "starts_with": return String(cell ?? "").toLowerCase().startsWith(val.toLowerCase());
            case "is_null": return cell == null;
            default: return true;
          }
        });
      }
      return jsonResponse({ rows, query: `firestore:${table}` });
    }

    case "insert_row": {
      const table = String(body.table);
      const values = (body.values ?? {}) as Json;
      const fields = Object.fromEntries(
        Object.entries(values).filter(([k]) => k !== "id").map(([k, v]) => [k, toFsValue(v)]),
      );
      const res = await fetch(docPath(projectId, `/${encodeURIComponent(table)}`), {
        method: "POST", headers: h, body: JSON.stringify({ fields }),
      });
      if (!res.ok) return jsonResponse({ error: `Firestore insert ${res.status}: ${(await res.text()).slice(0, 160)}` }, { status: 400 });
      return jsonResponse({ row: fsDocToRow(await res.json()) });
    }

    case "delete_row": {
      const table = String(body.table);
      const id = String(body.pk_val);
      const res = await fetch(docPath(projectId, `/${encodeURIComponent(table)}/${encodeURIComponent(id)}`), {
        method: "DELETE", headers: h,
      });
      if (!res.ok) return jsonResponse({ error: `Firestore delete ${res.status}` }, { status: 400 });
      return jsonResponse({ ok: true });
    }

    default:
      return jsonResponse({ error: `Op ${op} not supported for Firestore` }, { status: 400 });
  }
}
