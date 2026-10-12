// deepgram-transcribe — general speech-to-text for the app's chat composers
// (internal agents + Vibe Code). Any logged-in user can dictate; the audio is
// recorded client-side, sent here as base64, and transcribed via Deepgram.
// Body: { audio: base64, mime?: string, language?: string }
// Requires the DEEPGRAM_API_KEY secret; returns 501 stt_not_configured if unset.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createUserClient } from "../_shared/supabase-admin.ts";

const DG = "https://api.deepgram.com/v1";

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
    // Any authenticated user may dictate (gates the shared Deepgram key).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const { data: userData, error: userErr } = await createUserClient(authHeader).auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const key = Deno.env.get("DEEPGRAM_API_KEY");
    if (!key) return jsonResponse({ error: "stt_not_configured" }, { status: 501 });

    const body = await req.json().catch(() => ({}));
    const b64 = body.audio as string | undefined;
    if (!b64) return jsonResponse({ error: "audio (base64) required" }, { status: 400 });
    const mime = (body.mime as string | undefined) || "audio/webm";
    const language = (body.language as string | undefined) || "";

    const bytes = fromBase64(b64);
    if (bytes.length < 200) return jsonResponse({ ok: true, transcript: "" });
    if (bytes.length > 12_000_000) return jsonResponse({ error: "audio too large" }, { status: 413 });

    // nova-2 with smart formatting + punctuation; auto-detect FR/EN unless the
    // caller pins a language.
    const params = new URLSearchParams({ model: "nova-2", smart_format: "true", punctuate: "true" });
    if (language) params.set("language", language);
    else params.set("detect_language", "true");

    const res = await fetch(`${DG}/listen?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": mime },
      body: bytes,
    });
    if (!res.ok) {
      return jsonResponse({ error: "stt_failed", detail: (await res.text()).slice(0, 300) }, { status: 502 });
    }
    const json = await res.json();
    const transcript = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return jsonResponse({ ok: true, transcript });
  } catch (err) {
    return jsonResponse({ error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
