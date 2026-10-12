// Shared execution of a human-approved agent action. Used by
// internal-agent-approve (on a human decision) AND by the agent runtime's inline
// approval helper (to auto-run an action the user already approved earlier in
// the same conversation). Keeping it in one place means the routing rules for
// each action kind never drift between the two call sites.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { runTrackerAction, trackerScope } from "./tracker-actions.ts";

export type ApprovalActionKind =
  | "edge_function" | "webhook" | "connector_action" | "composio_action" | "crm_write"
  | "tracker_write" | "custom_connector";

export interface ApprovalActionInput {
  /** L'approbation elle-même, quand l'appelant passe la ligne entière. */
  id?: string;
  action_kind: ApprovalActionKind;
  payload: Record<string, unknown>;
  workspace_id: string | null;
  project_id: string | null;
}

export async function executeApprovalAction(a: ApprovalActionInput): Promise<{ ok: boolean; detail: string }> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const p = a.payload ?? {};

  if (a.action_kind === "connector_action") {
    if (!base || !key) return { ok: false, detail: "Connector actions not configured" };
    const res = await fetch(`${base}/functions/v1/connector-action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: a.workspace_id, project_id: a.project_id,
        provider: String(p.provider ?? ""), action: String(p.action ?? ""),
        params: (p.params && typeof p.params === "object") ? p.params : {},
      }),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}` };
  }
  if (a.action_kind === "composio_action") {
    if (!base || !key) return { ok: false, detail: "Composio actions not configured" };
    const res = await fetch(`${base}/functions/v1/composio-action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: a.workspace_id, project_id: a.project_id,
        toolkit: String(p.toolkit ?? ""), tool_slug: String(p.tool_slug ?? ""),
        arguments: (p.params && typeof p.params === "object") ? p.params : {},
        // Connection scope captured when the approval was requested (0177) —
        // the action must run through the account the human approved, not
        // through whatever would resolve at execution time.
        ...(p.service_dashboard_id ? { service_dashboard_id: String(p.service_dashboard_id) } : {}),
        ...(p.as_user_id ? { as_user_id: String(p.as_user_id) } : {}),
      }),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}` };
  }
  // Outil interne (0267) : l'appel part avec source « approval », seule porte
  // qu'accepte connector-action pour un geste destructif. Le journal d'accès y
  // relie l'approbation.
  if (a.action_kind === "custom_connector") {
    if (!base || !key) return { ok: false, detail: "Custom connectors not configured" };
    const res = await fetch(`${base}/functions/v1/connector-action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "custom.call", source: "approval",
        connector_id: String(p.connector_id ?? ""), operation: String(p.operation ?? ""),
        params: (p.params && typeof p.params === "object") ? p.params : {},
        raw: (p.raw && typeof p.raw === "object") ? p.raw : undefined,
        credential_id: p.credential_id ?? null,
        allowed_operations: Array.isArray(p.allowed_operations) ? p.allowed_operations : null,
        agent_id: p.agent_id ?? null, run_id: p.run_id ?? null, conversation_id: p.conversation_id ?? null,
        actor_user_id: p.actor_user_id ?? null, approval_id: a.id ?? null,
      }),
    });
    const out = await res.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string };
    return { ok: res.ok && out.ok === true, detail: (out.text ?? out.error ?? `HTTP ${res.status}`).slice(0, 6000) };
  }
  if (a.action_kind === "crm_write") {
    if (!base || !key) return { ok: false, detail: "CRM actions not configured" };
    const res = await fetch(`${base}/functions/v1/crm-action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: a.workspace_id, project_id: a.project_id,
        action: String(p.action ?? ""),
        params: (p.params && typeof p.params === "object") ? p.params : {},
      }),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}` };
  }
  // Le suivi de travail ne passe PAS par une fonction edge : il écrit
  // directement, avec la même implémentation que l'agent utilise en direct.
  // C'est le seul moyen que l'action validée trois heures plus tard fasse
  // exactement ce qui avait été montré au moment de l'approbation.
  if (a.action_kind === "tracker_write") {
    if (!base || !key) return { ok: false, detail: "Tracker actions not configured" };
    const agentId = String(p.agent_id ?? "");
    if (!agentId) return { ok: false, detail: "Missing agent_id in approval payload" };

    const admin = createClient(base, key, { auth: { persistSession: false } });
    const actor = { admin, agentId };
    const allowed = await trackerScope(actor);
    const detail = await runTrackerAction(
      actor,
      String(p.action ?? ""),
      (p.params && typeof p.params === "object") ? p.params as Record<string, unknown> : {},
      allowed,
    );
    // L'implémentation rend une phrase, pas un code : une réponse qui commence
    // par ERREUR est un échec, tout le reste a abouti.
    return { ok: !detail.startsWith("ERREUR"), detail };
  }

  if (a.action_kind === "edge_function") {
    const slug = String(p.slug ?? "");
    if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, detail: "Invalid function slug" };
    if (!base || !key) return { ok: false, detail: "Function invocation not configured" };
    const res = await fetch(`${base}/functions/v1/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(p.args ?? {}),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}` };
  }
  // webhook
  const url = String(p.url ?? "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: "Invalid webhook URL" };
  const method = String(p.method ?? "POST").toUpperCase();
  const headers = (p.headers && typeof p.headers === "object" ? p.headers : {}) as Record<string, string>;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(p.args ?? {}),
  });
  return { ok: res.ok, detail: `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}` };
}

// A stable identity for "this EXACT call" — action AND its arguments. Once the
// user approves one, a later IDENTICAL call in the same conversation auto-runs
// (no re-asking the very same thing). A different action, or the same action
// with different arguments, still needs its own approval (never over-grant a
// write/send the user didn't actually approve).
export function approvalScope(action_kind: string, payload: Record<string, unknown>, toolName: string): string {
  const p = payload ?? {};
  const canon = (o: unknown) => { try { return JSON.stringify(o ?? {}); } catch { return ""; } };
  if (action_kind === "composio_action") return `composio:${p.toolkit ?? ""}:${p.tool_slug ?? ""}:${canon(p.params)}`;
  if (action_kind === "connector_action") return `connector:${p.provider ?? ""}:${p.action ?? ""}:${canon(p.params)}`;
  if (action_kind === "crm_write") return `crm:${p.action ?? ""}:${canon(p.params)}`;
  if (action_kind === "tracker_write") return `tracker:${p.action ?? ""}:${canon(p.params)}`;
  if (action_kind === "edge_function") return `edge:${p.slug ?? ""}:${canon(p.args)}`;
  if (action_kind === "custom_connector") return `custom:${p.connector_id ?? ""}:${p.operation ?? ""}:${canon(p.params)}:${canon(p.raw)}:${p.nonce ?? ""}`;
  return `webhook:${toolName}:${canon(p.args)}`;
}

// The TYPE of an action — its integration/toolkit — used by "approve all of this
// type" so one grant covers every future action of the same toolkit (e.g. all
// Gmail writes) in a conversation.
export function approvalScopePrefix(action_kind: string, payload: Record<string, unknown>, toolName: string): string {
  const p = payload ?? {};
  if (action_kind === "composio_action") return `composio:${p.toolkit ?? ""}`;
  if (action_kind === "connector_action") return `connector:${p.provider ?? ""}`;
  if (action_kind === "crm_write") return `crm`;
  if (action_kind === "edge_function") return `edge:${p.slug ?? ""}`;
  // « Tout autoriser » sur un outil interne ne couvre que l'opération approuvée,
  // jamais tout le connecteur : un rollback n'a pas le poids d'une lecture.
  // Un geste destructif porte un nonce : son approbation ne resservira jamais.
  if (action_kind === "custom_connector") return `custom:${p.connector_id ?? ""}:${p.operation ?? ""}${p.nonce ? `:${p.nonce}` : ""}`;
  return `webhook:${toolName}`;
}

// Human label for a toolkit grant ("Gmail", "slack", "le CRM"…).
export function approvalScopeLabel(action_kind: string, payload: Record<string, unknown>, toolName: string): string {
  const p = payload ?? {};
  if (action_kind === "composio_action") return String(p.toolkit ?? "cet outil");
  if (action_kind === "connector_action") return String(p.provider ?? "cet outil");
  if (action_kind === "crm_write") return "le CRM";
  if (action_kind === "custom_connector") return `${p.connector_name ?? "cet outil"} · ${p.operation ?? ""}`;
  return toolName || "cet outil";
}
