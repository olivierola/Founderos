// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/mcp-observe.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Audit et métriques des appels MCP, côté FounderOS (installation dédiée,
// docs/openshift-implementation.md D7).
//
// Chaque appel de tool donne un événement : qui (personne, agent), quoi (serveur,
// cluster, tool), l'issue, la durée, et le `trace_id` du run. C'est le même que
// celui du `traceparent` envoyé au serveur MCP : dans Loki, l'événement de
// FounderOS et celui du serveur se retrouvent par ce seul champ.
//
// Le backend Node installe l'observateur (backend/src/shared/metrics.ts : ligne
// JSON sur stdout + métriques Prometheus). Sous Deno, il n'y en a pas : rien
// n'est émis, et l'instance SaaS n'en paie rien.

import { decodeJwtPayload, subjectOfClaims } from "./idp-tokens.ts";
import { traceparentFor } from "./mcp-auth.ts";

export type McpCallStatus = "ok" | "error" | "denied" | "approval_required" | "invalid";

export interface McpCallEvent {
  trace_id: string;
  session_id: string | null;
  /** Utilisateur FounderOS pour qui l'agent agit ; null : exécution planifiée. */
  user: string | null;
  /** `sub` Keycloak du jeton d'appel, celui que voit le serveur MCP. */
  user_sub: string | null;
  agent: string | null;
  /** Client Keycloak de l'agent (`azp` du jeton d'appel). */
  agent_client: string | null;
  workspace_id: string | null;
  mcp_server: string;
  cluster: string | null;
  tool: string;
  status: McpCallStatus;
  /** Motif d'un refus ou d'une erreur (scope_missing, invalid_approval…). */
  reason: string | null;
  /** Décision de FounderOS avant l'appel (pré-décision OPA), s'il y en a eu une. */
  policy_decision: string | null;
  approval_id: string | null;
  duration_ms: number;
}

export type ApprovalStatus = "requested" | "rejected" | "expired" | "executed" | "failed";

export interface ApprovalEvent {
  approval_id: string;
  status: ApprovalStatus;
  tool: string;
  target_cluster: string | null;
  requester: string | null;
  approver: string | null;
}

interface Observer {
  toolCall(e: McpCallEvent): void;
  approval(e: ApprovalEvent): void;
}

const observer = (): Observer | undefined => (globalThis as { __mcpObserver?: Observer }).__mcpObserver;

/** Au mieux : un observateur en panne ne doit jamais faire échouer un appel. */
export function reportToolCall(e: McpCallEvent): void {
  try { observer()?.toolCall(e); } catch { /* au mieux */ }
}

export function reportApproval(e: ApprovalEvent): void {
  try { observer()?.approval(e); } catch { /* au mieux */ }
}

/** Le trace id du run : celui du traceparent envoyé au serveur MCP. */
export function traceIdFor(runId: string | null | undefined): string {
  return traceparentFor(runId).split("-")[1];
}

/** Ce que disent du demandeur les en-têtes d'appel (jeton d'échange), s'il y en a. */
export function callIdentity(headers: Record<string, string>): { user_sub: string | null; agent_client: string | null } {
  const auth = headers.Authorization ?? headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return { user_sub: null, agent_client: null };
  // Jeton d'API (0278) : pas un JWT. Le demandeur est celui que le serveur MCP
  // verra (la personne affirmée, sinon le jeton) ; le client est le jeton, que
  // le journal du serveur porte aussi (token_id).
  const apiToken = /^mcpt_([a-z0-9]{8})_/.exec(auth.slice("Bearer ".length));
  if (apiToken) {
    const user = headers["X-FounderOS-User"] ?? null;
    return { user_sub: user ?? `token:${apiToken[1]}`, agent_client: `token:${apiToken[1]}` };
  }
  try {
    const p = decodeJwtPayload(auth.slice("Bearer ".length));
    return {
      user_sub: subjectOfClaims(p) || null,
      agent_client: typeof p.azp === "string" ? p.azp : typeof p.appid === "string" ? p.appid : null,
    };
  } catch {
    return { user_sub: null, agent_client: null };
  }
}

/** L'issue d'un appel, lue dans le texte rendu par le client MCP. */
export function classifyMcpResult(text: string): { status: McpCallStatus; reason: string | null } {
  if (!text.startsWith("ERROR:")) return { status: "ok", reason: null };
  const body = text.slice("ERROR:".length).trim();
  if (body.startsWith("{")) {
    try {
      const j = JSON.parse(body) as { error?: string; reason?: string };
      if (j.error === "approval_required") return { status: "approval_required", reason: null };
      if (j.error === "denied") return { status: "denied", reason: j.reason ?? null };
      if (j.error === "invalid_params") return { status: "invalid", reason: "invalid_params" };
      return { status: "error", reason: j.error ?? null };
    } catch { /* texte libre */ }
  }
  return { status: "error", reason: body.slice(0, 120) || null };
}
