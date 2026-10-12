// Client HTTP des serveurs MCP vers les outils (Loki, API OpenShift, Argo CD…).
//
// node:https plutôt que fetch : il faut l'AC interne de chaque outil (l'AC du
// cluster pour l'API Kubernetes, l'AC d'entreprise ailleurs) sans dépendance de
// plus, une limite de taille de réponse et un délai, pour qu'un outil lent ou
// bavard ne bloque ni ne sature le serveur.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class UpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Chemin d'un fichier PEM d'autorités de confiance. Défaut : celles du système. */
  caFile?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

const caCache = new Map<string, Buffer>();
function loadCa(file: string): Buffer {
  let ca = caCache.get(file);
  if (!ca) {
    ca = readFileSync(file);
    caCache.set(file, ca);
  }
  return ca;
}

export function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  if (!isHttps && u.protocol !== "http:") return Promise.reject(new UpstreamError(`protocole non pris en charge : ${u.protocol}`));
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(u, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Length": Buffer.byteLength(opts.body).toString() } : {}),
        ...opts.headers,
      },
      ...(isHttps && opts.caFile ? { ca: loadCa(opts.caFile) } : {}),
      signal: opts.signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new UpstreamError(`réponse de ${u.host} au-delà de ${maxBytes} octets`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new UpstreamError(`délai dépassé (${timeoutMs} ms) vers ${u.host}`)));
    req.on("error", (err) => reject(err instanceof UpstreamError ? err : new UpstreamError(`${u.host} injoignable : ${err.message}`)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Requête JSON : statut 2xx exigé, corps analysé. */
export async function requestJson<T = unknown>(url: string, opts: RequestOptions & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts;
  const res = await request(url, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(`${new URL(url).host} a répondu ${res.status} : ${res.text.slice(0, 300)}`, res.status);
  }
  if (!res.text) return undefined as T;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new UpstreamError(`${new URL(url).host} a renvoyé une réponse non JSON`);
  }
}
