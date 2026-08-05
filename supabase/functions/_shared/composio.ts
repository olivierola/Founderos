// _shared/composio.ts — thin wrapper around the Composio SDK, the new
// default connector backend (replaces the in-house providers.ts/
// connector-actions.ts path for newly-connected toolkits; that path is left
// completely untouched for anything already connected the old way).
import { Composio } from "https://esm.sh/@composio/core@0.14.0";

export function getComposio(): Composio {
  const apiKey = Deno.env.get("COMPOSIO_API_KEY");
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not configured");
  return new Composio({ apiKey });
}

// Composio's connected-account statuses → our connectors.status vocabulary
// (connectors_status_check in 0138_composio_connectors.sql).
export function mapConnectionStatus(composioStatus: string | undefined | null): string {
  switch (composioStatus) {
    case "ACTIVE":
      return "connected";
    case "INITIALIZING":
    case "INITIATED":
      return "pending";
    case "EXPIRED":
    case "FAILED":
    case "REVOKED":
      return "invalid_credentials";
    case "INACTIVE":
    default:
      return "not_connected";
  }
}
