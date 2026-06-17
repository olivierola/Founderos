// Voice call center bridge — Twilio Media Streams ⇄ Deepgram STT/TTS ⇄ AI resolver.
//
// Twilio connects to this WebSocket server (URL given by the support-voice edge
// function's TwiML <Connect><Stream>). It streams 8kHz μ-law audio frames. We:
//   1. forward caller audio to Deepgram streaming STT (μ-law 8k),
//   2. on a final transcript, ask the AI resolver for a reply,
//   3. synthesize the reply with Deepgram TTS (Aura → μ-law 8k) and stream it
//      back to Twilio as outbound media frames,
//   4. persist the running transcript + outcome to support_voice_calls.
//
// Edge functions (Deno Deploy) can't hold these long-lived bidirectional audio
// sockets, so this lives in the self-hosted Node runner.

import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import {
  SUPABASE_URL, SERVICE_KEY, VOICE_WS_PORT, DEEPGRAM_API_KEY,
  VOICE_TTS_MODEL, VOICE_STT_MODEL, VOICE_STT_LANGUAGE, ts,
} from "./env.js";

const supa = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }) : null;

// ── AI resolver: one turn of the conversation, grounded in the project KB. ──
async function aiTurn({ projectId, workspaceId, history, ragCollectionId }) {
  // Reuse support-engine's portal_reply (KB-grounded, concise) for voice turns.
  const lastUser = [...history].reverse().find((h) => h.role === "caller")?.text ?? "";
  const res = await fetch(`${SUPABASE_URL}/functions/v1/support-engine`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({
      workspace_id: workspaceId, project_id: projectId, action: "portal_reply",
      query: lastUser, rag_collection_id: ragCollectionId ?? null,
    }),
  });
  const out = await res.json().catch(() => ({}));
  return { text: out.content ?? "Je n'ai pas bien compris, pouvez-vous reformuler ?", grounded: !!out.grounded };
}

// ── Deepgram TTS: text → μ-law 8k audio, returned as a Buffer. ──
async function synthesize(text) {
  const res = await fetch(
    `https://api.deepgram.com/v1/speak?model=${VOICE_TTS_MODEL}&encoding=mulaw&sample_rate=8000&container=none`,
    { method: "POST", headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }) },
  );
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Send a μ-law buffer back to Twilio as media frames on the given stream.
function sendAudioToTwilio(twilioWs, streamSid, mulawBuf) {
  // Twilio expects base64 μ-law payloads, ~20ms (160 bytes) per frame.
  const FRAME = 160;
  for (let i = 0; i < mulawBuf.length; i += FRAME) {
    const chunk = mulawBuf.subarray(i, i + FRAME);
    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunk.toString("base64") } }));
  }
}

// ── Deepgram streaming STT connection for one call. ──
function openDeepgramStt(onTranscript, language = VOICE_STT_LANGUAGE) {
  const url = `wss://api.deepgram.com/v1/listen?model=${VOICE_STT_MODEL}&language=${language}` +
    `&encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&interim_results=true&endpointing=300`;
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  dg.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (alt?.transcript && msg.is_final && msg.speech_final) onTranscript(alt.transcript);
    } catch { /* ignore */ }
  });
  dg.on("error", (e) => console.error(`[${ts()}] Deepgram STT error: ${e.message}`));
  return dg;
}

// ── One Twilio call session. ──
function handleCall(twilioWs, params) {
  let streamSid = null;
  let callRow = null;       // support_voice_calls row (id, project_id, workspace_id, …)
  let ragCollectionId = null;
  const history = [];        // {role:'caller'|'agent', text}
  let speaking = false;      // simple barge-in guard
  let dg = null;

  async function persist(patch) {
    if (!supa || !callRow) return;
    try { await supa.from("support_voice_calls").update(patch).eq("id", callRow.id); } catch { /* */ }
  }
  async function pushTurn(role, text) {
    history.push({ role, text, ts: new Date().toISOString() });
    await persist({ transcript: history, status: "ai_handling" });
  }

  // Create a support ticket from the call so a human can follow up in the inbox.
  async function escalateToTicket(reason) {
    if (!supa || !callRow || callRow.ticket_id) return;
    try {
      const body = history.map((h) => `${h.role === "agent" ? "AI" : "Caller"}: ${h.text}`).join("\n");
      const { data: t } = await supa.from("support_tickets").insert({
        workspace_id: callRow.workspace_id, project_id: callRow.project_id,
        subject: `Phone call — ${callRow.from_number || "unknown"}`,
        body: `${reason}\n\nTranscript:\n${body}`,
        channel: "voice", priority: "high", status: "open",
        requester_phone: callRow.from_number, last_activity_at: new Date().toISOString(),
      }).select("id").single();
      if (t?.id) { callRow.ticket_id = t.id; await persist({ ticket_id: t.id }); }
    } catch (e) { console.error(`[${ts()}] escalateToTicket error: ${e.message}`); }
  }

  async function respondTo(text) {
    await pushTurn("caller", text);
    // Hand off to a human if the caller asks for one.
    if (/agent|humain|conseiller|someone|person/i.test(text)) {
      await speak("Je vous mets en relation avec un conseiller. Un instant.");
      await persist({ status: "escalated", resolution: "escalated" });
      await escalateToTicket("Caller requested a human agent.");
      return;
    }
    try {
      const { text: reply } = await aiTurn({
        projectId: callRow?.project_id, workspaceId: callRow?.workspace_id, history, ragCollectionId,
      });
      await pushTurn("agent", reply);
      await speak(reply);
    } catch (e) {
      console.error(`[${ts()}] aiTurn error: ${e.message}`);
      await speak("Désolé, une erreur est survenue. Je vous transfère à un conseiller.");
      await persist({ status: "escalated", resolution: "escalated" });
      await escalateToTicket("AI error during the call.");
    }
  }

  async function speak(text) {
    if (!streamSid) return;
    speaking = true;
    try {
      const audio = await synthesize(text);
      sendAudioToTwilio(twilioWs, streamSid, audio);
    } catch (e) {
      console.error(`[${ts()}] TTS error: ${e.message}`);
    } finally { speaking = false; }
  }

  twilioWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      const cp = msg.start?.customParameters ?? {};
      const callSid = cp.call_sid || params.call_sid;
      const language = cp.language || params.language || undefined;
      // Load the call row + portal RAG collection for this project.
      if (supa && callSid) {
        const { data } = await supa.from("support_voice_calls")
          .select("id, project_id, workspace_id, channel_id, ticket_id, from_number").eq("provider_call_sid", callSid).maybeSingle();
        callRow = data ?? null;
        if (callRow) {
          const { data: portal } = await supa.from("support_portals")
            .select("rag_collection_id").eq("project_id", callRow.project_id).maybeSingle();
          ragCollectionId = portal?.rag_collection_id ?? null;
        }
      }
      dg = openDeepgramStt((transcript) => { if (!speaking) respondTo(transcript); }, language);
      console.log(`[${ts()}] voice call started stream=${streamSid} call=${callSid} lang=${language ?? VOICE_STT_LANGUAGE}`);
    } else if (msg.event === "media") {
      // Inbound caller audio (base64 μ-law) → Deepgram.
      if (dg && dg.readyState === WebSocket.OPEN && msg.media?.payload) {
        dg.send(Buffer.from(msg.media.payload, "base64"));
      }
    } else if (msg.event === "stop") {
      await persist({ status: "completed", ended_at: new Date().toISOString() });
      if (dg) try { dg.close(); } catch { /* */ }
    }
  });

  twilioWs.on("close", () => { if (dg) try { dg.close(); } catch { /* */ } });
  twilioWs.on("error", (e) => console.error(`[${ts()}] Twilio WS error: ${e.message}`));
}

// ── Start the voice WS server (no-op unless configured). ──
export function startVoiceServer() {
  if (!VOICE_WS_PORT || !DEEPGRAM_API_KEY || !supa) {
    if (VOICE_WS_PORT && !DEEPGRAM_API_KEY) console.warn(`[${ts()}] voice: VOICE_WS_PORT set but DEEPGRAM_API_KEY missing — voice disabled`);
    return;
  }
  const wss = new WebSocketServer({ port: VOICE_WS_PORT });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const params = Object.fromEntries(url.searchParams.entries());
    handleCall(ws, params);
  });
  console.log(`  voice WS: listening on :${VOICE_WS_PORT} (Deepgram ${VOICE_STT_MODEL}/${VOICE_TTS_MODEL})`);
}
