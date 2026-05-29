// run-sql — runs a READ-ONLY SQL query against the FounderOS Postgres,
// using the service role but enforcing a whitelist on statement kind.
// Body: { workspace_id, sql }
//
// Safety:
//   - Only single statement
//   - Must start with SELECT (case-insensitive, after leading whitespace/comments)
//   - No semicolons in the middle, no DDL/DML keywords anywhere
//   - Hard timeout via 'statement_timeout = 5000ms'

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|begin|commit|rollback)\b/i;

function isSafeSelect(sql: string): { ok: boolean; reason?: string } {
  const trimmed = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").trim();
  if (!trimmed) return { ok: false, reason: "Empty query" };
  if (!/^select\b/i.test(trimmed)) return { ok: false, reason: "Only SELECT queries are allowed" };
  const noTrailing = trimmed.replace(/;\s*$/, "");
  if (noTrailing.includes(";")) return { ok: false, reason: "Multiple statements are not allowed" };
  if (FORBIDDEN.test(noTrailing)) return { ok: false, reason: "Forbidden keyword detected" };
  return { ok: true };
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

    const { workspace_id, sql } = await req.json();
    if (!workspace_id || !sql) return jsonResponse({ error: "workspace_id, sql required" }, { status: 400 });

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

    const safety = isSafeSelect(sql);
    if (!safety.ok) return jsonResponse({ error: safety.reason }, { status: 400 });

    // Use the Postgres REST API through PostgREST? Not flexible enough for arbitrary SELECTs.
    // We use the pg-meta endpoint via Supabase Management API instead. The MVP path:
    // run a SECURITY DEFINER function `public.fos_run_select` (created in migration).
    const { data, error } = await admin.rpc("fos_run_select", { query_text: sql });
    if (error) return jsonResponse({ error: error.message }, { status: 400 });

    return jsonResponse({ ok: true, rows: data });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
