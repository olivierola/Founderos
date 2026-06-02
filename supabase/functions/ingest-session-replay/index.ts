// ingest-session-replay — receives a batch of rrweb events from the browser SDK
// and persists them. Anonymous (like track-event): only needs workspace_id +
// project_id, so it can run from an unauthenticated visitor's browser.
//
// Body: {
//   workspace_id, project_id,
//   client_session_id,            // stable id for the recording (one per tab/visit)
//   chunk,                        // monotonically increasing batch index
//   events,                       // rrweb eventWithTime[]
//   meta?: {                      // sent on the first batch, best-effort
//     customer_external_id?, user_email?, device?, browser?, os?,
//     country?, entry_url?, user_agent?
//   },
//   signals?: { rage_clicks?: number, errors?: number, pages?: number }
// }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

// rrweb event types we care about for timing. type 4 = Meta (new page).
const RRWEB_INCREMENTAL = 3;

interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const { workspace_id, project_id, client_session_id, chunk, events, meta, signals } = body ?? {};

    if (!workspace_id || !project_id || !client_session_id || !Array.isArray(events)) {
      return jsonResponse(
        { error: "workspace_id, project_id, client_session_id, events[] required" },
        { status: 400 },
      );
    }

    const admin = createServiceClient();

    // Timestamps from this batch (rrweb events are ms epoch).
    const timestamps = (events as RrwebEvent[])
      .map((e) => Number(e?.timestamp))
      .filter((t) => Number.isFinite(t));
    const batchFirst = timestamps.length ? Math.min(...timestamps) : Date.now();
    const batchLast = timestamps.length ? Math.max(...timestamps) : Date.now();

    // Upsert the session row first so we have its id for the events.
    // On the first batch (chunk 0) we set the immutable metadata; later batches
    // only bump the aggregates.
    const isFirstBatch = Number(chunk) === 0;
    const m = meta ?? {};

    // Find existing session (unique on project_id + client_session_id).
    const { data: existing } = await admin
      .from("session_replay_sessions")
      .select("id, started_at, event_count, page_count, rage_click_count, error_count")
      .eq("project_id", project_id)
      .eq("client_session_id", client_session_id)
      .maybeSingle();

    let sessionId: string;

    if (!existing) {
      const { data: inserted, error: insErr } = await admin
        .from("session_replay_sessions")
        .insert({
          workspace_id,
          project_id,
          client_session_id: String(client_session_id).slice(0, 200),
          customer_external_id: m.customer_external_id ?? null,
          user_email: m.user_email ?? null,
          device: m.device ?? null,
          browser: m.browser ?? null,
          os: m.os ?? null,
          country: m.country ?? null,
          entry_url: m.entry_url ?? null,
          user_agent: m.user_agent ? String(m.user_agent).slice(0, 500) : null,
          started_at: new Date(batchFirst).toISOString(),
          last_activity_at: new Date(batchLast).toISOString(),
          duration_ms: Math.max(0, batchLast - batchFirst),
          event_count: events.length,
          page_count: signals?.pages ?? 1,
          rage_click_count: signals?.rage_clicks ?? 0,
          error_count: signals?.errors ?? 0,
        })
        .select("id")
        .single();
      if (insErr) return jsonResponse({ error: insErr.message }, { status: 500 });
      sessionId = inserted!.id;
    } else {
      sessionId = existing.id;
      const startedMs = new Date(existing.started_at).getTime();
      const patch: Record<string, unknown> = {
        last_activity_at: new Date(batchLast).toISOString(),
        duration_ms: Math.max(0, batchLast - startedMs),
        event_count: (existing.event_count ?? 0) + events.length,
        rage_click_count: (existing.rage_click_count ?? 0) + (signals?.rage_clicks ?? 0),
        error_count: (existing.error_count ?? 0) + (signals?.errors ?? 0),
      };
      if (signals?.pages) patch.page_count = Math.max(existing.page_count ?? 1, signals.pages);
      // Backfill metadata if the first batch arrived out of order.
      if (isFirstBatch) {
        if (m.user_email) patch.user_email = m.user_email;
        if (m.customer_external_id) patch.customer_external_id = m.customer_external_id;
        if (m.entry_url) patch.entry_url = m.entry_url;
      }
      const { error: updErr } = await admin
        .from("session_replay_sessions")
        .update(patch)
        .eq("id", sessionId);
      if (updErr) return jsonResponse({ error: updErr.message }, { status: 500 });
    }

    // Insert the event chunk. Upsert on (session_id, chunk) makes retries idempotent.
    const { error: evErr } = await admin
      .from("session_replay_events")
      .upsert(
        {
          session_id: sessionId,
          project_id,
          chunk: Number(chunk) || 0,
          events,
        },
        { onConflict: "session_id,chunk" },
      );
    if (evErr) return jsonResponse({ error: evErr.message }, { status: 500 });

    // Touch: how many incremental events did this batch carry (debug aid).
    const incremental = (events as RrwebEvent[]).filter((e) => e?.type === RRWEB_INCREMENTAL).length;

    return jsonResponse({ ok: true, session_id: sessionId, stored: events.length, incremental });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
