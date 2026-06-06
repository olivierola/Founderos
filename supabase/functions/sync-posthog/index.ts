// sync-posthog — imports events from PostHog into product_events so PostHog can
// power FounderOS analytics (Events, Funnels, Retention, Growth).
//
// Body: { workspace_id, project_id, since?, limit? }
//   since  — ISO timestamp to import from (defaults to the connector's stored
//            high-water mark, or 30 days ago on first run).
//   limit  — max events to pull this run (default 5000, hard cap 50000).
//
// Auth: user session (owner/admin). Can also be invoked with the service role
// (e.g. from a scheduled job) — in that case membership is not checked.
//
// Idempotency: PostHog event UUIDs are stored in properties.$ph_event_uuid; we
// skip UUIDs already imported in the overlap window and advance the high-water
// mark in connector metadata (posthog_synced_until).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { normalizePosthogHost } from "../_shared/providers.ts";

interface PosthogEventRow {
  uuid: string;
  event: string;
  timestamp: string;
  distinct_id: string | null;
  email: string | null;
  properties: Record<string, unknown>;
}

// Run a HogQL query against PostHog and return rows as objects keyed by column.
async function hogql(
  host: string,
  projectId: string,
  personalKey: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${personalKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PostHog query failed (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
  const json = JSON.parse(text) as { results?: unknown[][]; columns?: string[] };
  const cols = json.columns ?? [];
  return (json.results ?? []).map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const { workspace_id, project_id } = body as { workspace_id?: string; project_id?: string };
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    // Auth: accept a user session (owner/admin) OR the service role key (jobs).
    const authHeader = req.headers.get("Authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isService = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    if (!isService) {
      if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const { data: membership } = await admin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspace_id)
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (!membership || !["owner", "admin"].includes(membership.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    // Credentials + connector (for the high-water mark in metadata).
    let payload: Record<string, string>;
    let connectorId: string;
    let metadata: Record<string, unknown>;
    try {
      const c = await getConnectorCredential(workspace_id, project_id, "posthog");
      payload = c.payload;
      connectorId = c.connector.id;
      metadata = c.connector.metadata ?? {};
    } catch (e) {
      return jsonResponse(
        { error: "PostHog not connected for this project", detail: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }

    const host = normalizePosthogHost(payload.host);
    const phProjectId = payload.project_id;
    const personalKey = payload.personal_api_key;
    if (!phProjectId || !personalKey) {
      return jsonResponse({ error: "PostHog connector missing project_id or personal_api_key" }, { status: 400 });
    }

    // Window: from the stored high-water mark (minus a 5-min overlap for late
    // events), or an explicit `since`, or 30 days back on first run.
    const defaultSince = new Date(Date.now() - 30 * 86400_000).toISOString();
    const storedUntil = typeof metadata.posthog_synced_until === "string" ? metadata.posthog_synced_until : null;
    const overlap = storedUntil ? new Date(new Date(storedUntil).getTime() - 5 * 60_000).toISOString() : null;
    const since = String(body.since ?? overlap ?? defaultSince);
    const limit = Math.min(Math.max(Number(body.limit ?? 5000), 1), 50000);

    // Pull events newer than `since`. HogQL exposes person.properties.email when set.
    const sinceSql = since.replace(/'/g, "");
    const query = `
      select uuid, event, timestamp, distinct_id,
             person.properties.email as email,
             properties
      from events
      where timestamp > toDateTime('${sinceSql}')
      order by timestamp asc
      limit ${limit}
    `;

    let rows: Record<string, unknown>[];
    try {
      rows = await hogql(host, phProjectId, personalKey, query);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }

    const events: PosthogEventRow[] = rows.map((r) => {
      let props: Record<string, unknown> = {};
      const rawProps = r.properties;
      if (typeof rawProps === "string") {
        try { props = JSON.parse(rawProps); } catch { props = {}; }
      } else if (rawProps && typeof rawProps === "object") {
        props = rawProps as Record<string, unknown>;
      }
      return {
        uuid: String(r.uuid ?? ""),
        event: String(r.event ?? ""),
        timestamp: String(r.timestamp ?? ""),
        distinct_id: r.distinct_id != null ? String(r.distinct_id) : null,
        email: r.email != null ? String(r.email) : null,
        properties: props,
      };
    }).filter((e) => e.uuid && e.event);

    if (events.length === 0) {
      return jsonResponse({ ok: true, imported: 0, skipped: 0, synced_until: storedUntil ?? since });
    }

    // Dedupe against events already imported in the overlap window.
    const incomingUuids = events.map((e) => e.uuid);
    const { data: existing } = await admin
      .from("product_events")
      .select("properties")
      .eq("project_id", project_id)
      .gte("occurred_at", since)
      .contains("properties", { $ph_imported: true })
      .limit(50000);
    const seen = new Set<string>(
      (existing ?? [])
        .map((r) => (r.properties as Record<string, unknown>)?.$ph_event_uuid)
        .filter((u): u is string => typeof u === "string"),
    );

    const toInsert = events
      .filter((e) => !seen.has(e.uuid))
      .map((e) => {
        const email = e.email ?? (e.distinct_id && e.distinct_id.includes("@") ? e.distinct_id : null);
        const external = !email && e.distinct_id ? e.distinct_id : null;
        return {
          workspace_id,
          project_id,
          event_name: e.event.slice(0, 120),
          customer_external_id: external,
          user_email: email,
          // Tag imported rows so future runs can dedupe and humans can trace source.
          properties: { ...e.properties, $ph_imported: true, $ph_event_uuid: e.uuid },
          occurred_at: e.timestamp,
        };
      });

    let imported = 0;
    // Insert in chunks to stay well under payload limits.
    for (let i = 0; i < toInsert.length; i += 500) {
      const chunk = toInsert.slice(i, i + 500);
      const { error } = await admin.from("product_events").insert(chunk);
      if (error) return jsonResponse({ error: error.message, imported }, { status: 500 });
      imported += chunk.length;
    }

    // Advance the high-water mark to the newest event we saw.
    const newestTs = events[events.length - 1].timestamp;
    await admin
      .from("connectors")
      .update({
        metadata: { ...metadata, posthog_synced_until: newestTs, posthog_last_sync_at: new Date().toISOString() },
      })
      .eq("id", connectorId);

    return jsonResponse({
      ok: true,
      imported,
      skipped: events.length - imported,
      synced_until: newestTs,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
