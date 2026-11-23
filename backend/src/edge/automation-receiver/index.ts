import { Deno, FUNCTIONS_URL, defineHandler } from "../../compat/index.ts";

// automation-receiver — public webhook receiver. Authenticated via Anduran API key.
// Body: arbitrary JSON. Header: Authorization: Bearer fos_...
// Logs the event in product_events AND in activity_logs.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { timingSafeEqual } from "../_shared/authz.ts";
import { routeWorkflowEvent, startWorkflowRun, normalizeGraph } from "../_shared/workflow-engine.ts";
import { handleSentinel, isSentinelRequest } from "../_shared/sentinel-gateway.ts";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Lance un workflow sur appel entrant.
 *
 * Toute réponse d'échec AVANT la vérification du jeton est la même 401 : un
 * identifiant inconnu et un jeton faux ne doivent pas se distinguer, sinon
 * l'URL sert à sonder quels workflows existent.
 */
async function handleWorkflowWebhook(req: Request, url: URL, workflowId: string): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Utilisez POST pour déclencher ce workflow." }, { status: 405 });
  }
  const given = req.headers.get("x-webhook-token") ?? url.searchParams.get("token") ?? "";
  const denied = () => jsonResponse({ error: "Workflow ou jeton invalide" }, { status: 401 });
  if (!given) return denied();

  const admin = createServiceClient();
  const { data: wf } = await admin.from("agent_workflows")
    .select("id, status, blocks").eq("id", workflowId).maybeSingle();
  if (!wf) return denied();
  const row = wf as { id: string; status: string; blocks: unknown };
  const trigger = normalizeGraph(row.blocks).nodes.find((n) => n.type === "trigger");
  const data = (trigger?.data ?? {}) as Record<string, unknown>;
  const secret = String(data.webhook_token ?? "");
  if (!secret || !timingSafeEqual(given, secret)) return denied();

  // Le jeton est bon : on peut dire pourquoi le run ne part pas.
  if (data.mode !== "webhook") {
    return jsonResponse({ error: "Ce workflow n'est plus réglé sur « Webhook »." }, { status: 409 });
  }
  if (row.status !== "active") {
    return jsonResponse({ error: "Ce workflow n'est pas actif : activez-le pour qu'il accepte les appels." }, { status: 409 });
  }

  // Le corps est transmis tel quel au run (`{{trigger.champ}}`). Un corps qui
  // n'est pas du JSON n'est pas perdu : il arrive sous `body`.
  const raw = await req.text();
  let payload: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { body: parsed };
    } catch {
      payload = { body: raw };
    }
  }
  for (const [k, v] of url.searchParams) {
    if (k !== "workflow" && k !== "token" && !(k in payload)) payload[k] = v;
  }

  const started = await startWorkflowRun(admin, {
    workflowId: row.id, trigger: "webhook", payload, triggeredBy: null,
  });
  if ("error" in started) return jsonResponse({ error: started.error }, { status: started.status });
  return jsonResponse({ ok: true, run_id: started.runId }, { status: 202 });
}

export default defineHandler(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const url0 = new URL(req.url);

    // ── SentinelFlow : alertes de sécurité entrantes + écran d'administration ─
    // Même raison que les événements Composio ci-dessous : le projet est au
    // plafond des 100 fonctions, et cette fonction est la porte d'entrée.
    if (isSentinelRequest(url0)) return await handleSentinel(req, url0);

    // ── Connected-tool events (Composio callback) ────────────────────────────
    // Folded in here rather than shipped as its own function: the project is
    // two slots from Supabase's 100-function ceiling, and this endpoint is
    // already the product's inbound event door.
    //
    // Authentication is a shared secret in the path/header, NOT a workspace API
    // key: the caller is Composio, which has no notion of our keys. The routing
    // then happens on the subscription registry, so an event can only ever
    // reach the workspace that subscribed to it.
    if (url0.pathname.endsWith("/events") || url0.searchParams.get("source") === "composio") {
      const secret = Deno.env.get("WORKFLOW_EVENT_SECRET");
      const given = req.headers.get("x-webhook-secret") ?? url0.searchParams.get("secret") ?? "";
      // Comparaison a temps constant (FOS-19).
      if (!secret || !timingSafeEqual(given, secret)) {
        return jsonResponse({ error: "Invalid webhook secret" }, { status: 401 });
      }
      const body = await req.json().catch(() => ({} as Record<string, unknown>));
      const data = (body.data ?? body.payload ?? body) as Record<string, unknown>;

      // Composio's envelope has moved across versions; accept the shapes we
      // have seen rather than pinning one and silently dropping events.
      const provider = String(
        body.appName ?? body.app_name ?? body.toolkit ?? data.appName ?? data.toolkit ?? "",
      ).toLowerCase();
      const slug = String(body.triggerName ?? body.trigger_name ?? body.type ?? data.triggerName ?? "");
      const externalTriggerId = String(body.triggerNanoId ?? body.trigger_id ?? body.id ?? "") || null;
      // The dedup key. Falling back to a hash of the payload is deliberate: a
      // provider that sends no event id must still not fire twice on a retry.
      const eventId = String(
        body.eventId ?? body.event_id ?? data.id ?? data.messageId ?? data.message_id ?? "",
      ) || (await sha256(JSON.stringify(data)));

      if (!provider || !slug) {
        return jsonResponse({ ok: true, ignored: "événement sans application ni type identifiables" });
      }
      const admin0 = createServiceClient();
      const res = await routeWorkflowEvent(admin0, {
        provider, eventSlug: slug, externalEventId: eventId,
        payload: data, externalTriggerId,
      });
      // Always 200: a non-2xx makes the provider retry an event we have already
      // recorded, and the dedup ledger would just reject it again forever.
      return jsonResponse({ ok: true, ...res });
    }

    // ── Webhook d'un workflow (déclencheur « Webhook ») ──────────────────────
    // `?workflow=<id>` + le jeton propre à ce workflow, généré dans son bloc
    // déclencheur. Pas de clé de workspace : l'appelant est un service tiers
    // (formulaire, CRM, script) à qui l'on donne une URL, rien de plus. Le jeton
    // ne vaut que pour CE workflow, et le régénérer suffit à le révoquer.
    const workflowParam = url0.searchParams.get("workflow");
    if (workflowParam) return await handleWorkflowWebhook(req, url0, workflowParam);

    const auth = req.headers.get("Authorization") ?? "";
    const m = auth.match(/^Bearer\s+(fos_[A-Za-z0-9]+)$/);
    if (!m) return jsonResponse({ error: "Missing or malformed Anduran API key" }, { status: 401 });
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
        fetch(`${FUNCTIONS_URL}/functions/v1/run-workflow`, {
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
