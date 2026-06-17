// support-voice — Twilio voice webhooks for the Support call center.
// The heavy real-time audio bridge (Twilio Media Streams ⇄ Deepgram STT/TTS ⇄
// AI resolver) runs in the self-hosted Node runner, which can hold a long-lived
// WebSocket; this edge function only handles the short HTTP webhooks Twilio
// calls and returns TwiML.
//
// Action-dispatch via the `action` query param (Twilio posts form-encoded):
//   ?action=incoming      → answer + <Connect><Stream> to the runner WS, create call row
//   ?action=status        → call status callback (completed/failed/no-answer)
//   ?action=recording      → recording-ready callback (store recording_url)
//
// Twilio validates by signature in production; here we gate by a per-project
// voice token embedded in the webhook URL (?t=...), matched to a support_channels
// row of kind 'voice'.

import { createServiceClient } from "../_shared/supabase-admin.ts";
import { handleCors, jsonResponse } from "../_shared/cors.ts";

// Twilio <Say> locale per channel language.
const LOCALE: Record<string, string> = {
  fr: "fr-FR", en: "en-US", es: "es-ES", de: "de-DE", it: "it-IT", pt: "pt-PT", nl: "nl-NL",
};
// Escape for safe embedding in TwiML/XML attributes & text.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "Content-Type": "text/xml" },
  });
}
function say(msg: string): Response {
  return xml(`<Response><Say voice="alice" language="fr-FR">${msg}</Say></Response>`);
}

async function formParams(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    const o: Record<string, string> = {};
    for (const [k, v] of fd.entries()) o[k] = String(v);
    return o;
  }
  try { return await req.json(); } catch { return {}; }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "incoming";
  const token = url.searchParams.get("t") ?? "";
  const admin = createServiceClient();

  // ── Public help-center portal (unauthenticated) ────────────────────────────
  // portal_config: fetch portal + published articles by public_key.
  // portal_ask: AI answer from the knowledge base (grounded), no ticket needed.
  if (action === "portal_config" || action === "portal_ask") {
    try {
      const body = await req.json().catch(() => ({}));
      const key = body.public_key ?? url.searchParams.get("key") ?? "";
      const { data: portal } = await admin
        .from("support_portals")
        .select("id, workspace_id, project_id, title, brand_color, welcome, ai_enabled, rag_collection_id, enabled")
        .eq("public_key", key).maybeSingle();
      if (!portal || !portal.enabled) return jsonResponse({ error: "Portal not found" }, { status: 404 });

      if (action === "portal_config") {
        const { data: articles } = await admin
          .from("support_articles")
          .select("id, title, body, category, helpful_yes, helpful_no")
          .eq("project_id", portal.project_id).eq("status", "published")
          .order("helpful_yes", { ascending: false }).limit(50);
        return jsonResponse({
          ok: true,
          portal: { title: portal.title, brand_color: portal.brand_color, welcome: portal.welcome, ai_enabled: portal.ai_enabled },
          articles: articles ?? [],
        });
      }

      // portal_ask — delegate to support-engine's portal_reply via service role.
      if (!portal.ai_enabled) return jsonResponse({ error: "AI disabled" }, { status: 400 });
      const q = String(body.query ?? "");
      if (!q) return jsonResponse({ error: "query required" }, { status: 400 });
      const supaUrl = Deno.env.get("SUPABASE_URL");
      const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const r = await fetch(`${supaUrl}/functions/v1/support-engine`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc}` },
        body: JSON.stringify({
          workspace_id: portal.workspace_id, project_id: portal.project_id,
          action: "portal_reply", query: q, rag_collection_id: portal.rag_collection_id,
        }),
      });
      const out = await r.json();
      return jsonResponse(out, { status: r.ok ? 200 : 502 });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  try {
    // Resolve the voice channel by its public token.
    const { data: channel } = await admin
      .from("support_channels")
      .select("id, workspace_id, project_id, config, enabled")
      .eq("kind", "voice")
      .filter("config->>token", "eq", token)
      .maybeSingle();

    if (!channel || !channel.enabled) {
      return say("Ce service n'est pas disponible pour le moment. Au revoir.");
    }

    const p = await formParams(req);

    if (action === "incoming") {
      const callSid = p.CallSid ?? null;
      const from = p.From ?? null;
      const to = p.To ?? null;
      const cfg = (channel.config ?? {}) as { runner_ws?: string; greeting?: string; language?: string; record?: boolean };

      // Create the call record (the runner will attach transcript/resolution).
      await admin.from("support_voice_calls").insert({
        workspace_id: channel.workspace_id, project_id: channel.project_id, channel_id: channel.id,
        direction: "inbound", from_number: from, to_number: to,
        provider_call_sid: callSid, status: "in_progress",
      });

      const lang = cfg.language ?? "fr";
      const sayLocale = LOCALE[lang] ?? "fr-FR";
      const greeting = esc(cfg.greeting ?? "Bonjour, vous êtes en relation avec l'assistant. Comment puis-je vous aider ?");
      const wsBase = cfg.runner_ws;
      const recordAttr = cfg.record ? ` record="record-from-answer-dual"` : "";

      if (!wsBase) {
        // No runner configured — greet, take a voicemail-style message and stop.
        return xml(`<Response><Say voice="alice" language="${sayLocale}">${greeting}</Say><Pause length="1"/><Say voice="alice" language="${sayLocale}">Notre équipe vous recontactera. Au revoir.</Say></Response>`);
      }

      // Bridge to the runner over a Media Stream. Pass identifiers via <Parameter>
      // (reliable) so the runner can load context and write to the right call row.
      return xml(
        `<Response>` +
          `<Say voice="alice" language="${sayLocale}">${greeting}</Say>` +
          `<Connect${recordAttr}><Stream url="${esc(wsBase)}">` +
            `<Parameter name="call_sid" value="${esc(callSid ?? "")}"/>` +
            `<Parameter name="project_id" value="${channel.project_id}"/>` +
            `<Parameter name="channel_id" value="${channel.id}"/>` +
            `<Parameter name="language" value="${esc(lang)}"/>` +
          `</Stream></Connect>` +
        `</Response>`,
      );
    }

    if (action === "status") {
      const callSid = p.CallSid ?? null;
      const status = p.CallStatus ?? "";
      const duration = p.CallDuration ? Number(p.CallDuration) : null;
      const map: Record<string, string> = {
        completed: "completed", busy: "no_answer", "no-answer": "no_answer",
        failed: "failed", canceled: "failed",
      };
      if (callSid) {
        await admin.from("support_voice_calls").update({
          status: map[status] ?? "completed", duration_sec: duration, ended_at: new Date().toISOString(),
        }).eq("provider_call_sid", callSid);
      }
      return new Response("ok");
    }

    if (action === "recording") {
      const callSid = p.CallSid ?? null;
      const recordingUrl = p.RecordingUrl ?? null;
      if (callSid && recordingUrl) {
        await admin.from("support_voice_calls").update({ recording_url: recordingUrl }).eq("provider_call_sid", callSid);
      }
      return new Response("ok");
    }

    return new Response("unknown action", { status: 400 });
  } catch (err) {
    console.error("support-voice error", err);
    return say("Une erreur est survenue. Au revoir.");
  }
});
