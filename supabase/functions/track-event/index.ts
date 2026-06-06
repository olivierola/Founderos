// track-event — ingests product event(s) for engagement analytics.
//
// Auth (two modes, in priority order):
//   1. API key: header `Authorization: Bearer fos_...`. The key resolves the
//      workspace; project_id must still be supplied (a workspace can hold many
//      projects). Used by the server SDKs (Node/Python/PHP/Go).
//   2. Anonymous: no key — caller passes workspace_id + project_id directly.
//      Used by the browser SDK (the anon Supabase key gates the function).
//
// Body — single event:
//   { workspace_id?, project_id, event_name, distinct_id?, user_email?,
//     customer_external_id?, properties?, occurred_at? }
// Body — batch (server SDKs):
//   { workspace_id?, project_id, batch: [ { event_name, ... }, ... ] }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { normalizePosthogHost } from "../_shared/providers.ts";

// Normalized product_events row shape (subset we forward).
interface EventRow {
  event_name: string;
  user_email: string | null;
  customer_external_id: string | null;
  properties: Record<string, unknown>;
  occurred_at: string;
}

// Forward freshly-ingested events to PostHog's capture API so the user's
// external analytics stays in sync. Skips events that were themselves imported
// from PostHog (avoids echo loops). Best-effort: any error is swallowed.
async function mirrorToPosthog(
  admin: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  projectId: string,
  rows: EventRow[],
): Promise<void> {
  // Cheap existence check before decrypting credentials.
  const { data: connector } = await admin
    .from("connectors")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .eq("provider", "posthog")
    .maybeSingle();
  if (!connector || connector.status !== "connected") return;

  const { payload } = await getConnectorCredential(workspaceId, projectId, "posthog");
  const captureKey = payload.project_api_key;
  if (!captureKey) return; // mirroring is opt-in via the project (capture) key
  const host = normalizePosthogHost(payload.host);

  const batch = rows
    .filter((r) => r.properties?.$ph_imported !== true) // don't echo imports back
    .map((r) => ({
      event: r.event_name,
      distinct_id: r.user_email ?? r.customer_external_id ?? "anonymous",
      timestamp: r.occurred_at,
      properties: { ...r.properties, $source: "founderos" },
    }));
  if (batch.length === 0) return;

  await fetch(`${host}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: captureKey, batch }),
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface IncomingEvent {
  event_name?: string;
  // distinct_id is the SDK-friendly alias; it maps to user_email when it looks
  // like an email, otherwise to customer_external_id.
  distinct_id?: string;
  user_email?: string;
  customer_external_id?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

function normalize(ev: IncomingEvent, projectId: string, workspaceId: string) {
  let email = ev.user_email ?? null;
  let external = ev.customer_external_id ?? null;
  if (ev.distinct_id && !email && !external) {
    if (ev.distinct_id.includes("@")) email = ev.distinct_id;
    else external = ev.distinct_id;
  }
  return {
    workspace_id: workspaceId,
    project_id: projectId,
    event_name: String(ev.event_name).slice(0, 120),
    customer_external_id: external,
    user_email: email,
    properties: ev.properties ?? {},
    occurred_at: ev.occurred_at ?? new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const admin = createServiceClient();

    // ── Resolve workspace ──
    let workspaceId: string | null = body.workspace_id ?? null;

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (bearer.startsWith("fos_")) {
      const keyHash = await sha256(bearer);
      const { data: key } = await admin
        .from("founder_api_keys")
        .select("id, workspace_id")
        .eq("key_hash", keyHash)
        .maybeSingle();
      if (!key) return jsonResponse({ error: "Invalid API key" }, { status: 401 });
      workspaceId = key.workspace_id;
      // Best-effort touch; ignore failures.
      admin.from("founder_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id).then(() => {});
    }

    const projectId = body.project_id;
    if (!workspaceId || !projectId) {
      return jsonResponse({ error: "project_id and an API key (or workspace_id) are required" }, { status: 400 });
    }

    // If a workspace_id was passed alongside an API key, they must match.
    if (bearer.startsWith("fos_") && body.workspace_id && body.workspace_id !== workspaceId) {
      return jsonResponse({ error: "workspace_id does not match API key" }, { status: 403 });
    }

    // Guard: the project must belong to the resolved workspace.
    const { data: proj } = await admin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!proj) return jsonResponse({ error: "project_id not in workspace" }, { status: 403 });

    // ── Build rows (single or batch) ──
    const incoming: IncomingEvent[] = Array.isArray(body.batch)
      ? body.batch
      : [body as IncomingEvent];

    const rows = incoming
      .filter((e) => e && typeof e.event_name === "string" && e.event_name.trim())
      .slice(0, 500) // hard cap per request
      .map((e) => normalize(e, projectId, workspaceId!));

    if (rows.length === 0) {
      return jsonResponse({ error: "no valid events (event_name required)" }, { status: 400 });
    }

    const { error } = await admin.from("product_events").insert(rows);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });

    // Best-effort mirror to PostHog when the project has a PostHog connector with
    // a capture (project) API key. Never blocks or fails ingestion.
    mirrorToPosthog(admin, workspaceId, projectId, rows).catch(() => {});

    return jsonResponse({ ok: true, ingested: rows.length });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
