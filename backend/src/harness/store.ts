// Ce que le harnais lit et écrit dans la base FounderOS.
//
// Postgres reste la source de vérité métier : runs, timeline, messages et
// consommation y sont écrits dans les MÊMES tables que l'ancien moteur, pour
// que le front n'ait rien à changer. OpenCode, lui, ne garde que son état
// d'exécution (sa base SQLite).
//
// Une interface plutôt que des appels Supabase dispersés : les tests du
// harnais tournent sur un magasin en mémoire, sans base.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface HarnessAgent {
  id: string;
  name: string;
  workspace_id: string;
  project_id: string;
  harness: "legacy" | "opencode";
}

export interface BoundRun {
  runId: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  projectId: string;
  conversationId: string | null;
}

export interface UsageRow {
  workspaceId: string;
  projectId: string;
  runId: string;
  agentId: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  source: "step" | "title" | "compaction" | "generate";
}

export interface HarnessStore {
  /** L'agent et son moteur ; null s'il n'existe pas ou que la colonne manque (0307 non jouée). */
  agent(agentId: string): Promise<HarnessAgent | null>;
  hasAgentAccess(agentId: string, userId: string): Promise<boolean>;
  /** La conversation de cet agent, ou null. */
  conversation(conversationId: string, agentId: string): Promise<{ sessionId: string | null } | null>;
  setConversationSession(conversationId: string, sessionId: string): Promise<void>;
  /** Les derniers messages de la conversation, du plus ancien au plus récent. */
  recentMessages(conversationId: string, limit: number): Promise<Array<{ role: string; content: string }>>;
  /** Le run OpenCode encore en cours sur cette conversation. */
  activeRun(conversationId: string): Promise<{ runId: string; sessionId: string } | null>;
  createRun(input: { agent: HarnessAgent; conversationId: string | null; sessionId: string; via: string }): Promise<string>;
  /** Les runs OpenCode en cours (pour les réattacher au redémarrage). */
  runningRuns(): Promise<BoundRun[]>;
  /** Parmi ces runs, ceux que quelqu'un a annulés. */
  cancelledAmong(runIds: string[]): Promise<string[]>;
  insertEvent(runId: string, agentId: string, kind: string, payload: Record<string, unknown>): Promise<void>;
  updateRun(runId: string, patch: Record<string, unknown>): Promise<void>;
  insertAssistantMessage(row: { conversationId: string; agentId: string; runId: string; content: string; tokensIn: number; tokensOut: number; costUsd: number }): Promise<void>;
  touchConversation(conversationId: string): Promise<void>;
  logUsage(row: UsageRow): Promise<void>;
}

/** Le magasin réel : le client de service Supabase (en mode local, ce backend lui-même). */
export function supabaseStore(
  admin: SupabaseClient,
  logUsage: (row: UsageRow) => Promise<void>,
): HarnessStore {
  return {
    async agent(agentId) {
      const { data, error } = await admin.from("internal_agents")
        .select("id, name, workspace_id, project_id, harness").eq("id", agentId).maybeSingle();
      if (error || !data) return null;
      const a = data as HarnessAgent;
      return { ...a, harness: a.harness === "opencode" ? "opencode" : "legacy" };
    },
    async hasAgentAccess(agentId, userId) {
      const { data } = await admin.rpc("has_internal_agent_access", { p_agent_id: agentId, p_user_id: userId });
      return data === true;
    },
    async conversation(conversationId, agentId) {
      const { data } = await admin.from("internal_agent_conversations")
        .select("id, opencode_session_id").eq("id", conversationId).eq("agent_id", agentId).maybeSingle();
      if (!data) return null;
      return { sessionId: (data as { opencode_session_id?: string | null }).opencode_session_id ?? null };
    },
    async setConversationSession(conversationId, sessionId) {
      await admin.from("internal_agent_conversations").update({ opencode_session_id: sessionId }).eq("id", conversationId);
    },
    async recentMessages(conversationId, limit) {
      const { data } = await admin.from("internal_agent_messages")
        .select("role, content, created_at").eq("conversation_id", conversationId)
        .order("created_at", { ascending: false }).limit(limit);
      return ((data ?? []) as Array<{ role: string; content: string | null }>)
        .reverse().map((m) => ({ role: m.role, content: String(m.content ?? "") }));
    },
    async activeRun(conversationId) {
      const { data } = await admin.from("internal_agent_runs")
        .select("id, opencode_session_id").eq("conversation_id", conversationId).eq("status", "running")
        .not("opencode_session_id", "is", null).order("started_at", { ascending: false }).limit(1).maybeSingle();
      const r = data as { id: string; opencode_session_id: string } | null;
      return r ? { runId: r.id, sessionId: r.opencode_session_id } : null;
    },
    async createRun({ agent, conversationId, sessionId, via }) {
      const { data, error } = await admin.from("internal_agent_runs").insert({
        agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
        conversation_id: conversationId, status: "running", started_at: new Date().toISOString(),
        triggered_via: via, opencode_session_id: sessionId,
      }).select("id").single();
      if (error || !data) throw new Error(`run non créé : ${error?.message ?? "aucune ligne"}`);
      return (data as { id: string }).id;
    },
    async runningRuns() {
      const { data } = await admin.from("internal_agent_runs")
        .select("id, opencode_session_id, agent_id, workspace_id, project_id, conversation_id")
        .eq("status", "running").not("opencode_session_id", "is", null).limit(500);
      return ((data ?? []) as Array<Record<string, string | null>>).map((r) => ({
        runId: r.id!, sessionId: r.opencode_session_id!, agentId: r.agent_id!,
        workspaceId: r.workspace_id!, projectId: r.project_id!, conversationId: r.conversation_id ?? null,
      }));
    },
    async cancelledAmong(runIds) {
      if (!runIds.length) return [];
      const { data } = await admin.from("internal_agent_runs").select("id").in("id", runIds).eq("status", "cancelled");
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    },
    async insertEvent(runId, agentId, kind, payload) {
      await admin.from("internal_agent_run_events").insert({ run_id: runId, agent_id: agentId, kind, payload });
    },
    async updateRun(runId, patch) {
      await admin.from("internal_agent_runs").update(patch).eq("id", runId);
    },
    async insertAssistantMessage(row) {
      await admin.from("internal_agent_messages").insert({
        conversation_id: row.conversationId, agent_id: row.agentId, role: "assistant", content: row.content,
        run_id: row.runId, tokens_in: row.tokensIn, tokens_out: row.tokensOut, cost_usd: row.costUsd,
      });
    },
    async touchConversation(conversationId) {
      await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    },
    logUsage,
  };
}
