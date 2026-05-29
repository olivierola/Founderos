// dashboard-data — resolves a widget's datasource and returns rows/series.
// Body: { workspace_id, project_id, source }
// source = {
//   kind: "internal" | "metrics" | "static",
//   table?: string,                 // internal table (whitelisted)
//   metric?: string,                // metrics_snapshots key for time series
//   aggregate?: { fn, column } | null,  // count/sum/avg/min/max
//   group_by?: string | null,       // single column group
//   filters?: [{column,op,value}],
//   order_by?: string, order_dir?: "asc"|"desc",
//   limit?: number,
//   rows?: any[]                    // for static
// }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

// Truncate a date-ish value to day/week/month bucket (ISO string key).
function bucketDate(raw: unknown, unit: string): string | null {
  if (raw == null) return null;
  const d = new Date(String(raw));
  if (isNaN(d.getTime())) return null;
  if (unit === "month") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  if (unit === "week") {
    // ISO-ish week start (Monday) in UTC
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10); // day
}

function calcAgg(fn: string, vals: number[]): number {
  if (fn === "count") return vals.length;
  if (vals.length === 0) return 0;
  if (fn === "sum") return vals.reduce((a, b) => a + b, 0);
  if (fn === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (fn === "min") return Math.min(...vals);
  if (fn === "max") return Math.max(...vals);
  if (fn === "count_distinct") return new Set(vals).size;
  return vals.length;
}

function aggregateRows(
  list: Record<string, unknown>[],
  fn: string,
  column: string,
  groupBy?: string | null,
  bucket?: { column: string; unit: string } | null,
) {
  // Time-bucketed grouping takes precedence (date series).
  if (bucket?.column && bucket.unit && bucket.unit !== "none") {
    const groups = new Map<string, unknown[]>();
    for (const r of list) {
      const k = bucketDate(r[bucket.column], bucket.unit);
      if (k == null) continue;
      const arr = groups.get(k) ?? [];
      arr.push(fn === "count" ? 1 : fn === "count_distinct" ? r[column] : Number(r[column] ?? 0));
      groups.set(k, arr);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, vals]) => ({ date, value: calcAgg(fn, vals as number[]) }));
  }
  if (groupBy) {
    const groups = new Map<string, unknown[]>();
    for (const r of list) {
      const k = String(r[groupBy] ?? "—");
      const arr = groups.get(k) ?? [];
      arr.push(fn === "count" ? 1 : fn === "count_distinct" ? r[column] : Number(r[column] ?? 0));
      groups.set(k, arr);
    }
    return [...groups.entries()].map(([label, vals]) => ({ label, value: calcAgg(fn, vals as number[]) }));
  }
  const vals = fn === "count"
    ? list.map(() => 1)
    : fn === "count_distinct"
      ? (list.map((r) => r[column]) as number[])
      : list.map((r) => Number(r[column] ?? 0));
  return [{ value: calcAgg(fn, vals) }];
}

// Tables a widget may read. All are workspace/project-scoped via project_id.
const INTERNAL_TABLES = new Set([
  "customers",
  "subscriptions",
  "invoices",
  "revenue_records",
  "cost_records",
  "llm_usage",
  "scan_results",
  "product_events",
  "alerts",
  "activity_logs",
  "deployments",
  "error_events",
  "incidents",
]);

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id, source } = await req.json();
    if (!workspace_id || !project_id || !source) {
      return jsonResponse({ error: "workspace_id, project_id, source required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // --- static values ---
    if (source.kind === "static") {
      return jsonResponse({ rows: Array.isArray(source.rows) ? source.rows : [] });
    }

    // --- metrics time series ---
    if (source.kind === "metrics") {
      const { data } = await admin
        .from("metrics_snapshots")
        .select("snapshot_date, metrics")
        .eq("project_id", project_id)
        .order("snapshot_date", { ascending: true })
        .limit(Math.min(Number(source.limit ?? 90), 365));
      const key = source.metric ?? "mrr_cents";
      const rows = (data ?? []).map((s: any) => ({
        date: s.snapshot_date,
        value: (s.metrics?.[key] ?? 0) / (key.endsWith("_cents") ? 100 : 1),
      }));
      return jsonResponse({ rows });
    }

    // --- internal tables ---
    if (source.kind === "internal") {
      const table = String(source.table);
      if (!INTERNAL_TABLES.has(table)) return jsonResponse({ error: `Table ${table} not allowed` }, { status: 400 });

      // Aggregation path
      if (source.aggregate?.fn) {
        let q = admin.from(table).select("*").eq("project_id", project_id).limit(5000);
        for (const f of source.filters ?? []) {
          if (!f.column || !f.op) continue;
          if (f.op === "=") q = q.eq(f.column, f.value);
          else if (f.op === "!=") q = q.neq(f.column, f.value);
          else if (f.op === ">") q = q.gt(f.column, f.value);
          else if (f.op === "<") q = q.lt(f.column, f.value);
          else if (f.op === "contains") q = q.ilike(f.column, `%${f.value}%`);
        }
        const { data } = await q;
        const rows = aggregateRows(data ?? [], source.aggregate.fn, source.aggregate.column, source.group_by, source.bucket);
        return jsonResponse({ rows });
      }

      // Plain rows
      let q = admin.from(table).select(source.columns?.length ? source.columns.join(",") : "*").eq("project_id", project_id);
      for (const f of source.filters ?? []) {
        if (!f.column || !f.op) continue;
        if (f.op === "=") q = q.eq(f.column, f.value);
        else if (f.op === "!=") q = q.neq(f.column, f.value);
        else if (f.op === ">") q = q.gt(f.column, f.value);
        else if (f.op === "<") q = q.lt(f.column, f.value);
        else if (f.op === "contains") q = q.ilike(f.column, `%${f.value}%`);
      }
      if (source.order_by) q = q.order(source.order_by, { ascending: source.order_dir !== "desc" });
      q = q.limit(Math.min(Number(source.limit ?? 100), 500));
      const { data, error } = await q;
      if (error) return jsonResponse({ error: error.message }, { status: 400 });
      return jsonResponse({ rows: data ?? [] });
    }

    // --- connected project DB (Supabase via stored service key) ---
    if (source.kind === "project_db") {
      let cred: Record<string, string>;
      try {
        ({ payload: cred } = await getConnectorCredential(workspace_id, project_id, "supabase"));
      } catch {
        return jsonResponse({ error: "Project database not connected" }, { status: 400 });
      }
      if (!cred.project_url || !cred.service_role_key) {
        return jsonResponse({ error: "Supabase project_url + service_role_key required" }, { status: 400 });
      }
      const base = cred.project_url.replace(/\/$/, "");
      const headers = {
        apikey: cred.service_role_key,
        Authorization: `Bearer ${cred.service_role_key}`,
      };
      const table = String(source.table);
      const params = new URLSearchParams();
      params.set("select", source.columns?.length ? source.columns.join(",") : "*");
      params.set("limit", String(Math.min(Number(source.limit ?? 1000), 5000)));
      const opMap: Record<string, string> = { "=": "eq", "!=": "neq", ">": "gt", "<": "lt", contains: "ilike" };
      for (const f of source.filters ?? []) {
        if (!f.column || !f.op) continue;
        const pgop = opMap[f.op] ?? "eq";
        params.append(f.column, `${pgop}.${f.op === "contains" ? `*${f.value}*` : f.value}`);
      }
      const res = await fetch(`${base}/rest/v1/${table}?${params.toString()}`, { headers });
      if (!res.ok) return jsonResponse({ error: `project_db query failed: ${(await res.text()).slice(0, 200)}` }, { status: 400 });
      const list = (await res.json()) as Record<string, unknown>[];
      if (source.aggregate?.fn) {
        return jsonResponse({ rows: aggregateRows(list, source.aggregate.fn, source.aggregate.column, source.group_by, source.bucket) });
      }
      return jsonResponse({ rows: list });
    }

    return jsonResponse({ error: `Unknown source kind ${source.kind}` }, { status: 400 });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
