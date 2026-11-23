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

/** Ce qu'un run sert : une conversation, une mission, une salle, un workflow, un collègue. */
export type RunKind = "chat" | "mission" | "room" | "workflow" | "a2a";

/**
 * Ce qui a déclenché un run, dans les valeurs que la base accepte (0268 :
 * manual, schedule, api, chat, event). Une salle, un workflow ou un collègue
 * sont des événements du système.
 */
export function triggeredVia(via: string | null | undefined): "manual" | "schedule" | "api" | "chat" | "event" {
  const v = String(via ?? "").toLowerCase();
  if (v === "chat" || v === "schedule" || v === "api" || v === "event" || v === "manual") return v;
  if (v === "scheduler" || v === "cron") return "schedule";
  if (v === "workflow" || v === "room" || v === "a2a" || v === "mission" || v === "trigger") return "event";
  return "manual";
}

export interface BoundRun {
  runId: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  projectId: string;
  conversationId: string | null;
  /** La personne qui pilote ce tour (auteur du message), pour les outils qui agissent en son nom. */
  actingUserId?: string | null;
  /** Ce que sert le run ; chat par défaut. */
  kind?: RunKind;
  /** L'état métier du run (internal_agent_runs.run_meta, 0313). */
  meta?: Record<string, unknown>;
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
  /** L'agent ; null s'il n'existe pas. */
  agent(agentId: string): Promise<HarnessAgent | null>;
  hasAgentAccess(agentId: string, userId: string): Promise<boolean>;
  /** La conversation de cet agent, ou null. */
  conversation(conversationId: string, agentId: string): Promise<{ sessionId: string | null } | null>;
  setConversationSession(conversationId: string, sessionId: string): Promise<void>;
  /** Les derniers messages de la conversation, du plus ancien au plus récent. */
  recentMessages(conversationId: string, limit: number): Promise<Array<{ role: string; content: string }>>;
  /** Le run OpenCode encore en cours sur cette conversation. */
  activeRun(conversationId: string): Promise<{ runId: string; sessionId: string } | null>;
  /** Le run de cette conversation qui attend la réponse à une question de l'agent (formulaire OpenCode). */
  pendingQuestion?(conversationId: string): Promise<{
    runId: string; sessionId: string; formId: string;
    fields: Array<{ key: string; options?: string[]; multiple?: boolean }>;
  } | null>;
  /** Crée le run, ou reprend celui que l'appelant a déjà créé (runId : mission en file, salle, workflow). */
  createRun(input: {
    agent: HarnessAgent; conversationId: string | null; sessionId: string; via: string;
    runId?: string | null; meta?: Record<string, unknown>;
  }): Promise<string>;
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
        .select("id, name, workspace_id, project_id").eq("id", agentId).maybeSingle();
      if (error || !data) return null;
      return { ...(data as Omit<HarnessAgent, "harness">), harness: "opencode" };
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
    async pendingQuestion(conversationId) {
      const { data } = await admin.from("internal_agent_runs")
        .select("id, opencode_session_id, pending_question").eq("conversation_id", conversationId).eq("status", "awaiting_input")
        .not("opencode_session_id", "is", null).order("started_at", { ascending: false }).limit(1).maybeSingle();
      const r = data as { id: string; opencode_session_id: string; pending_question?: { form_id?: string; fields?: unknown } | null } | null;
      const formId = r?.pending_question?.form_id;
      if (!r || !formId) return null;
      const fields = Array.isArray(r.pending_question?.fields) ? r.pending_question!.fields as Array<{ key: string; options?: string[]; multiple?: boolean }> : [];
      return { runId: r.id, sessionId: r.opencode_session_id, formId, fields };
    },
    async createRun({ agent, conversationId, sessionId, via, runId, meta }) {
      if (runId) {
        const { data: prior } = await admin.from("internal_agent_runs").select("started_at").eq("id", runId).maybeSingle();
        const { error } = await admin.from("internal_agent_runs").update({
          status: "running", opencode_session_id: sessionId,
          ...((prior as { started_at?: string | null } | null)?.started_at ? {} : { started_at: new Date().toISOString() }),
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(meta ? { run_meta: meta } : {}),
        }).eq("id", runId);
        if (error) throw new Error(`run non repris : ${error.message}`);
        return runId;
      }
      const { data, error } = await admin.from("internal_agent_runs").insert({
        agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
        conversation_id: conversationId, status: "running", started_at: new Date().toISOString(),
        triggered_via: triggeredVia(via), opencode_session_id: sessionId, ...(meta ? { run_meta: meta } : {}),
      }).select("id").single();
      if (error || !data) throw new Error(`run non créé : ${error?.message ?? "aucune ligne"}`);
      return (data as { id: string }).id;
    },
    async runningRuns() {
      const { data } = await admin.from("internal_agent_runs")
        .select("id, opencode_session_id, agent_id, workspace_id, project_id, conversation_id, run_meta")
        .eq("status", "running").not("opencode_session_id", "is", null).limit(500);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
        const meta = (r.run_meta ?? {}) as Record<string, unknown>;
        return {
          runId: String(r.id), sessionId: String(r.opencode_session_id), agentId: String(r.agent_id),
          workspaceId: String(r.workspace_id), projectId: String(r.project_id),
          conversationId: (r.conversation_id as string | null) ?? null,
          kind: (meta.kind as RunKind | undefined) ?? "chat", meta,
        };
      });
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
