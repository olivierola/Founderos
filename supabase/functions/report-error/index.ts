// report-error — captures a client-side error, dedupes by fingerprint.
// Body: { workspace_id, project_id, message, stack?, url?, user_agent?, level? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

async function sha1(text: string) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const { workspace_id, project_id, message } = body;
    if (!workspace_id || !project_id || !message) {
      return jsonResponse({ error: "workspace_id, project_id, message required" }, { status: 400 });
    }
    const fingerprint = await sha1(`${message}|${(body.stack ?? "").split("\n")[0] ?? ""}`);
    const admin = createServiceClient();

    const { data: existing } = await admin
      .from("error_events")
      .select("id, occurrences")
      .eq("project_id", project_id)
      .eq("fingerprint", fingerprint)
      .maybeSingle();

    if (existing) {
      await admin
        .from("error_events")
        .update({ occurrences: (existing.occurrences ?? 0) + 1, last_seen_at: new Date().toISOString() })
        .eq("id", existing.id);
      return jsonResponse({ ok: true, deduped: true, id: existing.id });
    }

    const { data: inserted, error } = await admin
      .from("error_events")
      .insert({
        workspace_id,
        project_id,
        source: body.source ?? "browser",
        level: body.level ?? "error",
        message: String(message).slice(0, 1000),
        stack: body.stack ? String(body.stack).slice(0, 8000) : null,
        url: body.url ?? null,
        user_agent: body.user_agent ?? null,
        fingerprint,
      })
      .select("id")
      .single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ ok: true, id: inserted!.id });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
