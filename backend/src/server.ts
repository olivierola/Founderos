import { createServer as createHttpServer } from "node:http";
import { createApp, type AppOptions } from "./app.ts";
import type { EdgeRegistry } from "./compat/express.ts";
import { attachDeepgramStream } from "./ws/deepgram-stream.ts";
import { attachRealtime } from "./platform/realtime.ts";

/** Serveur HTTP complet : l'app Express, le WebSocket de dictée et, en mode
 *  PLATFORM=self, celui du realtime. */
export function createServer(registry?: EdgeRegistry, options?: AppOptions) {
  const server = createHttpServer(createApp(registry, options));
  attachDeepgramStream(server);
  if (options?.platform) {
    const rt = attachRealtime(server, options.platform);
    server.on("close", () => { void rt.close(); });
  }
  return server;
}
