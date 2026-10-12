// onboarding-voice — optional Deepgram voice for the live onboarding widget.
// Public endpoint (keyed by agent_public_key, no user session). Gated on the
// agent's onboarding_voice_enabled flag; the widget passes the user's opt-in.
//
// Actions (JSON body { action, agent_public_key, ... }):
//   "speak"      { text, model? }              → Deepgram Aura TTS  → { audio(base64), mime }
//   "transcribe" { audio(base64), mime? }       → Deepgram STT      → { transcript }
//
// Requires the DEEPGRAM_API_KEY secret; returns 501 voice_not_configured if unset.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

const DG = "https://api.deepgram.com/v1";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const key = Deno.env.get("DEEPGRAM_API_KEY");
    if (!key) return jsonResponse({ error: "voice_not_configured" }, { status: 501 });

    const body = await req.json().catch(() => ({}));
    const { action, agent_public_key } = body as { action?: string; agent_public_key?: string };
    if (!action || !agent_public_key) {
      return jsonResponse({ error: "action and agent_public_key required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: agent } = await admin
      .from("rag_agents")
      .select("id, onboarding_enabled, onboarding_voice_enabled, onboarding_voice_model")
      .eq("public_key", agent_public_key)
      .maybeSingle();
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });
    if (!agent.onboarding_enabled || !agent.onboarding_voice_enabled) {
      return jsonResponse({ error: "Voice disabled for this agent" }, { status: 403 });
    }

    // ── speak (TTS) ───────────────────────────────────────────────────────────
    if (action === "speak") {
      const text = ((body.text as string | undefined) ?? "").toString().slice(0, 800).trim();
      if (!text) return jsonResponse({ error: "text required" }, { status: 400 });
      const model = (body.model as string | undefined) || agent.onboarding_voice_model || "aura-asteria-en";
      const res = await fetch(`${DG}/speak?model=${encodeURIComponent(model)}`, {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        return jsonResponse({ error: "tts_failed", detail: (await res.text()).slice(0, 300) }, { status: 502 });
      }
      const audio = new Uint8Array(await res.arrayBuffer());
      return jsonResponse({ ok: true, audio: toBase64(audio), mime: "audio/mpeg", model });
    }

    // ── transcribe (STT) ────────────────────────────────────────────────────────
    if (action === "transcribe") {
      const b64 = body.audio as string | undefined;
      if (!b64) return jsonResponse({ error: "audio (base64) required" }, { status: 400 });
      const mime = (body.mime as string | undefined) || "audio/webm";
      const bytes = fromBase64(b64);
      if (bytes.length > 8_000_000) return jsonResponse({ error: "audio too large" }, { status: 413 });
      const res = await fetch(`${DG}/listen?model=nova-2&smart_format=true&punctuate=true`, {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": mime },
        body: bytes,
      });
      if (!res.ok) {
        return jsonResponse({ error: "stt_failed", detail: (await res.text()).slice(0, 300) }, { status: 502 });
      }
      const json = await res.json();
      const transcript =
        json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      return jsonResponse({ ok: true, transcript });
    }

    return jsonResponse({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
