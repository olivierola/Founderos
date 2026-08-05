// deepgram-stream — realtime speech-to-text proxy. The browser opens a WebSocket
// here (it can't hold the Deepgram key), we open a WebSocket to Deepgram with the
// key, and pipe audio chunks up / interim+final transcripts down. Used by the
// chat composers for live dictation.
//
// Connect: wss://<proj>.functions.supabase.co/deepgram-stream
//            ?apikey=<anon>&token=<user_jwt>&sample_rate=48000&encoding=linear16&language=
// Client → server: binary audio frames (linear16 PCM). Server → client: Deepgram
// JSON results, plus {type:"ready"} once the upstream is open.

import { createUserClient } from "../_shared/supabase-admin.ts";

const DG_WS = "wss://api.deepgram.com/v1/listen";

Deno.serve(async (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const key = Deno.env.get("DEEPGRAM_API_KEY");
  if (!key) return new Response("stt_not_configured", { status: 501 });

  // Authenticate the user (the JWT rides in the query string — WebSocket clients
  // can't set headers).
  try {
    const { data, error } = await createUserClient(`Bearer ${token}`).auth.getUser();
    if (error || !data.user) return new Response("Invalid session", { status: 401 });
  } catch {
    return new Response("Invalid session", { status: 401 });
  }

  const sampleRate = url.searchParams.get("sample_rate") || "48000";
  const encoding = url.searchParams.get("encoding") || "linear16";
  const language = url.searchParams.get("language") || "";
  // nova-3 + language=multi does live code-switching across FR/EN/ES/DE/… —
  // Deepgram's *streaming* API rejects detect_language (that's batch-only), so
  // "multi" is our default when the client doesn't pin a language.
  const model = url.searchParams.get("model") || "nova-3";

  const params = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    interim_results: "true",
    endpointing: "300",
    encoding,
    sample_rate: sampleRate,
    channels: "1",
    language: language || "multi",
  });

  const { socket: client, response } = Deno.upgradeWebSocket(req);

  // Deepgram authenticates the WS via the "token" subprotocol.
  const dg = new WebSocket(`${DG_WS}?${params.toString()}`, ["token", key]);
  const pending: (string | ArrayBufferLike)[] = [];
  let keepAlive: number | undefined;

  dg.onopen = () => {
    for (const m of pending) dg.send(m as ArrayBuffer);
    pending.length = 0;
    keepAlive = setInterval(() => { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "KeepAlive" })); }, 8000);
    try { client.send(JSON.stringify({ type: "ready" })); } catch { /* noop */ }
  };
  dg.onmessage = (e) => { if (client.readyState === WebSocket.OPEN) client.send(e.data); };
  dg.onclose = () => { if (keepAlive) clearInterval(keepAlive); try { client.close(); } catch { /* noop */ } };
  dg.onerror = () => { try { client.send(JSON.stringify({ type: "error", message: "deepgram_error" })); } catch { /* noop */ } };

  client.onmessage = (e) => {
    // Text control messages (e.g. finalize/close) or binary audio frames.
    if (typeof e.data === "string") {
      if (e.data === "CloseStream" && dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
      return;
    }
    if (dg.readyState === WebSocket.OPEN) dg.send(e.data);
    else pending.push(e.data);
  };
  client.onclose = () => {
    if (keepAlive) clearInterval(keepAlive);
    try { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" })); } catch { /* noop */ }
    try { dg.close(); } catch { /* noop */ }
  };
  client.onerror = () => { try { dg.close(); } catch { /* noop */ } };

  return response;
});
