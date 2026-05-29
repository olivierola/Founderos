// dispatch-webhook — fires an outgoing webhook + records the delivery.
// Can be invoked by other Edge Functions or by the dashboard for testing.
// Body: { webhook_id, event_type, payload }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

async function hmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const { webhook_id, event_type, payload } = await req.json();
    if (!webhook_id || !event_type) {
      return jsonResponse({ error: "webhook_id, event_type required" }, { status: 400 });
    }
    const admin = createServiceClient();
    const { data: wh } = await admin.from("outgoing_webhooks").select("*").eq("id", webhook_id).maybeSingle();
    if (!wh || !wh.enabled) return jsonResponse({ error: "Webhook not found or disabled" }, { status: 404 });

    const body = JSON.stringify({ event: event_type, payload });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (wh.secret) {
      headers["X-FounderOS-Signature"] = await hmacSha256(wh.secret, body);
    }

    let status: number | null = null;
    let response_body = "";
    try {
      const res = await fetch(wh.url, { method: "POST", headers, body });
      status = res.status;
      response_body = (await res.text()).slice(0, 2000);
    } catch (err) {
      response_body = err instanceof Error ? err.message : String(err);
    }

    const ok = status !== null && status >= 200 && status < 300;
    await admin.from("webhook_deliveries").insert({
      webhook_id: wh.id,
      workspace_id: wh.workspace_id,
      event_type,
      payload: payload ?? {},
      status_code: status,
      response_body,
      delivered_at: ok ? new Date().toISOString() : null,
    });

    return jsonResponse({ ok, status, response_body });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
