// internal-agent-approve — human-in-the-loop decision endpoint for autonomous
// agent actions.
//
// Body: { approval_id, decision: "approve" | "reject" }
//
// When an agent calls a tool flagged requires_approval, the worker records the
// intended action in internal_agent_approvals instead of executing it. This
// function lets a team member with agent access decide:
//   - reject  → status 'rejected', nothing runs.
//   - approve → the stored action executes server-side (edge function call or
//     webhook POST) and the outcome lands in result / error_message. The
//     originating run (if any) gets a tool_result event so the timeline shows
//     the late execution.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

interface ApprovalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  tool_name: string;
  action_kind: "edge_function" | "webhook";
  payload: Record<string, unknown>;
  status: string;
}

async function executeAction(a: ApprovalRow): Promise<{ ok: boolean; detail: string }> {
  if (a.action_kind === "edge_function") {
    const slug = String(a.payload.slug ?? "");
    if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, detail: "Invalid function slug" };
    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) return { ok: false, detail: "Function invocation not configured" };
    const res = await fetch(`${base}/functions/v1/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(a.payload.args ?? {}),
    });
    const text = (await res.text()).slice(0, 4000);
    return { ok: res.ok, detail: `HTTP ${res.status}\n${text}` };
  }
  // webhook
  const url = String(a.payload.url ?? "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: "Invalid webhook URL" };
  const method = String(a.payload.method ?? "POST").toUpperCase();
  const headers = (a.payload.headers && typeof a.payload.headers === "object"
    ? a.payload.headers
    : {}) as Record<string, string>;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(a.payload.args ?? {}),
  });
  const text = (await res.text()).slice(0, 4000);
  return { ok: res.ok, detail: `HTTP ${res.status}\n${text}` };
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const { approval_id, decision } = (await req.json()) as {
      approval_id?: string;
      decision?: string;
    };
    if (!approval_id || (decision !== "approve" && decision !== "reject")) {
      return jsonResponse({ error: "approval_id and decision (approve|reject) required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: approval } = await admin
      .from("internal_agent_approvals")
      .select("id, agent_id, run_id, tool_name, action_kind, payload, status")
      .eq("id", approval_id)
      .maybeSingle();
    if (!approval) return jsonResponse({ error: "Approval not found" }, { status: 404 });
    if (approval.status !== "pending") {
      return jsonResponse({ error: `Approval already ${approval.status}` }, { status: 409 });
    }

    // Decision rights: the agent's creator or an editor member.
    const { data: agent } = await admin
      .from("internal_agents")
      .select("created_by")
      .eq("id", approval.agent_id)
      .maybeSingle();
    let canDecide = agent?.created_by === userId;
    if (!canDecide) {
      const { data: member } = await admin
        .from("internal_agent_members")
        .select("role")
        .eq("agent_id", approval.agent_id)
        .eq("user_id", userId)
        .maybeSingle();
      canDecide = member?.role === "editor";
    }
    if (!canDecide) {
      return jsonResponse({ error: "Only the agent's creator or an editor can decide approvals" }, { status: 403 });
    }

    const now = new Date().toISOString();
    if (decision === "reject") {
      await admin
        .from("internal_agent_approvals")
        .update({ status: "rejected", decided_by: userId, decided_at: now })
        .eq("id", approval_id);
      return jsonResponse({ ok: true, status: "rejected" });
    }

    // Approve: mark first (claims the row), then execute.
    await admin
      .from("internal_agent_approvals")
      .update({ status: "approved", decided_by: userId, decided_at: now })
      .eq("id", approval_id);

    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await executeAction(approval as ApprovalRow);
    } catch (e) {
      outcome = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }

    await admin
      .from("internal_agent_approvals")
      .update({
        status: outcome.ok ? "executed" : "failed",
        executed_at: new Date().toISOString(),
        result: { detail: outcome.detail },
        error_message: outcome.ok ? null : outcome.detail.slice(0, 500),
      })
      .eq("id", approval_id);

    // Surface the late execution on the originating run's timeline.
    if (approval.run_id) {
      await admin.from("internal_agent_run_events").insert({
        run_id: approval.run_id,
        agent_id: approval.agent_id,
        kind: "tool_result",
        payload: {
          tool: approval.tool_name,
          ok: outcome.ok,
          approved_by: userId,
          preview: outcome.detail.slice(0, 500),
        },
      });
    }

    return jsonResponse({ ok: outcome.ok, status: outcome.ok ? "executed" : "failed", detail: outcome.detail.slice(0, 1000) });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
