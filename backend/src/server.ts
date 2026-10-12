import { createServer as createHttpServer } from "node:http";
import { createApp, type AppOptions } from "./app.ts";
import type { EdgeRegistry } from "./compat/express.ts";
import { attachDeepgramStream } from "./ws/deepgram-stream.ts";

/** Serveur HTTP complet : l'app Express et le WebSocket de dictée. */
export function createServer(registry?: EdgeRegistry, options?: AppOptions) {
  const server = createHttpServer(createApp(registry, options));
  attachDeepgramStream(server);
  return server;
}
