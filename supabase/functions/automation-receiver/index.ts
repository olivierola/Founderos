// automation-receiver — public webhook receiver. Authenticated via FounderOS API key.
// Body: arbitrary JSON. Header: Authorization: Bearer fos_...
// Logs the event in product_events AND in activity_logs.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const m = auth.match(/^Bearer\s+(fos_[A-Za-z0-9]+)$/);
    if (!m) return jsonResponse({ error: "Missing or malformed FounderOS API key" }, { status: 401 });
    const apiKey = m[1]!;
    const hash = await sha256(apiKey);

    const admin = createServiceClient();
    const { data: keyRow } = await admin
      .from("founder_api_keys")
      .select("workspace_id, id")
      .eq("key_hash", hash)
      .maybeSingle();
    if (!keyRow) return jsonResponse({ error: "Invalid API key" }, { status: 401 });

    const payload = await req.json().catch(() => ({}));
    const event_name = String(payload.event ?? payload.event_name ?? "automation.received");
    const project_id = payload.project_id ?? null;

    await admin.from("product_events").insert({
      workspace_id: keyRow.workspace_id,
      project_id,
      event_name,
      properties: payload,
    });
    await admin.from("activity_logs").insert({
      workspace_id: keyRow.workspace_id,
      project_id,
      event_type: "automation.received",
      title: `Automation event: ${event_name}`,
      payload,
    });
    await admin.from("founder_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id);

    // Optional: trigger workflows whose trigger_event matches
    if (project_id) {
      const { data: matchingWorkflows } = await admin
        .from("workflows")
        .select("id")
        .eq("workspace_id", keyRow.workspace_id)
        .eq("trigger_event", event_name)
        .eq("enabled", true);
      const url = Deno.env.get("SUPABASE_URL")!;
      const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      for (const wf of matchingWorkflows ?? []) {
        fetch(`${url}/functions/v1/run-workflow`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/json" },
          body: JSON.stringify({ workflow_id: wf.id, trigger_payload: payload }),
        }).catch(() => {});
      }
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
