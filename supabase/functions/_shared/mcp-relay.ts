// Un serveur MCP derrière le pare-feu du client, joint par son relais
// (docs/enterprise-generalisation.md G2).
//
// Le client MCP (mcp-client.ts) envoie ses requêtes JSON-RPC par ce transport :
// chacune devient une tâche du relais (connector_relay_jobs), que le relais
// exécute contre le serveur s'il figure dans SA liste blanche
// (RELAY_ALLOWED_HOSTS), puis rend la réponse. Aucun port entrant chez le
// client.
//
// Les en-têtes qui portent une identité (jeton d'appel, contexte signé, jeton
// d'approbation) ne sont JAMAIS mis en file en clair : ils deviennent des
// secrets de la tâche, chiffrés, et la requête n'en garde que les marqueurs
// {{secret:…}}, remplis au moment où le relais la réclame.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { relayJob, type JobRequest, type TransportResult } from "./custom-connectors.ts";
import type { FetchLike } from "./mcp-client.ts";

/** Les seuls en-têtes qui restent en clair dans la file : aucun ne porte d'identité. */
const PLAIN_HEADERS = new Set(["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "traceparent", "x-session-id"]);

/** Sépare une requête en ce qui peut être mis en file et ce qui doit être chiffré. Pure. */
export function sealHeaders(headers: Record<string, string>): { headers: Record<string, string>; secrets: Record<string, string> } {
  const out: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (PLAIN_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
      continue;
    }
    const name = `__h_${k.toLowerCase().replace(/[^a-z0-9]/g, "_")}`.slice(0, 60);
    secrets[name] = v;
    out[k] = `{{secret:${name}}}`;
  }
  return { headers: out, secrets };
}

function headersOf(init?: RequestInit): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/** Réponse HTTP reconstituée à partir du rendu du relais. */
export function responseFromRelay(res: TransportResult): Response {
  return new Response(res.body, {
    status: res.status >= 200 && res.status <= 599 ? res.status : 502,
    headers: res.headers ?? {},
  });
}

export interface RelayTarget {
  relayId: string;
  workspaceId: string;
  mcpServerId?: string | null;
}

/**
 * Transport du client MCP par le relais. `submit` est remplaçable pour les
 * tests ; sinon, la file connector_relay_jobs (relayJob).
 */
export function relayFetchFor(
  admin: SupabaseClient | null,
  target: RelayTarget,
  submit?: (req: JobRequest, jobSecrets: Record<string, string>) => Promise<TransportResult>,
): FetchLike {
  const send = submit ?? (async (req: JobRequest, jobSecrets: Record<string, string>) =>
    await relayJob(admin!, { relayId: target.relayId, workspaceId: target.workspaceId, mcpServerId: target.mcpServerId ?? null, jobSecrets }, req));
  return async (url, init) => {
    const { headers, secrets } = sealHeaders(headersOf(init));
    const req: JobRequest = {
      type: "http",
      method: init?.method ?? "POST",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : null,
      timeout_ms: 30_000,
      max_bytes: 512 * 1024,
      apply_auth: false,
      placeholder_encoding: "raw",
    };
    return responseFromRelay(await send(req, secrets));
  };
}
