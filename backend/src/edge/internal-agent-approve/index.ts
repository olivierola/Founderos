// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/internal-agent-approve/index.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { defineHandler } from "../../compat/index.ts";

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
import { applyApprovalDecision, resumeAfterLateDecision } from "../_shared/channel-approval.ts";
import { founderosIdentity, gateMcpDecision, liveIdpIdentity, signApprovalToken, type McpApprovalRow } from "../_shared/mcp-approval.ts";
import { reportApproval } from "../_shared/mcp-observe.ts";
import { describeApprovers, gateApprovalVote, type PolicyApprovalRow } from "../_shared/approval-policy.ts";

interface ApprovalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  mission_id: string | null;
  conversation_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  tool_name: string;
  action_kind: "edge_function" | "webhook" | "connector_action" | "composio_action" | "crm_write" | "custom_connector" | "mcp_tool";
  payload: Record<string, unknown>;
  status: string;
}

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Une demande soumise à une règle d'approbation (G3, 0281) : chaque
 * approbateur vote ; l'action part quand le quorum est atteint. Un approbateur
 * qui refuse la rejette (veto) ; le demandeur peut la retirer.
 * Serveur MCP : le jeton d'approbation porte tous les approbateurs, et le
 * serveur refait ses contrôles (aucun n'est le demandeur, son propre quorum).
 */
async function decidePolicyApproval(
  admin: Admin,
  approval: PolicyApprovalRow & ApprovalRow,
  userId: string,
  decision: "approve" | "approve_all" | "reject",
  source: string | undefined,
): Promise<Response> {
  const isMcp = approval.action_kind === "mcp_tool";
  const p = approval.payload as Record<string, string>;
  const gate = await gateApprovalVote(approval, {
    userId,
    decision,
    // MCP par échange de jeton : l'IdP atteste la personne, donc l'IdP identifie
    // l'approbateur. Sinon (contexte signé, jeton d'API, outil interne) : FounderOS.
    identity: () => isMcp && !["signed_context", "api_token"].includes(String(p.identity_mode ?? "token_exchange"))
      ? liveIdpIdentity(admin, userId, undefined, p.provider ?? null)
      : founderosIdentity(admin, userId),
    workspaceRole: async () => {
      if (!approval.workspace_id) return null;
      const { data } = await admin.from("workspace_members").select("role")
        .eq("workspace_id", approval.workspace_id).eq("user_id", userId).maybeSingle();
      return (data as { role?: string } | null)?.role ?? null;
    },
    alreadyVoted: async () => {
      const { data } = await admin.from("internal_agent_approval_votes").select("user_id")
        .eq("approval_id", approval.id).eq("user_id", userId).maybeSingle();
      return !!data;
    },
    lastSsoLoginAt: async () => {
      if (!approval.workspace_id) return null;
      const { data } = await admin.from("enterprise_sso_logins").select("created_at")
        .eq("workspace_id", approval.workspace_id).eq("user_id", userId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      return (data as { created_at?: string } | null)?.created_at ?? null;
    },
  });
  const event = (status: "rejected" | "expired" | "executed" | "failed", approver: string | null) => {
    if (isMcp) {
      reportApproval({
        approval_id: approval.id, status, tool: p.tool, target_cluster: p.target_cluster ?? null,
        requester: p.requester_sub ?? null, approver,
      });
    }
  };
  if (!gate.ok) {
    if (gate.expired) {
      await admin.from("internal_agent_approvals")
        .update({ status: "expired", result: { expired_at: new Date().toISOString() } })
        .eq("id", approval.id).eq("status", "pending");
      event("expired", null);
    }
    return jsonResponse({ error: gate.error }, { status: gate.status });
  }
  const where = source === "prd" || source === "approvals" ? "dans « Approbations »" : "dans l'application";

  if (decision === "reject") {
    const outcome = await applyApprovalDecision(admin, approval as never, "reject", userId);
    event("rejected", gate.approver?.sub ?? null);
    await resumeAfterLateDecision(admin, approval as never, "reject", outcome, where);
    return jsonResponse({ ok: true, status: "rejected" });
  }

  // La voix. La base refait les contrôles (quatre yeux, échéance, une voix par personne).
  const { error: voteErr } = await admin.from("internal_agent_approval_votes")
    .insert({ approval_id: approval.id, user_id: userId, idp_sub: gate.approver!.sub });
  if (voteErr) return jsonResponse({ error: `Vote refusé : ${voteErr.message}` }, { status: 409 });
  const { data: votes } = await admin.from("internal_agent_approval_votes")
    .select("user_id, idp_sub, created_at").eq("approval_id", approval.id).order("created_at");
  // Seules comptent les voix de membres actuels de l'organisation : un approbateur
  // parti entre-temps ne fait plus le quorum (comme la base, 0284).
  const { data: members } = await admin.from("workspace_members").select("user_id").eq("workspace_id", approval.workspace_id ?? "");
  const current = new Set(((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
  const voters = ((votes ?? []) as Array<{ user_id: string; idp_sub: string }>).filter((v) => current.has(v.user_id));
  if (voters.length < approval.quorum) {
    const left = approval.quorum - voters.length;
    return jsonResponse({
      ok: true, status: "pending", votes: voters.length, quorum: approval.quorum,
      detail: `Approbation enregistrée (${voters.length}/${approval.quorum}). Il manque ${left} approbateur${left > 1 ? "s" : ""} : ${describeApprovers({ rule: approval.approver_rule, quorum: left })}.`,
    });
  }

  // Quorum atteint : signer (MCP), puis réclamer la demande et exécuter.
  let exec: { approvalToken?: string; trace?: Record<string, unknown> } = {
    trace: { approvers: voters.map((v) => ({ user: v.user_id, sub: v.idp_sub })), quorum: approval.quorum, policy: approval.policy_name ?? null },
  };
  if (isMcp) {
    const signed = await signApprovalToken({
      audience: p.audience, requesterSub: p.requester_sub, approverSub: gate.approver!.sub,
      approvers: voters.map((v) => v.idp_sub),
      approvalId: approval.id, tool: p.tool, targetCluster: p.target_cluster, paramsHash: p.params_hash,
    });
    exec = {
      approvalToken: signed.token,
      trace: {
        ...exec.trace,
        requester_user: approval.requested_by, requester_sub: p.requester_sub,
        approver_user: userId, approver_sub: gate.approver!.sub,
        token_jti: signed.jti, token_kid: signed.kid,
        token_issued_at: new Date(signed.iat * 1000).toISOString(),
        token_expires_at: new Date(signed.exp * 1000).toISOString(),
      },
    };
  }
  const outcome = await applyApprovalDecision(admin, approval as never, "approve", userId, undefined, exec);
  if (outcome.status === "already_decided") {
    // Deux approbateurs ont atteint le quorum en même temps : l'autre a lancé l'action.
    return jsonResponse({ ok: true, status: "approved", detail: "Quorum atteint : l'action a été lancée par l'autre approbation." });
  }
  if (outcome.status === "refused") return jsonResponse({ error: outcome.detail }, { status: 403 });
  event(outcome.ok ? "executed" : "failed", voters.map((v) => v.idp_sub).join(","));
  await resumeAfterLateDecision(admin, approval as never, "approve", outcome, where);
  return jsonResponse({ ok: outcome.ok, status: outcome.status, votes: voters.length, quorum: approval.quorum, detail: outcome.detail.slice(0, 1000) });
}

async function decideMcpApproval(
  admin: Admin,
  approval: McpApprovalRow & ApprovalRow,
  userId: string,
  decision: "approve" | "approve_all" | "reject",
  source: string | undefined,
): Promise<Response> {
  const gate = await gateMcpDecision(approval, {
    userId,
    decision,
    // La même source que celle qui a attesté le demandeur : l'IdP (échange de
    // jeton), ou FounderOS (contexte signé).
    // Contexte signé et jeton d'API : FounderOS atteste la personne, donc FounderOS l'identifie.
    identity: () => ["signed_context", "api_token"].includes(String((approval.payload as { identity_mode?: string }).identity_mode))
      ? founderosIdentity(admin, userId)
      : liveIdpIdentity(admin, userId, undefined, (approval.payload as { provider?: string }).provider ?? null),
    isWorkspaceMember: async () => {
      if (!approval.workspace_id) return false;
      const { data } = await admin.from("workspace_members").select("user_id")
        .eq("workspace_id", approval.workspace_id).eq("user_id", userId).maybeSingle();
      return !!data;
    },
  });
  const p0 = approval.payload as Record<string, string>;
  const event = (status: "rejected" | "expired" | "executed" | "failed", approver: string | null) => reportApproval({
    approval_id: approval.id, status, tool: p0.tool, target_cluster: p0.target_cluster ?? null,
    requester: p0.requester_sub ?? null, approver,
  });
  if (!gate.ok) {
    if (gate.expired) {
      await admin.from("internal_agent_approvals")
        .update({ status: "expired", result: { expired_at: new Date().toISOString() } })
        .eq("id", approval.id).eq("status", "pending");
      event("expired", null);
    }
    return jsonResponse({ error: gate.error }, { status: gate.status });
  }

  let exec: { approvalToken?: string; trace?: Record<string, unknown> } | undefined;
  if (decision === "approve" && gate.approver) {
    const p = approval.payload as Record<string, string>;
    // Signé avant d'être réclamé : si la signature échoue (clé absente), la
    // demande reste en attente au lieu de passer « approuvée » sans effet.
    const signed = await signApprovalToken({
      audience: p.audience, requesterSub: p.requester_sub, approverSub: gate.approver.sub,
      approvalId: approval.id, tool: p.tool, targetCluster: p.target_cluster, paramsHash: p.params_hash,
    });
    exec = {
      approvalToken: signed.token,
      trace: {
        requester_user: approval.requested_by, requester_sub: p.requester_sub,
        approver_user: userId, approver_sub: gate.approver.sub,
        token_jti: signed.jti, token_kid: signed.kid,
        token_issued_at: new Date(signed.iat * 1000).toISOString(),
        token_expires_at: new Date(signed.exp * 1000).toISOString(),
      },
    };
  }

  const outcome = await applyApprovalDecision(admin, approval as never, decision, userId, undefined, exec);
  if (outcome.status === "already_decided" || outcome.status === "refused") {
    return jsonResponse({ error: outcome.detail }, { status: outcome.status === "refused" ? 403 : 409 });
  }
  event(decision === "reject" ? "rejected" : outcome.ok ? "executed" : "failed", gate.approver?.sub ?? null);
  await resumeAfterLateDecision(
    admin, approval as never, decision, outcome,
    source === "prd" ? "dans « Approbations PRD »" : "dans l'application",
  );
  if (decision === "reject") return jsonResponse({ ok: true, status: "rejected" });
  return jsonResponse({ ok: outcome.ok, status: outcome.status, detail: outcome.detail.slice(0, 1000) });
}

export default defineHandler(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const { approval_id, decision, source } = (await req.json()) as {
      approval_id?: string;
      decision?: string;
      /** Where the click happened, told to the collaborator when it resumes. */
      source?: string;
    };
    if (!approval_id || (decision !== "approve" && decision !== "approve_all" && decision !== "reject")) {
      return jsonResponse({ error: "approval_id and decision (approve|approve_all|reject) required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: approval } = await admin
      .from("internal_agent_approvals")
      .select("id, agent_id, run_id, mission_id, conversation_id, workspace_id, project_id, tool_name, action_kind, payload, status, requested_by, expires_at, quorum, approver_rule, policy_name, environment")
      .eq("id", approval_id)
      .maybeSingle();
    if (!approval) return jsonResponse({ error: "Approval not found" }, { status: 404 });
    if (approval.status !== "pending") {
      return jsonResponse({ error: `Approval already ${approval.status}` }, { status: 409 });
    }

    // Demande soumise à une règle d'approbation (G3) : ses approbateurs votent,
    // jamais la personne au nom de qui l'agent agissait.
    if (approval.quorum != null) {
      return await decidePolicyApproval(admin, approval as PolicyApprovalRow & ApprovalRow, userId, decision, source);
    }

    // Action en production d'avant G3 (D6) : d'autres règles que celles d'un
    // agent. Ce n'est pas son créateur qui tranche, mais un approbateur.
    if (approval.action_kind === "mcp_tool") {
      return await decideMcpApproval(admin, approval as McpApprovalRow & ApprovalRow, userId, decision, source);
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
    // A decision taken after the collaborator stopped waiting (the inbox is
    // usually minutes or hours later) would otherwise land in the void.
    await resumeAfterLateDecision(
      admin, approval as never, decision as "approve" | "approve_all" | "reject", outcome,
      source === "inbox" ? "dans la boîte « À valider »" : "dans l'application",
    );
    if (decision === "reject") return jsonResponse({ ok: true, status: "rejected" });
    return jsonResponse({ ok: outcome.ok, status: outcome.status, detail: outcome.detail.slice(0, 1000) });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
