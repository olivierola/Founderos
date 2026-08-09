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

// ── Connector scopes (migration 0177) ────────────────────────────────────────
// A connection belongs to a service dashboard (the team's account), to one
// person inside a dashboard (their own account, opt-in per call), or to the
// project (legacy workspace-wide fallback).
export type ConnectorScope = "project" | "dashboard" | "personal";

export interface ScopeRef {
  scope: ConnectorScope;
  serviceDashboardId: string | null;
  ownerUserId: string | null;
}

/** Normalise a request's scope inputs, rejecting impossible combinations. */
export function resolveScope(input: {
  scope?: string | null;
  service_dashboard_id?: string | null;
  user_id?: string | null;
}): ScopeRef | { error: string } {
  const scope = (input.scope ?? "project") as ConnectorScope;
  const dash = input.service_dashboard_id ?? null;
  if (scope === "project") return { scope, serviceDashboardId: null, ownerUserId: null };
  if (!dash) return { error: `scope "${scope}" requires service_dashboard_id` };
  if (scope === "dashboard") return { scope, serviceDashboardId: dash, ownerUserId: null };
  if (scope === "personal") {
    if (!input.user_id) return { error: 'scope "personal" requires the caller\'s user id' };
    return { scope, serviceDashboardId: dash, ownerUserId: input.user_id };
  }
  return { error: `unknown scope "${scope}"` };
}

/** Composio's tenant key. Distinct per scope so the same toolkit can hold
 *  several independent connected accounts (a team mailbox AND a personal one)
 *  without them colliding inside Composio. */
export function composioEntityId(projectId: string, s: ScopeRef): string {
  if (s.scope === "personal") return `user:${s.ownerUserId}:${s.serviceDashboardId}`;
  if (s.scope === "dashboard") return `dashboard:${s.serviceDashboardId}`;
  return projectId; // legacy entity — do NOT change, existing accounts hang off it
}

/** The scope columns to match/write on a connectors row. */
export function scopeFilter(s: ScopeRef): { service_dashboard_id: string | null; owner_user_id: string | null; scope: ConnectorScope } {
  return { service_dashboard_id: s.serviceDashboardId, owner_user_id: s.ownerUserId, scope: s.scope };
}

/** Apply a scope to a PostgREST query (NULL needs `.is`, not `.eq`). */
// deno-lint-ignore no-explicit-any
export function applyScope<T extends { eq: any; is: any }>(q: T, s: ScopeRef): T {
  let out = q;
  out = s.serviceDashboardId ? out.eq("service_dashboard_id", s.serviceDashboardId) : out.is("service_dashboard_id", null);
  out = s.ownerUserId ? out.eq("owner_user_id", s.ownerUserId) : out.is("owner_user_id", null);
  return out;
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
