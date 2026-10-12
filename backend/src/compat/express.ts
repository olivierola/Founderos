// Monte les handlers générés (src/edge/) dans Express : la requête Express
// devient une Request web, la Response web est recopiée — statut, en-têtes et
// corps en flux, pour que les réponses SSE arrivent au fil de l'eau.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import express, { Router, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import type { EdgeHandler } from "./index.ts";

export type EdgeRegistry = Record<string, () => Promise<{ default: EdgeHandler }>>;

// En-têtes propres à la connexion entrante ; content-length et content-encoding
// sont recalculés à partir du corps reçu (express.raw le décompresse).
const NOT_FORWARDED = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "content-length",
  "content-encoding",
]);

export function edgeRouter(registry: EdgeRegistry): Router {
  const handlers = new Map<string, Promise<EdgeHandler>>();

  function load(name: string): Promise<EdgeHandler> | null {
    if (!Object.hasOwn(registry, name)) return null;
    let handler = handlers.get(name);
    if (!handler) {
      handler = registry[name]().then((mod) => mod.default);
      // Un module qui échoue au chargement sera retenté à la requête suivante.
      handler.catch(() => handlers.delete(name));
      handlers.set(name, handler);
    }
    return handler;
  }

  const router = Router();
  router.all("/:name{/*rest}", express.raw({ type: () => true, limit: "50mb" }), async (req, res, next) => {
    const pending = load(req.params.name);
    if (!pending) return next();
    const handler = await pending;

    // Comme req.signal sous Deno : annulé si le client part avant la fin.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const response = await handler(toWebRequest(req, controller.signal));
    await sendWebResponse(response, res);
  });
  return router;
}

function toWebRequest(req: ExpressRequest, signal: AbortSignal): Request {
  const url = new URL(req.originalUrl, `${req.protocol}://${req.get("host") ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || NOT_FORWARDED.has(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  // Les fonctions lisent l'IP dans la première entrée de x-forwarded-for
  // (_shared/rate-limit.ts). On y met celle qu'Express a résolue selon
  // TRUST_PROXY, à la place de ce que le client a pu écrire lui-même.
  headers.set("x-forwarded-for", (req.ip ?? "").replace(/^::ffff:/, ""));

  const hasBody = Buffer.isBuffer(req.body) && req.body.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? new Uint8Array(req.body) : undefined,
    signal,
  });
}

async function sendWebResponse(response: Response, res: ExpressResponse): Promise<void> {
  res.status(response.status);
  if (response.statusText) res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);

  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res);
  } catch (err) {
    // Client parti en cours de flux : normal pour un SSE qu'on ferme.
    if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error("[edge] réponse interrompue :", err);
    }
  }
}
