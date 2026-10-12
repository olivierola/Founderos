// deepgram-stream — realtime speech-to-text proxy, réécrit pour Node (le
// Deno.upgradeWebSocket de la version edge n'a pas d'équivalent dans
// l'adaptateur Request → Response). The browser opens a WebSocket here (it can't
// hold the Deepgram key), we open a WebSocket to Deepgram with the key, and pipe
// audio chunks up / interim+final transcripts down. Used by the chat composers
// for live dictation.
//
// Connect: ws(s)://<backend>/functions/v1/deepgram-stream
//            ?token=<user_jwt>&sample_rate=48000&encoding=linear16&language=
// Client → server: binary audio frames (linear16 PCM). Server → client: Deepgram
// JSON results, plus {type:"ready"} once the upstream is open.

import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RequestHandler } from "express";
import WebSocket, { WebSocketServer } from "ws";
import { createUserClient } from "../shared/supabase.ts";

export const DEEPGRAM_STREAM_PATH = "/functions/v1/deepgram-stream";
const DG_WS = "wss://api.deepgram.com/v1/listen";

/** Requête HTTP ordinaire sur le point d'entrée : même réponse que la version edge. */
export const deepgramStreamHttp: RequestHandler = (_req, res) => {
  res.status(426).type("text/plain").send("Expected a WebSocket upgrade");
};

/** Branche le proxy sur le serveur HTTP. C'est le seul point d'entrée WebSocket du backend. */
export function attachDeepgramStream(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== DEEPGRAM_STREAM_PATH) {
      socket.destroy();
      return;
    }
    accept(wss, req, socket, head, url).catch((err) => {
      console.error("[deepgram-stream] ouverture impossible :", err);
      refuse(socket, 500, "internal_error");
    });
  });
}

function refuse(socket: Duplex, status: number, message: string) {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "Connection: close\r\n\r\n" +
      message,
  );
}

async function accept(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
  const token = url.searchParams.get("token") ?? "";
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return refuse(socket, 501, "stt_not_configured");

  // Authenticate the user (the JWT rides in the query string — WebSocket clients
  // can't set headers).
  try {
    const { data, error } = await createUserClient(`Bearer ${token}`).auth.getUser();
    if (error || !data.user) return refuse(socket, 401, "Invalid session");
  } catch {
    return refuse(socket, 401, "Invalid session");
  }

  // nova-3 + language=multi does live code-switching across FR/EN/ES/DE/… —
  // Deepgram's *streaming* API rejects detect_language (that's batch-only), so
  // "multi" is our default when the client doesn't pin a language.
  const params = new URLSearchParams({
    model: url.searchParams.get("model") || "nova-3",
    smart_format: "true",
    punctuate: "true",
    interim_results: "true",
    endpointing: "300",
    encoding: url.searchParams.get("encoding") || "linear16",
    sample_rate: url.searchParams.get("sample_rate") || "48000",
    channels: "1",
    language: url.searchParams.get("language") || "multi",
  });

  wss.handleUpgrade(req, socket, head, (client) => bridge(client, `${DG_WS}?${params}`, key));
}

/** Les sockets peuvent se fermer entre deux tests d'état : un envoi tardif est sans conséquence. */
function quietly(fn: () => void) {
  try {
    fn();
  } catch {
    /* noop */
  }
}

function bridge(client: WebSocket, upstreamUrl: string, key: string) {
  // Deepgram authenticates the WS via the "token" subprotocol.
  const dg = new WebSocket(upstreamUrl, ["token", key]);
  const pending: WebSocket.RawData[] = [];
  let keepAlive: NodeJS.Timeout | undefined;

  dg.on("open", () => {
    for (const frame of pending) dg.send(frame, { binary: true });
    pending.length = 0;
    keepAlive = setInterval(() => {
      if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
    quietly(() => client.send(JSON.stringify({ type: "ready" })));
  });
  dg.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  dg.on("close", () => {
    clearInterval(keepAlive);
    quietly(() => client.close());
  });
  dg.on("error", () => {
    quietly(() => client.send(JSON.stringify({ type: "error", message: "deepgram_error" })));
  });

  client.on("message", (data, isBinary) => {
    // Text control messages (e.g. finalize/close) or binary audio frames.
    if (!isBinary) {
      if (data.toString() === "CloseStream" && dg.readyState === WebSocket.OPEN) {
        dg.send(JSON.stringify({ type: "CloseStream" }));
      }
      return;
    }
    if (dg.readyState === WebSocket.OPEN) dg.send(data, { binary: true });
    else if (dg.readyState === WebSocket.CONNECTING) pending.push(data);
  });
  client.on("close", () => {
    clearInterval(keepAlive);
    quietly(() => {
      if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
    });
    quietly(() => dg.close());
  });
  client.on("error", () => quietly(() => dg.close()));
}
