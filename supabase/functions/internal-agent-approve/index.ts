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
import { applyApprovalDecision } from "../_shared/channel-approval.ts";

interface ApprovalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  mission_id: string | null;
  conversation_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  tool_name: string;
  action_kind: "edge_function" | "webhook" | "connector_action" | "composio_action" | "crm_write";
  payload: Record<string, unknown>;
  status: string;
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
    if (!approval_id || (decision !== "approve" && decision !== "approve_all" && decision !== "reject")) {
      return jsonResponse({ error: "approval_id and decision (approve|approve_all|reject) required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: approval } = await admin
      .from("internal_agent_approvals")
      .select("id, agent_id, run_id, mission_id, conversation_id, workspace_id, project_id, tool_name, action_kind, payload, status")
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

    // La décision elle-même est partagée avec les passerelles Slack et Teams
    // (channel-approval.ts) : une demande validée depuis la messagerie doit
    // s'exécuter exactement comme une demande validée ici.
    const outcome = await applyApprovalDecision(
      admin, approval as never, decision as "approve" | "approve_all" | "reject", userId,
    );
    if (outcome.status === "already_decided") {
      return jsonResponse({ error: outcome.detail }, { status: 409 });
    }
    if (decision === "reject") return jsonResponse({ ok: true, status: "rejected" });
    return jsonResponse({ ok: outcome.ok, status: outcome.status, detail: outcome.detail.slice(0, 1000) });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
