// Shared execution of a human-approved agent action. Used by
// internal-agent-approve (on a human decision) AND by the agent runtime's inline
// approval helper (to auto-run an action the user already approved earlier in
// the same conversation). Keeping it in one place means the routing rules for
// each action kind never drift between the two call sites.

export type ApprovalActionKind =
  | "edge_function" | "webhook" | "connector_action" | "composio_action" | "crm_write";

export interface ApprovalActionInput {
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
      }),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}` };
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
  if (action_kind === "edge_function") return `edge:${p.slug ?? ""}:${canon(p.args)}`;
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
  return `webhook:${toolName}`;
}

// Human label for a toolkit grant ("Gmail", "slack", "le CRM"…).
export function approvalScopeLabel(action_kind: string, payload: Record<string, unknown>, toolName: string): string {
  const p = payload ?? {};
  if (action_kind === "composio_action") return String(p.toolkit ?? "cet outil");
  if (action_kind === "connector_action") return String(p.provider ?? "cet outil");
  if (action_kind === "crm_write") return "le CRM";
  return toolName || "cet outil";
}
