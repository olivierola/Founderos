// track-event — ingests a product event for engagement analytics.
// Anonymous: only needs an API key OR a workspace_id (for browser SDK use).
// Body: { workspace_id, project_id, event_name, customer_external_id?, user_email?, properties? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    if (!body.workspace_id || !body.project_id || !body.event_name) {
      return jsonResponse({ error: "workspace_id, project_id, event_name required" }, { status: 400 });
    }
    const admin = createServiceClient();
    const { error } = await admin.from("product_events").insert({
      workspace_id: body.workspace_id,
      project_id: body.project_id,
      event_name: String(body.event_name).slice(0, 120),
      customer_external_id: body.customer_external_id ?? null,
      user_email: body.user_email ?? null,
      properties: body.properties ?? {},
      occurred_at: body.occurred_at ?? new Date().toISOString(),
    });
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
