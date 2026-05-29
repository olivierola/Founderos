// db-admin — no-SQL CRUD over the user's CONNECTED Supabase project.
// Uses the project's own URL + service_role key stored in the supabase connector.
// Body: { workspace_id, project_id, op, ...args }
//
// ops:
//   detect                      -> { configured, project_url }
//   list_tables                 -> { tables: [{ name, columns:[{name,type,nullable,is_identity}] }] }
//   list_rows  { table, limit } -> { rows: [...] }
//   insert_row { table, values }-> { row }
//   delete_row { table, pk_col, pk_val } -> { ok }
//   list_users { }             -> { users: [...] }   (auth admin)
//   create_user { email, password } -> { user }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

interface TargetCreds {
  provider: "supabase";
  url: string;
  serviceKey: string;
}

// Detect which database provider is connected and return its access info.
// Today: Supabase (Postgres/PostgREST). Firebase / Neon / PlanetScale slots
// are recognised so the UI can adapt, even before full CRUD is wired.
async function getTarget(workspaceId: string, projectId: string): Promise<TargetCreds | null> {
  try {
    const { payload } = await getConnectorCredential(workspaceId, projectId, "supabase");
    if (!payload.project_url || !payload.service_role_key) return null;
    return { provider: "supabase", url: payload.project_url.replace(/\/$/, ""), serviceKey: payload.service_role_key };
  } catch {
    return null;
  }
}

// Which DB-capable provider is connected (for UI adaptation messaging).
async function detectDbProvider(
  admin: ReturnType<typeof createServiceClient>,
  projectId: string,
): Promise<{ provider: string | null; crudReady: boolean }> {
  const { data } = await admin
    .from("connectors")
    .select("provider, metadata")
    .eq("project_id", projectId)
    .in("provider", ["supabase", "firebase", "neon", "planetscale", "upstash"]);
  const dbConn = (data ?? [])[0];
  if (!dbConn) return { provider: null, crudReady: false };
  return { provider: dbConn.provider, crudReady: dbConn.provider === "supabase" };
}

function restHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

// Introspect tables via the target project's PostgREST OpenAPI spec.
async function listTables(t: TargetCreds) {
  const res = await fetch(`${t.url}/rest/v1/`, { headers: restHeaders(t.serviceKey) });
  if (!res.ok) throw new Error(`PostgREST root ${res.status}`);
  const spec = await res.json();
  const defs = spec.definitions ?? {};
  const tables = Object.entries(defs).map(([name, def]: [string, any]) => {
    const props = def.properties ?? {};
    const columns = Object.entries(props).map(([cName, c]: [string, any]) => ({
      name: cName,
      type: c.format ?? c.type ?? "text",
      nullable: !(def.required ?? []).includes(cName),
      description: c.description ?? null,
      is_pk: typeof c.description === "string" && c.description.includes("<pk"),
    }));
    return { name, columns };
  });
  return tables;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id, op } = body;
    if (!workspace_id || !project_id || !op) {
      return jsonResponse({ error: "workspace_id, project_id, op required" }, { status: 400 });
    }

    // Membership + admin check
    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m || !["owner", "admin"].includes(m.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const target = await getTarget(workspace_id, project_id);
    if (op === "detect") {
      const det = await detectDbProvider(admin, project_id);
      return jsonResponse({
        configured: !!target,
        provider: det.provider,
        crud_ready: det.crudReady && !!target,
        project_url: target?.url ?? null,
      });
    }
    if (!target) {
      return jsonResponse(
        { error: "Database CRUD not configured. Connect Supabase with project_url + service_role_key in the catalog." },
        { status: 400 },
      );
    }

    switch (op) {
      case "query": {
        // Visual query builder -> PostgREST. Supports filters, multi-sort,
        // pagination (offset), and aggregations (group by + count/sum/avg/min/max).
        const table = String(body.table);
        const columns: string[] = Array.isArray(body.columns) ? body.columns : [];
        const filters: Array<{ column: string; op: string; value: string }> = body.filters ?? [];
        const sorts: Array<{ column: string; dir: "asc" | "desc" }> = body.sorts ?? [];
        const groupBy: string[] = Array.isArray(body.group_by) ? body.group_by : [];
        const aggregates: Array<{ fn: string; column: string }> = body.aggregates ?? [];
        const limit = Math.min(Number(body.limit ?? 50), 500);
        const offset = Math.max(Number(body.offset ?? 0), 0);

        const params = new URLSearchParams();

        // SELECT: aggregation mode vs plain mode
        let selectParts: string[];
        if (aggregates.length > 0) {
          // group columns + aggregate expressions (PostgREST aggregate syntax)
          selectParts = [...groupBy];
          for (const a of aggregates) {
            if (a.fn === "count") selectParts.push(`${a.column || "id"}.count()`);
            else selectParts.push(`${a.column}.${a.fn}()`);
          }
        } else {
          selectParts = columns.length ? columns : ["*"];
        }
        params.set("select", selectParts.join(","));
        params.set("limit", String(limit));
        if (offset > 0) params.set("offset", String(offset));

        const opMap: Record<string, string> = {
          "=": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte",
          contains: "ilike", starts_with: "ilike", is_null: "is",
        };
        for (const f of filters) {
          if (!f.column || !f.op) continue;
          const pgop = opMap[f.op] ?? "eq";
          let val = f.value;
          if (f.op === "contains") val = `*${f.value}*`;
          else if (f.op === "starts_with") val = `${f.value}*`;
          else if (f.op === "is_null") val = "null";
          params.append(f.column, `${pgop}.${val}`);
        }
        const order = sorts.filter((s) => s.column).map((s) => `${s.column}.${s.dir === "desc" ? "desc" : "asc"}`);
        if (order.length) params.set("order", order.join(","));

        const qs = params.toString();
        const res = await fetch(`${target.url}/rest/v1/${table}?${qs}`, {
          headers: restHeaders(target.serviceKey),
        });
        if (!res.ok) return jsonResponse({ error: `query failed: ${await res.text()}`, query: qs }, { status: 400 });
        return jsonResponse({ rows: await res.json(), query: `${table}?${decodeURIComponent(qs)}` });
      }
      case "list_tables": {
        const tables = await listTables(target);
        return jsonResponse({ tables });
      }
      case "list_rows": {
        const table = String(body.table);
        const limit = Math.min(Number(body.limit ?? 50), 200);
        const res = await fetch(`${target.url}/rest/v1/${table}?limit=${limit}`, {
          headers: restHeaders(target.serviceKey),
        });
        if (!res.ok) return jsonResponse({ error: `select failed: ${await res.text()}` }, { status: 400 });
        return jsonResponse({ rows: await res.json() });
      }
      case "insert_row": {
        const table = String(body.table);
        const values = body.values ?? {};
        const res = await fetch(`${target.url}/rest/v1/${table}`, {
          method: "POST",
          headers: { ...restHeaders(target.serviceKey), Prefer: "return=representation" },
          body: JSON.stringify(values),
        });
        if (!res.ok) return jsonResponse({ error: `insert failed: ${await res.text()}` }, { status: 400 });
        const rows = await res.json();
        await admin.from("activity_logs").insert({
          workspace_id,
          project_id,
          actor_user_id: userData.user.id,
          event_type: "db.row_inserted",
          title: `Row added to ${table}`,
          payload: { table },
        });
        return jsonResponse({ row: rows[0] ?? null });
      }
      case "delete_row": {
        const table = String(body.table);
        const pkCol = String(body.pk_col);
        const pkVal = String(body.pk_val);
        const res = await fetch(
          `${target.url}/rest/v1/${table}?${encodeURIComponent(pkCol)}=eq.${encodeURIComponent(pkVal)}`,
          { method: "DELETE", headers: restHeaders(target.serviceKey) },
        );
        if (!res.ok) return jsonResponse({ error: `delete failed: ${await res.text()}` }, { status: 400 });
        return jsonResponse({ ok: true });
      }
      case "list_users": {
        const res = await fetch(`${target.url}/auth/v1/admin/users?per_page=100`, {
          headers: restHeaders(target.serviceKey),
        });
        if (!res.ok) return jsonResponse({ error: `list users failed: ${await res.text()}` }, { status: 400 });
        const data = await res.json();
        return jsonResponse({ users: data.users ?? data ?? [] });
      }
      case "create_user": {
        const res = await fetch(`${target.url}/auth/v1/admin/users`, {
          method: "POST",
          headers: restHeaders(target.serviceKey),
          body: JSON.stringify({
            email: body.email,
            password: body.password,
            email_confirm: true,
          }),
        });
        if (!res.ok) return jsonResponse({ error: `create user failed: ${await res.text()}` }, { status: 400 });
        await admin.from("activity_logs").insert({
          workspace_id,
          project_id,
          actor_user_id: userData.user.id,
          event_type: "db.user_created",
          title: `Auth user created: ${body.email}`,
          payload: { email: body.email },
        });
        return jsonResponse({ user: await res.json() });
      }
      default:
        return jsonResponse({ error: `Unknown op ${op}` }, { status: 400 });
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
